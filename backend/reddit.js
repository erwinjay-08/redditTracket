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
      (d) =>
        d.over18 !== true && d.subscribers >= 500 && d.subscribers <= 100000,
    )
    .slice(0, limit);
}

async function fetchUnmoderated(targetCount = 100) {
  const results = [];
  const seen = new Set();
  let after = null;
  let attempts = 0;
  const maxAttempts = 20; // more attempts = more subs found

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

async function fetchNsfwNew(limit = 100) {
  const results = [];
  const seen = new Set();

  // Primary: /subreddits/new with over18
  try {
    let after = null;
    let attempts = 0;
    while (results.length < limit && attempts < 10) {
      attempts++;
      const params = { limit: 100, sort: "new", include_over_18: "1" };
      if (after) params.after = after;
      const data = await redditGet("/subreddits/new", params);
      const children = data?.data?.children || [];
      if (!children.length) break;
      for (const child of children) {
        const d = child.data;
        if (
          !seen.has(d.display_name) &&
          d.over18 &&
          d.subscribers >= 500 &&
          d.subscribers <= 500000 &&
          d.subreddit_type === "public"
        ) {
          seen.add(d.display_name);
          results.push(d);
        }
      }
      after = data?.data?.after;
      if (!after) break;
    }
  } catch {}

  // Fallback search queries
  if (results.length < limit) {
    const queries = ["nsfw", "adult", "xxx", "18plus", "onlyfans"];
    for (const q of queries) {
      if (results.length >= limit) break;
      try {
        const data = await redditGet("/subreddits/search", {
          q,
          sort: "new",
          limit: 100,
          include_over_18: "on",
        });
        for (const c of data.data.children) {
          const d = c.data;
          if (
            !seen.has(d.display_name) &&
            d.subscribers >= 500 &&
            d.subscribers <= 500000
          ) {
            seen.add(d.display_name);
            results.push(d);
          }
        }
      } catch {}
    }
  }

  results.sort((a, b) => b.created_utc - a.created_utc);
  return results.slice(0, limit);
}

async function fetchNsfwUnmoderated(targetCount = 100) {
  // Strategy: fetch new NSFW subs via /subreddits/new with include_over_18
  // Reddit's public API often hides NSFW from /subreddits/new even with the flag,
  // so we also try search-based discovery with nsfw keywords + sort=new
  const results = [];
  const seen = new Set();

  // Attempt 1: /subreddits/new with over18 flag
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

  // Attempt 2: search-based fallback if we got fewer than 20
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

// ── Search & utils ───────────────────────────────────────────────────────────

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
