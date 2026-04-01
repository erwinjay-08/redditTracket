const axios = require("axios");

let accessToken = null;
let tokenExpiry = 0;

async function getToken() {
  if (accessToken && Date.now() < tokenExpiry) return accessToken;

  if (
    !process.env.REDDIT_CLIENT_ID ||
    process.env.REDDIT_CLIENT_ID === "your_client_id_here"
  ) {
    return null;
  }

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

// ── SFW ──────────────────────────────────────────────────────────────────────

async function fetchTrending(limit = 25) {
  const data = await redditGet("/subreddits/popular", { limit: limit * 2 });
  return data.data.children
    .map((c) => c.data)
    .filter((d) => d.subscribers >= 300000)
    .slice(0, limit);
}

async function fetchRising(limit = 25) {
  const data = await redditGet("/r/all/rising", { limit: 100 });
  const posts = data.data.children.map((c) => c.data);
  const seen = new Set();
  const subs = [];
  for (const post of posts) {
    if (!seen.has(post.subreddit)) {
      seen.add(post.subreddit);
      const subscribers = post.subreddit_subscribers || 0;
      if (subscribers >= 10000 && subscribers <= 500000) {
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

async function fetchNew(limit = 25) {
  const data = await redditGet("/subreddits/search", {
    q: "community",
    sort: "new",
    limit: limit * 3,
  });
  return data.data.children
    .map((c) => c.data)
    .filter(
      (d) => d.over18 !== true && d.subscribers >= 100 && d.subscribers <= 2500,
    )
    .slice(0, limit);
}

async function fetchUnmoderated(targetCount = 100) {
  const buckets = {
    "0-100": [],
    "100-500": [],
    "500-1000": [],
    "1000-2500": [],
  };

  const bucketLimits = {
    "0-100": 25,
    "100-500": 25,
    "500-1000": 25,
    "1000-2500": 25,
  };

  function getBucket(subs) {
    if (subs < 100) return "0-100";
    if (subs < 500) return "100-500";
    if (subs < 1000) return "500-1000";
    return "1000-2500";
  }

  const seen = new Set();
  let after = null;
  let attempts = 0;
  const maxAttempts = 10;

  while (attempts < maxAttempts) {
    attempts++;

    const params = { limit: 100, sort: "new" };
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

      // ✅ filters
      if (subs < 20) continue; // remove trash 1-member subs
      if (subs > 2500) continue;
      if (sub.over18) continue;
      if (sub.subreddit_type !== "public") continue;

      const bucket = getBucket(subs);

      if (buckets[bucket].length >= bucketLimits[bucket]) continue;

      buckets[bucket].push(sub);

      const total = Object.values(buckets).flat().length;
      if (total >= targetCount) break;
    }

    after = data?.data?.after;
    if (!after) break;
  }

  return Object.values(buckets).flat();
}
// ── NSFW ─────────────────────────────────────────────────────────────────────

async function fetchNsfwTrending(limit = 25) {
  const data = await redditGet("/subreddits/search", {
    q: "nsfw",
    sort: "relevance",
    limit: limit * 2,
    include_over_18: "on",
  });
  return data.data.children
    .map((c) => c.data)
    .filter((d) => d.subscribers >= 300000)
    .slice(0, limit);
}

async function fetchNsfwRising(limit = 25) {
  const data = await redditGet("/subreddits/search", {
    q: "nsfw",
    sort: "activity",
    limit: limit * 3,
    include_over_18: "on",
  });
  return data.data.children
    .map((c) => c.data)
    .filter((d) => d.subscribers >= 10000 && d.subscribers <= 500000)
    .slice(0, limit);
}

async function fetchNsfwNew(limit = 25) {
  const queries = ["nsfw", "adult", "xxx", "18plus", "onlyfans"];
  const seen = new Set();
  const results = [];

  for (const q of queries) {
    if (results.length >= limit) break;
    try {
      const data = await redditGet("/subreddits/search", {
        q,
        sort: "new",
        limit: 50,
        include_over_18: "on",
      });
      for (const c of data.data.children) {
        const d = c.data;
        if (
          !seen.has(d.display_name) &&
          d.subscribers >= 500 &&
          d.subscribers <= 100000
        ) {
          seen.add(d.display_name);
          results.push(d);
        }
      }
    } catch {}
  }

  results.sort((a, b) => b.created_utc - a.created_utc);
  return results.slice(0, limit);
}

async function fetchNsfwUnmoderated(targetCount = 100) {
  const buckets = {
    "0-100": [],
    "100-500": [],
    "500-1000": [],
    "1000-2500": [],
  };

  const bucketLimits = {
    "0-100": 25,
    "100-500": 25,
    "500-1000": 25,
    "1000-2500": 25,
  };

  function getBucket(subs) {
    if (subs < 100) return "0-100";
    if (subs < 500) return "100-500";
    if (subs < 1000) return "500-1000";
    return "1000-2500";
  }

  const seen = new Set();
  let after = null;
  let attempts = 0;
  const maxAttempts = 10;

  while (attempts < maxAttempts) {
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

      // ✅ filters
      if (subs < 20) continue;
      if (subs > 2500) continue;
      if (!sub.over18) continue;
      if (sub.subreddit_type !== "public") continue;

      const bucket = getBucket(subs);

      if (buckets[bucket].length >= bucketLimits[bucket]) continue;

      buckets[bucket].push(sub);

      const total = Object.values(buckets).flat().length;
      if (total >= targetCount) break;
    }

    after = data?.data?.after;
    if (!after) break;
  }

  return Object.values(buckets).flat();
}

// ── Search & utils ───────────────────────────────────────────────────────────

async function searchSubreddits(
  query,
  limit = 10,
  includeNsfw = false,
  sort = "relevance",
) {
  const params = { q: query, limit, sort };
  if (includeNsfw) params.include_over_18 = "on";
  const data = await redditGet("/subreddits/search", params);
  return data.data.children.map((c) => c.data);
}

async function getSubreddit(name) {
  const data = await redditGet(`/r/${name}/about`);
  return data.data;
}

// Fetch top posts from a sub to calculate engagement rate
async function getSubEngagement(name, postLimit = 25) {
  try {
    const data = await redditGet(`/r/${name}/hot`, { limit: postLimit });
    const posts = data.data.children.map((c) => c.data);
    if (!posts.length) return null;

    const totalScore = posts.reduce((s, p) => s + p.score, 0);
    const totalComments = posts.reduce((s, p) => s + p.num_comments, 0);
    const avgScore = Math.round(totalScore / posts.length);
    const avgComments = Math.round(totalComments / posts.length);
    const avgEngagement = avgScore + avgComments;

    return {
      avgScore,
      avgComments,
      avgEngagement,
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
