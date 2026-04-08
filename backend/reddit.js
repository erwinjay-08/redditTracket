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

// ── Model-focused search queries ──────────────────────────────────────────────

const SFW_MODEL_QUERIES = [
  "fitness girls",
  "gym selfie",
  "workout women",
  "yoga girls",
  "photography",
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
  "fashion",
  "clothes",
];

const NSFW_MODEL_QUERIES = [
  "gonewild",
  "realgirls",
  "amateur",
  "onlyfans",
  "latina",
  "asian",
  "ebony",
  "petite",
  "curvy",
  "milf",
  "fitness nsfw",
  "selfie nsfw",
  "boobs",
  "lingerie",
  "18plus",
];

// ── SFW ──────────────────────────────────────────────────────────────────────

async function fetchTrending(limit = 100) {
  const seen = new Set();
  const results = [];

  // Run first 8 model queries in parallel (relevance = most subscribed relevant subs)
  const fetches = await Promise.allSettled(
    SFW_MODEL_QUERIES.slice(0, 8).map((q) =>
      redditGet("/subreddits/search", { q, sort: "relevance", limit: 100 }),
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

  // Supplement with /subreddits/popular for general fill
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

  // Model queries sorted by activity = actively posting subs in niche, capped 300K
  const fetches = await Promise.allSettled(
    SFW_MODEL_QUERIES.slice(4, 12).map((q) =>
      redditGet("/subreddits/search", { q, sort: "activity", limit: 100 }),
    ),
  );
  for (const f of fetches) {
    if (f.status !== "fulfilled") continue;
    for (const c of f.value.data.children) {
      const d = c.data;
      if (!d.display_name || seen.has(d.display_name.toLowerCase())) continue;
      seen.add(d.display_name.toLowerCase());
      if (d.over18 || d.subscribers < 1000 || d.subscribers > 300000) continue;
      results.push(d);
    }
  }

  // Supplement with /r/all rising for genuinely trending activity
  try {
    const rising = await redditGet("/r/all/rising", { limit: 100 });
    for (const c of rising.data.children) {
      const p = c.data;
      if (!p.subreddit || seen.has(p.subreddit.toLowerCase())) continue;
      seen.add(p.subreddit.toLowerCase());
      const subs = p.subreddit_subscribers || 0;
      if (!p.over_18 && subs >= 5000 && subs <= 300000) {
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
  const results = [];
  const seen = new Set();
  const sixMonthsAgo = Math.floor(Date.now() / 1000) - 6 * 30 * 24 * 3600;

  // Primary: /subreddits/new — sorted by actual creation date
  try {
    let after = null;
    let attempts = 0;
    while (results.length < limit && attempts < 15) {
      attempts++;
      const params = { limit: 100, sort: "new" };
      if (after) params.after = after;
      const data = await redditGet("/subreddits/new", params);
      const children = data?.data?.children || [];
      if (!children.length) break;
      for (const child of children) {
        const d = child.data;
        if (!d.display_name || seen.has(d.display_name.toLowerCase())) continue;
        seen.add(d.display_name.toLowerCase());
        if (d.over18 || d.subreddit_type !== "public") continue;
        const subs = d.subscribers || 0;
        if (subs < 500 || subs > 150000) continue;
        // Only subs created in last 6 months count as "new"
        if (d.created_utc && d.created_utc < sixMonthsAgo) continue;
        results.push(d);
      }
      after = data?.data?.after;
      if (!after) break;
    }
  } catch (err) {
    console.warn("[fetchNew] error:", err.message);
  }

  // Supplement with model queries if not enough
  if (results.length < limit) {
    const fetches = await Promise.allSettled(
      SFW_MODEL_QUERIES.slice(8, 16).map((q) =>
        redditGet("/subreddits/search", { q, sort: "new", limit: 100 }),
      ),
    );
    for (const f of fetches) {
      if (f.status !== "fulfilled") continue;
      for (const c of f.value.data.children) {
        const d = c.data;
        if (!d.display_name || seen.has(d.display_name.toLowerCase())) continue;
        seen.add(d.display_name.toLowerCase());
        if (d.over18 || d.subscribers < 500 || d.subscribers > 150000) continue;
        if (d.created_utc && d.created_utc < sixMonthsAgo) continue;
        results.push(d);
        if (results.length >= limit) break;
      }
      if (results.length >= limit) break;
    }
  }

  return results.slice(0, limit);
}

// ── Unmoderated: /subreddits/new pagination is the ONLY reliable way to get
// 20–2500 member subs. Search always returns popular subs that fail that cap.
async function fetchUnmoderated(targetCount = 100, excludeSubs = new Set()) {
  const results = [];
  const seen = new Set(excludeSubs);

  let after = null;
  let attempts = 0;
  const maxAttempts = 25;

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
        if (sub.restrict_posting === true) continue;
        if (sub.submission_type === "restricted") continue;

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

async function fetchNsfwTrending(limit = 100) {
  const seen = new Set();
  const results = [];

  const fetches = await Promise.allSettled(
    NSFW_MODEL_QUERIES.slice(0, 8).map((q) =>
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

async function fetchNsfwRising(limit = 100) {
  const seen = new Set();
  const results = [];

  const fetches = await Promise.allSettled(
    NSFW_MODEL_QUERIES.slice(4, 12).map((q) =>
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

async function fetchNsfwNew(limit = 100) {
  const results = [];
  const seen = new Set();
  const sixMonthsAgo = Math.floor(Date.now() / 1000) - 6 * 30 * 24 * 3600;

  // Primary: /subreddits/new with over18
  try {
    let after = null;
    let attempts = 0;
    while (results.length < limit && attempts < 15) {
      attempts++;
      const params = { limit: 100, sort: "new", include_over_18: "1" };
      if (after) params.after = after;
      const data = await redditGet("/subreddits/new", params);
      const children = data?.data?.children || [];
      if (!children.length) break;
      for (const child of children) {
        const d = child.data;
        if (!d.display_name || seen.has(d.display_name.toLowerCase())) continue;
        seen.add(d.display_name.toLowerCase());
        if (!d.over18 || d.subreddit_type !== "public") continue;
        const subs = d.subscribers || 0;
        if (subs < 500 || subs > 500000) continue;
        if (d.created_utc && d.created_utc < sixMonthsAgo) continue;
        results.push(d);
      }
      after = data?.data?.after;
      if (!after) break;
    }
  } catch {}

  // Supplement with NSFW model queries
  if (results.length < limit) {
    const fetches = await Promise.allSettled(
      NSFW_MODEL_QUERIES.slice(8, 15).map((q) =>
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
        if (d.subscribers < 500 || d.subscribers > 500000) continue;
        if (d.created_utc && d.created_utc < sixMonthsAgo) continue;
        results.push(d);
        if (results.length >= limit) break;
      }
      if (results.length >= limit) break;
    }
  }

  results.sort((a, b) => b.created_utc - a.created_utc);
  return results.slice(0, limit);
}

// ── NSFW Unmoderated: same /subreddits/new approach with include_over_18 ──────
async function fetchNsfwUnmoderated(
  targetCount = 100,
  excludeSubs = new Set(),
) {
  const results = [];
  const seen = new Set(excludeSubs);

  let after = null;
  let attempts = 0;
  const maxAttempts = 25;

  while (results.length < targetCount && attempts < maxAttempts) {
    attempts++;
    const params = { limit: 100, sort: "new", include_over_18: "1" };
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
        if (!sub.over18) continue;
        if (sub.subreddit_type !== "public") continue;
        if (sub.restrict_posting === true) continue;
        if (sub.submission_type === "restricted") continue;

        results.push(sub);
        if (results.length >= targetCount) break;
      }

      after = data?.data?.after;
      if (!after) break;
    } catch (err) {
      console.warn("[fetchNsfwUnmoderated] page error:", err.message);
      break;
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
