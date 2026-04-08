const axios = require("axios");

let accessToken = null;
let tokenExpiry = 0;

async function getToken() {
  if (accessToken && Date.now() < tokenExpiry) return accessToken;
  if (!process.env.REDDIT_CLIENT_ID || process.env.REDDIT_CLIENT_ID === "your_client_id_here") return null;
  const resp = await axios.post("https://www.reddit.com/api/v1/access_token", "grant_type=client_credentials", {
    auth: { username: process.env.REDDIT_CLIENT_ID, password: process.env.REDDIT_CLIENT_SECRET },
    headers: { "User-Agent": process.env.REDDIT_USER_AGENT || "SubTracker/1.0", "Content-Type": "application/x-www-form-urlencoded" },
  });
  accessToken = resp.data.access_token;
  tokenExpiry = Date.now() + (resp.data.expires_in - 60) * 1000;
  console.log("[reddit] OAuth token acquired");
  return accessToken;
}

async function redditGet(path, params = {}) {
  const token = await getToken();
  const baseUrl = token ? "https://oauth.reddit.com" : "https://www.reddit.com";
  const headers = { "User-Agent": process.env.REDDIT_USER_AGENT || "SubTracker/1.0" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const resp = await axios.get(`${baseUrl}${path}.json`, { params, headers });
  return resp.data;
}

// ── Age helpers ───────────────────────────────────────────────────────────────
// Unmoderated: subs created between Jan 2015 and 9 months ago
const UNMOD_MIN_UTC = 1420070400; // Jan 1, 2015
function getUnmodMaxUtc() {
  return Math.floor(Date.now() / 1000) - 9 * 30 * 24 * 3600; // 9 months ago
}

// ── SFW model-posting subs ────────────────────────────────────────────────────
// These are subs where models (fitness, beauty, photography, candid) can post

const SFW_MODEL_QUERIES = [
  "fitness girls", "gym selfie", "workout women", "yoga girls",
  "portrait photography", "modeling", "photoshoot", "body positive",
  "beauty makeup", "fashion style", "dance performance", "candid photography",
  "cosplay", "cheerleading", "gymnastics women",
];

async function fetchTrending(limit = 100) {
  const seen = new Set();
  const results = [];
  // Run 4 queries in parallel, pick from combined
  const queries = SFW_MODEL_QUERIES.slice(0, 4);
  const fetches = await Promise.allSettled(
    queries.map(q => redditGet("/subreddits/search", { q, sort: "relevance", limit: 50 }))
  );
  for (const f of fetches) {
    if (f.status !== "fulfilled") continue;
    for (const c of f.value.data.children) {
      const d = c.data;
      if (!d.display_name || seen.has(d.display_name.toLowerCase())) continue;
      seen.add(d.display_name.toLowerCase());
      if (d.over18 || d.subscribers < 5000) continue;
      results.push(d);
    }
  }
  // Also pull popular subs with big subscriber counts for general context
  try {
    const pop = await redditGet("/subreddits/popular", { limit: 100 });
    for (const c of pop.data.children) {
      const d = c.data;
      if (!d.display_name || seen.has(d.display_name.toLowerCase())) continue;
      seen.add(d.display_name.toLowerCase());
      if (!d.over18 && d.subscribers >= 50000) results.push(d);
    }
  } catch {}
  return results.slice(0, limit);
}

async function fetchRising(limit = 100) {
  const seen = new Set();
  const results = [];
  const queries = SFW_MODEL_QUERIES.slice(4, 8);
  const fetches = await Promise.allSettled(
    queries.map(q => redditGet("/subreddits/search", { q, sort: "activity", limit: 50 }))
  );
  for (const f of fetches) {
    if (f.status !== "fulfilled") continue;
    for (const c of f.value.data.children) {
      const d = c.data;
      if (!d.display_name || seen.has(d.display_name.toLowerCase())) continue;
      seen.add(d.display_name.toLowerCase());
      if (d.over18 || d.subscribers < 1000 || d.subscribers > 2000000) continue;
      results.push(d);
    }
  }
  // Supplement with /r/all rising
  try {
    const rising = await redditGet("/r/all/rising", { limit: 100 });
    for (const c of rising.data.children) {
      const p = c.data;
      if (!p.subreddit || seen.has(p.subreddit.toLowerCase())) continue;
      seen.add(p.subreddit.toLowerCase());
      const subs = p.subreddit_subscribers || 0;
      if (!p.over_18 && subs >= 5000 && subs <= 2000000) {
        results.push({ display_name: p.subreddit, subscribers: subs, public_description: "", active_user_count: 0, over18: false, created_utc: 0, title: p.subreddit });
      }
    }
  } catch {}
  return results.slice(0, limit);
}

async function fetchNew(limit = 100) {
  const seen = new Set();
  const results = [];
  const queries = SFW_MODEL_QUERIES.slice(8, 12);
  const fetches = await Promise.allSettled(
    queries.map(q => redditGet("/subreddits/search", { q, sort: "new", limit: 50 }))
  );
  for (const f of fetches) {
    if (f.status !== "fulfilled") continue;
    for (const c of f.value.data.children) {
      const d = c.data;
      if (!d.display_name || seen.has(d.display_name.toLowerCase())) continue;
      seen.add(d.display_name.toLowerCase());
      if (d.over18 || d.subscribers < 500 || d.subscribers > 500000) continue;
      results.push(d);
    }
  }
  return results.slice(0, limit);
}

// ── Unmoderated: age-filtered, no restrict_posting ────────────────────────────
// Subs created between Jan 2015 and 9 months ago — established but low-mod
async function fetchUnmoderated(targetCount = 100, excludeSubs = new Set()) {
  const results = [];
  const seen = new Set(excludeSubs);
  const maxUtc = getUnmodMaxUtc();

  // Parallel: fetch 3 pages at once then filter, much faster than sequential
  const PAGES_PER_BATCH = 3;
  let after = null;
  let batches = 0;
  const MAX_BATCHES = 5; // 5 batches × 3 pages = 15 pages max (was 20 sequential)

  while (results.length < targetCount && batches < MAX_BATCHES) {
    batches++;
    const pageParams = [];
    for (let i = 0; i < PAGES_PER_BATCH; i++) {
      const p = { limit: 100, sort: "new" };
      if (after) p.after = after;
      pageParams.push(p);
    }

    // Fetch 3 pages in parallel
    const pages = await Promise.allSettled(
      pageParams.map(p => redditGet("/subreddits/new", p))
    );

    let gotNewAfter = false;
    for (const page of pages) {
      if (page.status !== "fulfilled") continue;
      const children = page.value?.data?.children || [];
      if (!children.length) break;

      for (const child of children) {
        const sub = child.data;
        const name = sub.display_name?.toLowerCase();
        if (!name || seen.has(name)) continue;
        seen.add(name);

        const subs = sub.subscribers || 0;
        if (subs < 20 || subs > 2500) continue;
        if (sub.over18) continue;
        if (sub.subreddit_type !== "public") continue;
        if (sub.restrict_posting === true) continue;       // skip approval-required
        if (sub.submission_type === "restricted") continue; // skip restricted
        // Age filter: must be between Jan 2015 and 9 months ago
        const created = sub.created_utc || 0;
        if (created < UNMOD_MIN_UTC || created > maxUtc) continue;

        results.push(sub);
        if (results.length >= targetCount) break;
      }

      const newAfter = page.value?.data?.after;
      if (newAfter && !gotNewAfter) {
        after = newAfter;
        gotNewAfter = true;
      }
    }
    if (!gotNewAfter) break;
  }

  return results;
}

// ── NSFW ─────────────────────────────────────────────────────────────────────
const NSFW_MODEL_QUERIES = [
  "gonewild", "realgirls", "amateur nsfw", "onlyfans",
  "latina nsfw", "asian nsfw", "ebony nsfw", "curvy nsfw",
  "fitnessgirls nsfw", "petite nsfw", "milf nsfw", "boobs",
];

async function fetchNsfwTrending(limit = 100) {
  const seen = new Set();
  const results = [];
  const queries = NSFW_MODEL_QUERIES.slice(0, 4);
  const fetches = await Promise.allSettled(
    queries.map(q => redditGet("/subreddits/search", { q, sort: "relevance", limit: 50, include_over_18: "on" }))
  );
  for (const f of fetches) {
    if (f.status !== "fulfilled") continue;
    for (const c of f.value.data.children) {
      const d = c.data;
      if (!d.display_name || seen.has(d.display_name.toLowerCase())) continue;
      seen.add(d.display_name.toLowerCase());
      if (d.subscribers < 10000) continue;
      results.push(d);
    }
  }
  return results.slice(0, limit);
}

async function fetchNsfwRising(limit = 100) {
  const seen = new Set();
  const results = [];
  const queries = NSFW_MODEL_QUERIES.slice(4, 8);
  const fetches = await Promise.allSettled(
    queries.map(q => redditGet("/subreddits/search", { q, sort: "activity", limit: 50, include_over_18: "on" }))
  );
  for (const f of fetches) {
    if (f.status !== "fulfilled") continue;
    for (const c of f.value.data.children) {
      const d = c.data;
      if (!d.display_name || seen.has(d.display_name.toLowerCase())) continue;
      seen.add(d.display_name.toLowerCase());
      if (d.subscribers < 1000 || d.subscribers > 2000000) continue;
      results.push(d);
    }
  }
  return results.slice(0, limit);
}

async function fetchNsfwNew(limit = 100) {
  const results = [];
  const seen = new Set();
  const queries = NSFW_MODEL_QUERIES.slice(8, 12);
  const fetches = await Promise.allSettled(
    queries.map(q => redditGet("/subreddits/search", { q, sort: "new", limit: 50, include_over_18: "on" }))
  );
  for (const f of fetches) {
    if (f.status !== "fulfilled") continue;
    for (const c of f.value.data.children) {
      const d = c.data;
      if (!d.display_name || seen.has(d.display_name.toLowerCase())) continue;
      seen.add(d.display_name.toLowerCase());
      if (d.subscribers < 500 || d.subscribers > 1000000) continue;
      results.push(d);
    }
  }
  // Supplement from /subreddits/new
  try {
    const data = await redditGet("/subreddits/new", { limit: 100, sort: "new", include_over_18: "1" });
    for (const c of data.data.children) {
      const d = c.data;
      if (!seen.has(d.display_name) && d.over18 && d.subscribers >= 500 && d.subreddit_type === "public") {
        seen.add(d.display_name);
        results.push(d);
      }
    }
  } catch {}
  results.sort((a, b) => b.created_utc - a.created_utc);
  return results.slice(0, limit);
}

async function fetchNsfwUnmoderated(targetCount = 100, excludeSubs = new Set()) {
  const results = [];
  const seen = new Set(excludeSubs);
  const maxUtc = getUnmodMaxUtc();

  const PAGES_PER_BATCH = 3;
  let after = null;
  let batches = 0;
  const MAX_BATCHES = 5;

  while (results.length < targetCount && batches < MAX_BATCHES) {
    batches++;
    const pages = await Promise.allSettled(
      Array(PAGES_PER_BATCH).fill(null).map(() => {
        const p = { limit: 100, sort: "new", include_over_18: "1" };
        if (after) p.after = after;
        return redditGet("/subreddits/new", p);
      })
    );

    let gotNewAfter = false;
    for (const page of pages) {
      if (page.status !== "fulfilled") continue;
      const children = page.value?.data?.children || [];
      for (const child of children) {
        const sub = child.data;
        const name = sub.display_name?.toLowerCase();
        if (!name || seen.has(name)) continue;
        seen.add(name);
        const subs = sub.subscribers || 0;
        if (subs < 20 || subs > 2500) continue;
        if (!sub.over18) continue;
        if (sub.subreddit_type !== "public") continue;
        if (sub.restrict_posting === true) continue;
        if (sub.submission_type === "restricted") continue;
        const created = sub.created_utc || 0;
        if (created < UNMOD_MIN_UTC || created > maxUtc) continue;
        results.push(sub);
        if (results.length >= targetCount) break;
      }
      const newAfter = page.value?.data?.after;
      if (newAfter && !gotNewAfter) { after = newAfter; gotNewAfter = true; }
    }
    if (!gotNewAfter) break;
  }

  // Fallback: search-based if not enough
  if (results.length < 20) {
    const queries = ["nsfw amateur", "adult content", "18plus", "xxx"];
    for (const q of queries) {
      if (results.length >= targetCount) break;
      try {
        const data = await redditGet("/subreddits/search", { q, sort: "new", limit: 100, include_over_18: "on" });
        for (const c of data.data.children) {
          const sub = c.data;
          const name = sub.display_name?.toLowerCase();
          if (!name || seen.has(name)) continue;
          seen.add(name);
          const subs = sub.subscribers || 0;
          if (subs < 20 || subs > 2500) continue;
          if (!sub.over18 || sub.subreddit_type !== "public") continue;
          if (sub.restrict_posting === true) continue;
          const created = sub.created_utc || 0;
          if (created < UNMOD_MIN_UTC || created > maxUtc) continue;
          results.push(sub);
        }
      } catch {}
    }
  }

  return results;
}

// ── Search & utils ────────────────────────────────────────────────────────────
async function searchSubreddits(query, limit = 100, includeNsfw = false, sort = "relevance") {
  const params = { q: query, limit: Math.min(limit, 100), sort };
  if (includeNsfw) params.include_over_18 = "on";
  const data = await redditGet("/subreddits/search", params);
  return data.data.children.map((c) => c.data);
}

async function getSubreddit(name) {
  const data = await redditGet(`/r/${name}/about`);
  return data.data;
}

async function getSubEngagement(name, postLimit = 25) {
  try {
    const data = await redditGet(`/r/${name}/hot`, { limit: postLimit });
    const posts = data.data.children.map((c) => c.data);
    if (!posts.length) return null;
    const totalScore = posts.reduce((s, p) => s + p.score, 0);
    const totalComments = posts.reduce((s, p) => s + p.num_comments, 0);
    const avgScore = Math.round(totalScore / posts.length);
    const avgComments = Math.round(totalComments / posts.length);
    return { avgScore, avgComments, avgEngagement: avgScore + avgComments, postsAnalyzed: posts.length };
  } catch { return null; }
}

module.exports = {
  fetchTrending, fetchNew, fetchNsfwTrending, fetchNsfwRising,
  fetchNsfwNew, fetchRising, fetchUnmoderated, fetchNsfwUnmoderated,
  searchSubreddits, getSubreddit, getSubEngagement, redditGet,
};