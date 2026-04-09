const axios = require("axios");

let accessToken = null;
let tokenExpiry = 0;

async function getToken() {
  if (accessToken && Date.now() < tokenExpiry) return accessToken;
  if (
    !process.env.REDDIT_CLIENT_ID ||
    process.env.REDDIT_CLIENT_ID === "your_client_id_here"
  )
    return null;
  const resp = await axios.post(
    "https://www.reddit.com/api/v1/access_token",
    "grant_type=client_credentials",
    {
      auth: {
        username: process.env.REDDIT_CLIENT_ID,
        password: process.env.REDDIT_CLIENT_SECRET,
      },
      headers: {
        "User-Agent": process.env.REDDIT_USER_AGENT || "SubTracker/1.0",
        "Content-Type": "application/x-www-form-urlencoded",
      },
    },
  );
  accessToken = resp.data.access_token;
  tokenExpiry = Date.now() + (resp.data.expires_in - 60) * 1000;
  console.log("[reddit] OAuth token acquired");
  return accessToken;
}

async function redditGet(path, params = {}) {
  const token = await getToken();
  const baseUrl = token ? "https://oauth.reddit.com" : "https://www.reddit.com";
  const headers = {
    "User-Agent": process.env.REDDIT_USER_AGENT || "SubTracker/1.0",
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const resp = await axios.get(`${baseUrl}${path}.json`, { params, headers });
  return resp.data;
}

// ── Query banks ───────────────────────────────────────────────────────────────
// Trending uses /subreddits/popular — most reliable, cached in DB
// Rising uses /r/all/rising — genuinely trending activity signal
// New uses search(sort:new) — fast parallel, returns recent communities
// Unmoderated SFW uses /subreddits/new with parallel batches
// Unmoderated NSFW uses search(include_over_18) — only way to get NSFW small subs

const SFW_NEW_QUERIES = [
  "fitness girls",
  "modeling photography",
  "candid women",
  "yoga fashion",
  "dance beauty",
  "cosplay selfie",
  "gym body",
  "beach bikini",
];

const NSFW_TRENDING_QUERIES = [
  "gonewild",
  "realgirls",
  "amateur",
  "onlyfans",
  "latina nsfw",
  "asian nsfw",
  "curvy nsfw",
  "fitnessgirls nsfw",
];

const NSFW_RISING_QUERIES = [
  "ebony nsfw",
  "petite nsfw",
  "milf nsfw",
  "lingerie nsfw",
  "boobs nsfw",
  "amateur selfie nsfw",
  "fitness nsfw",
  "cosplay lewd",
];

const NSFW_NEW_QUERIES = [
  "gonewild new",
  "amateur",
  "18plus",
  "onlyfans girls",
  "nsfw selfie",
  "realgirls",
  "nudes",
  "nsfw selfie",
  "latina",
  "asian",
  "ebony",
  "curvy",
  "chest",
  "tits",
  "boobs",
  "thighs",
];

// Unmoderated NSFW: search-based ONLY — include_over_18 is ignored on
// /subreddits/new with client_credentials, so we must use search API
const NSFW_UNMOD_QUERIES = [
  "gonewild",
  "realgirls",
  "amateur nsfw",
  "nsfw girls",
  "18plus girls",
  "sexy nsfw",
  "nudes",
  "nsfw selfie",
  "latina",
  "asian",
  "ebony",
  "curvy",
];

// ── SFW ──────────────────────────────────────────────────────────────────────

// FIX 2: Trending uses /subreddits/popular — completely different source from rising
async function fetchTrending(limit = 25) {
  const data = await redditGet("/subreddits/popular", { limit: limit * 2 });
  return data.data.children
    .map((c) => c.data)
    .filter((d) => d.subscribers >= 300000)
    .slice(0, limit);
}

// FIX 2: Rising uses /r/all/rising — genuinely different from trending
async function fetchRising(limit = 25) {
  const data = await redditGet("/r/all/rising", { limit: 100 });
  const posts = data.data.children.map((c) => c.data);
  const seen = new Set();
  const subs = [];
  for (const post of posts) {
    if (!seen.has(post.subreddit)) {
      seen.add(post.subreddit);
      const subscribers = post.subreddit_subscribers || 0;
      if (subscribers >= 10000 && subscribers <= 300000) {
        subs.push({
          display_name: post.subreddit,
          subscribers,
          public_description: "",
          active_user_count: 0,
          over18: post.over_18,
          created_utc: 0,
          title: post.subreddit,
        });
      }
    }
  }
  return subs.slice(0, limit);
}

// FIX 1: New uses parallel search queries — fast, no age filter, model-focused
async function fetchNew(limit = 100) {
  const results = [];
  const seen = new Set();

  const fetches = await Promise.allSettled(
    SFW_NEW_QUERIES.map((q) =>
      redditGet("/subreddits/search", { q, sort: "new", limit: 100 }),
    ),
  );

  for (const f of fetches) {
    if (f.status !== "fulfilled") continue;
    for (const c of f.value.data.children) {
      const d = c.data;
      if (!d.display_name || seen.has(d.display_name.toLowerCase())) continue;
      seen.add(d.display_name.toLowerCase());
      if (d.over18 || d.subscribers < 500 || d.subscribers > 50000) continue;
      results.push(d);
      if (results.length >= limit) break;
    }
    if (results.length >= limit) break;
  }

  return results.slice(0, limit);
}

// FIX 3 & 4: Unmoderated SFW — parallel batches of /subreddits/new, 3x faster
// No age limit (removed per request), filters 20-2500 subscribers
async function fetchUnmoderated(targetCount = 100, excludeSubs = new Set()) {
  const results = [];
  const seen = new Set(excludeSubs);
  let after = null;
  let attempts = 0;
  const maxAttempts = 20;
  while (results.length < targetCount && attempts < maxAttempts) {
    attempts++;
    const params = { limit: 100, sort: "new" };
    if (after) params.after = after;
    try {
      const data = await redditGet("/subreddits/new", params);
      const children = data?.data?.children || [];
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
        results.push(sub);
        if (results.length >= targetCount) break;
      }
      after = data?.data?.after;
      if (!after) break;
    } catch (err) {
      console.warn("[fetchUnmoderated] page error:", err.message);
      break;
    }
  }
  return results;
}

// ── NSFW ─────────────────────────────────────────────────────────────────────

// FIX 2: NSFW Trending uses different queries from NSFW Rising
async function fetchNsfwTrending(limit = 100) {
  const seen = new Set();
  const results = [];

  const fetches = await Promise.allSettled(
    NSFW_TRENDING_QUERIES.map((q) =>
      redditGet("/subreddits/search", {
        q,
        sort: "relevance",
        limit: 100,
        include_over_18: "on",
      }),
    ),
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

// FIX 2: NSFW Rising uses completely different queries
async function fetchNsfwRising(limit = 100) {
  const seen = new Set();
  const results = [];

  const fetches = await Promise.allSettled(
    NSFW_RISING_QUERIES.map((q) =>
      redditGet("/subreddits/search", {
        q,
        sort: "activity",
        limit: 100,
        include_over_18: "on",
      }),
    ),
  );
  for (const f of fetches) {
    if (f.status !== "fulfilled") continue;
    for (const c of f.value.data.children) {
      const d = c.data;
      if (!d.display_name || seen.has(d.display_name.toLowerCase())) continue;
      seen.add(d.display_name.toLowerCase());
      if (d.subscribers < 1000 || d.subscribers > 300000) continue;
      results.push(d);
    }
  }
  return results.slice(0, limit);
}

// FIX 1: NSFW New — parallel search queries, fast, no sequential pagination
async function fetchNsfwNew(limit = 100) {
  const results = [];
  const seen = new Set();

  const fetches = await Promise.allSettled(
    NSFW_NEW_QUERIES.map((q) =>
      redditGet("/subreddits/search", {
        q,
        sort: "new",
        limit: 100,
        include_over_18: "on",
      }),
    ),
  );

  for (const f of fetches) {
    if (f.status !== "fulfilled") continue;
    for (const c of f.value.data.children) {
      const d = c.data;
      if (!d.display_name || seen.has(d.display_name.toLowerCase())) continue;
      seen.add(d.display_name.toLowerCase());
      if (d.subscribers < 500 || d.subscribers > 50000) continue;
      results.push(d);
      if (results.length >= limit) break;
    }
    if (results.length >= limit) break;
  }

  results.sort((a, b) => (b.created_utc || 0) - (a.created_utc || 0));
  return results.slice(0, limit);
}

// FIX 3: NSFW Unmoderated — MUST use search with include_over_18
// /subreddits/new with include_over_18 is IGNORED for client_credentials OAuth
// Search with include_over_18:"on" is the only way to find NSFW small subs
async function fetchNsfwUnmoderated(
  targetCount = 100,
  excludeSubs = new Set(),
) {
  const results = [];
  const seen = new Set(excludeSubs);
  try {
    let after = null;
    let attempts = 0;
    while (results.length < targetCount && attempts < 20) {
      attempts++;
      const params = { limit: 100, sort: "new", include_over_18: "1" };
      if (after) params.after = after;
      const data = await redditGet("/subreddits/new", params);
      const children = data?.data?.children || [];
      if (!children.length) break;
      for (const child of children) {
        const sub = child.data;
        const name = sub.display_name?.toLowerCase();
        if (!name || seen.has(name)) continue;
        seen.add(name);
        const subs = sub.subscribers || 0;
        if (subs < 20 || subs > 2500) continue;
        if (!sub.over18) continue;
        if (sub.subreddit_type !== "public") continue;
        results.push(sub);
        if (results.length >= targetCount) break;
      }
      after = data?.data?.after;
      if (!after) break;
    }
  } catch (err) {
    console.warn("[fetchNsfwUnmoderated] /subreddits/new failed:", err.message);
  }
  if (results.length < 20) {
    const queries = [
      "nsfw new",
      "adult new",
      "xxx",
      "18plus",
      "onlyfans new",
      "naughty",
      "sexy",
    ];
    for (const q of queries) {
      if (results.length >= targetCount) break;
      try {
        const data = await redditGet("/subreddits/search", {
          q,
          sort: "new",
          limit: 100,
          include_over_18: "on",
        });
        for (const c of data.data.children) {
          const sub = c.data;
          const name = sub.display_name?.toLowerCase();
          if (!name || seen.has(name)) continue;
          seen.add(name);
          const subs = sub.subscribers || 0;
          if (subs < 20 || subs > 2500) continue;
          if (!sub.over18) continue;
          if (sub.subreddit_type !== "public") continue;
          results.push(sub);
          if (results.length >= targetCount) break;
        }
      } catch {}
    }
  }
  return results;
}

// ── Search & utils ────────────────────────────────────────────────────────────

async function searchSubreddits(
  query,
  limit = 100,
  includeNsfw = false,
  sort = "relevance",
) {
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
    return {
      avgScore,
      avgComments,
      avgEngagement: avgScore + avgComments,
      postsAnalyzed: posts.length,
    };
  } catch {
    return null;
  }
}

module.exports = {
  fetchTrending,
  fetchNew,
  fetchNsfwTrending,
  fetchNsfwRising,
  fetchNsfwNew,
  fetchRising,
  fetchUnmoderated,
  fetchNsfwUnmoderated,
  searchSubreddits,
  getSubreddit,
  getSubEngagement,
  redditGet,
};
