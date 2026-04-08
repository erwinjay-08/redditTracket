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

// ── Age helpers ───────────────────────────────────────────────────────────────
// Unmoderated: subs created between Jan 2015 and 9 months ago
const UNMOD_MIN_UTC = 1420070400; // Jan 1, 2015
function getUnmodMaxUtc() {
  return Math.floor(Date.now() / 1000) - 9 * 30 * 24 * 3600; // 9 months ago
}

// ── SFW model-posting subs ────────────────────────────────────────────────────
// These are subs where models (fitness, beauty, photography, candid) can post

const SFW_MODEL_QUERIES = [
  "fitness girls",
  "gym selfie",
  "workout women",
  "yoga girls",
  "portrait photography",
  "modeling",
  "photoshoot",
  "body positive",
  "beauty makeup",
  "fashion style",
  "dance performance",
  "candid photography",
  "cosplay",
  "cheerleading",
  "gymnastics women",
];

async function fetchTrending(limit = 100) {
  const seen = new Set();
  const results = [];
  // Run 4 queries in parallel, pick from combined
  const queries = SFW_MODEL_QUERIES.slice(0, 4);
  const fetches = await Promise.allSettled(
    queries.map((q) =>
      redditGet("/subreddits/search", { q, sort: "relevance", limit: 50 }),
    ),
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
    queries.map((q) =>
      redditGet("/subreddits/search", { q, sort: "activity", limit: 50 }),
    ),
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
        results.push({
          display_name: p.subreddit,
          subscribers: subs,
          public_description: "",
          active_user_count: 0,
          over18: false,
          created_utc: 0,
          title: p.subreddit,
        });
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
    queries.map((q) =>
      redditGet("/subreddits/search", { q, sort: "new", limit: 50 }),
    ),
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
  const seen = new Set();

  // Phase 1: Parallel model-relevant searches (8x faster than sequential pages)
  const sfwQueries = [
    "photography selfie community",
    "fitness body girls",
    "candid photo amateur",
    "beauty skincare lifestyle",
    "fashion ootd style",
    "selfie amateur community",
    "female fitness body",
    "photos girls community",
  ];

  try {
    const batches = await Promise.all(
      sfwQueries.map((q) =>
        redditGet("/subreddits/search", { q, sort: "new", limit: 100 }).catch(
          () => ({ data: { children: [] } }),
        ),
      ),
    );
    for (const r of batches) {
      for (const c of r.data.children || []) {
        const sub = c.data;
        const name = sub.display_name?.toLowerCase();
        if (!name || seen.has(name) || excludeSubs.has(name)) continue;
        seen.add(name);
        const subs = sub.subscribers || 0;
        if (subs < 20 || subs > 2500) continue;
        if (sub.over18) continue;
        if (!passesPostingFilter(sub)) continue;
        if (!passesAgeFilter(sub.created_utc)) continue;
        results.push(sub);
        if (results.length >= targetCount) return results;
      }
    }
  } catch {}

  // Phase 2: Sequential /subreddits/new fallback if Phase 1 didn't fill up
  if (results.length < targetCount) {
    let after = null;
    let attempts = 0;
    while (results.length < targetCount && attempts < 10) {
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
          if (!name || seen.has(name) || excludeSubs.has(name)) continue;
          seen.add(name);
          const subs = sub.subscribers || 0;
          if (subs < 20 || subs > 2500) continue;
          if (sub.over18) continue;
          if (!passesPostingFilter(sub)) continue;
          if (!passesAgeFilter(sub.created_utc)) continue;
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
  }

  return results;
}

// ── NSFW ─────────────────────────────────────────────────────────────────────
const NSFW_MODEL_QUERIES = [
  "gonewild",
  "realgirls",
  "amateur",
  "onlyfans",
  "latina",
  "asian",
  "ebony",
  "curvy",
  "fitness",
  "petite",
  "milf",
  "boobs",
  "ass",
  "thick",
  "nsfw",
  "nudes",
];

async function fetchNsfwTrending(limit = 100) {
  const seen = new Set();
  const results = [];
  const queries = NSFW_MODEL_QUERIES.slice(0, 4);
  const fetches = await Promise.allSettled(
    queries.map((q) =>
      redditGet("/subreddits/search", {
        q,
        sort: "relevance",
        limit: 50,
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

async function fetchNsfwRising(limit = 100) {
  const seen = new Set();
  const results = [];
  const queries = NSFW_MODEL_QUERIES.slice(4, 8);
  const fetches = await Promise.allSettled(
    queries.map((q) =>
      redditGet("/subreddits/search", {
        q,
        sort: "activity",
        limit: 50,
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
    queries.map((q) =>
      redditGet("/subreddits/search", {
        q,
        sort: "new",
        limit: 50,
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
      if (d.subscribers < 500 || d.subscribers > 1000000) continue;
      results.push(d);
    }
  }
  // Supplement from /subreddits/new
  try {
    const data = await redditGet("/subreddits/new", {
      limit: 100,
      sort: "new",
      include_over_18: "1",
    });
    for (const c of data.data.children) {
      const d = c.data;
      if (
        !seen.has(d.display_name) &&
        d.over18 &&
        d.subscribers >= 500 &&
        d.subreddit_type === "public"
      ) {
        seen.add(d.display_name);
        results.push(d);
      }
    }
  } catch {}
  results.sort((a, b) => b.created_utc - a.created_utc);
  return results.slice(0, limit);
}

async function fetchNsfwUnmoderated(
  targetCount = 100,
  excludeSubs = new Set(),
) {
  const results = [];
  const seen = new Set();

  // Phase 1: Parallel NSFW model searches
  const nsfwQueries = [
    "gonewild nsfw community",
    "amateur nsfw girls",
    "onlyfans nsfw",
    "petite nsfw amateur",
    "curvy nsfw community",
    "nsfw photos girls",
    "adult content nsfw",
    "explicit nsfw community",
  ];

  try {
    const batches = await Promise.all(
      nsfwQueries.map((q) =>
        redditGet("/subreddits/search", {
          q,
          sort: "new",
          limit: 100,
          include_over_18: "on",
        }).catch(() => ({ data: { children: [] } })),
      ),
    );
    for (const r of batches) {
      for (const c of r.data.children || []) {
        const sub = c.data;
        const name = sub.display_name?.toLowerCase();
        if (!name || seen.has(name) || excludeSubs.has(name)) continue;
        seen.add(name);
        const subs = sub.subscribers || 0;
        if (subs < 20 || subs > 2500) continue;
        if (!sub.over18) continue;
        if (!passesPostingFilter(sub)) continue;
        if (!passesAgeFilter(sub.created_utc)) continue;
        results.push(sub);
        if (results.length >= targetCount) return results;
      }
    }
  } catch {}

  // Phase 2: /subreddits/new with over18 flag
  if (results.length < targetCount) {
    try {
      let after = null;
      let attempts = 0;
      while (results.length < targetCount && attempts < 10) {
        attempts++;
        const params = { limit: 100, sort: "new", include_over_18: "1" };
        if (after) params.after = after;
        const data = await redditGet("/subreddits/new", params);
        const children = data?.data?.children || [];
        if (!children.length) break;
        for (const child of children) {
          const sub = child.data;
          const name = sub.display_name?.toLowerCase();
          if (!name || seen.has(name) || excludeSubs.has(name)) continue;
          seen.add(name);
          const subs = sub.subscribers || 0;
          if (subs < 20 || subs > 2500) continue;
          if (!sub.over18) continue;
          if (!passesPostingFilter(sub)) continue;
          if (!passesAgeFilter(sub.created_utc)) continue;
          results.push(sub);
          if (results.length >= targetCount) break;
        }
        after = data?.data?.after;
        if (!after) break;
      }
    } catch (err) {
      console.warn("[fetchNsfwUnmoderated] fallback error:", err.message);
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
