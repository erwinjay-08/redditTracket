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

const SFW_QUERIES = [
  "fitness girls",
  "pilates",
  "modeling",
  "photography",
  "candid",
  "yoga",
  "fashion",
  "dance beauty",
  "cosplay",
  "selfie",
  "gym body",
  "bikini",
  "lingerie",
  "body positive",
  "fashion style",
  "makeup",
  "beauty",
  "portrait",
  "athletic women",
  "cheerleading",
  "swimsuit",
  "street style",
  "summer fashion",
  "morning routine",
  "grwm",
  "vanilla girls",
  "coquette",
  "whimsigoth",
  "aesthetic",
];

const NSFW_QUERIES = [
  "gonewild",
  "nsfw",
  "realgirls",
  "amateur",
  "onlyfans",
  "latina",
  "asian",
  "ebony",
  "curvy",
  "fitnessgirls",
  "petite",
  "milf",
  "lingerie",
  "boobs",
  "curvy",
  "thick",
  "thighs",
  "stockings",
  "chest",
  "tits",
  "ass",
  "pussy",
  "streetwear nsfw",
  "amateur selfie",
  "cosplay lewd",
  "homegrown",
  "feet",
];

async function searchMulti(
  queries,
  sort,
  includeNsfw,
  minSubs,
  maxSubs,
  limit = 100,
) {
  const seen = new Set();
  const results = [];

  const fetches = await Promise.allSettled(
    queries.map((q) => {
      const params = { q, sort, limit: 100 };
      if (includeNsfw) params.include_over_18 = "on";
      return redditGet("/subreddits/search", params);
    }),
  );

  for (const f of fetches) {
    if (f.status !== "fulfilled") continue;
    for (const c of f.value.data.children) {
      const d = c.data;
      if (!d.display_name || seen.has(d.display_name.toLowerCase())) continue;
      seen.add(d.display_name.toLowerCase());
      const subs = d.subscribers || 0;
      if (subs < minSubs || subs > maxSubs) continue;
      if (!includeNsfw && d.over18) continue;
      results.push(d);
    }
  }

  return results.slice(0, limit);
}

// ── SFW ──────────────────────────────────────────────────────────────────────

async function fetchTrending(limit = 25) {
  const data = await redditGet("/subreddits/popular", { limit: limit * 2 });
  return data.data.children
    .map((c) => c.data)
    .filter((d) => d.subscribers >= 300000)
    .slice(0, limit);
}

async function fetchRising(limit = 100) {
  const seen = new Set();
  const results = [];

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

  if (results.length < limit) {
    const more = await searchMulti(
      SFW_QUERIES,
      "activity",
      false,
      1000,
      300000,
      limit * 2,
    );
    for (const d of more) {
      if (seen.has(d.display_name.toLowerCase())) continue;
      seen.add(d.display_name.toLowerCase());
      results.push(d);
      if (results.length >= limit) break;
    }
  }

  return results.slice(0, limit);
}

async function fetchNew(limit = 100) {
  return searchMulti(SFW_QUERIES, "new", false, 500, 50000, limit);
}

async function fetchUnmoderated(targetCount = 100, excludeSubs = new Set()) {
  const results = [];
  const seen = new Set(excludeSubs);

  let after = null;
  const BATCH = 3;
  let rounds = 0;
  const MAX_ROUNDS = 8;

  while (results.length < targetCount && rounds < MAX_ROUNDS) {
    rounds++;

    const pages = await Promise.allSettled(
      Array.from({ length: BATCH }, () => {
        const p = { limit: 100, sort: "new" };
        if (after) p.after = after;
        return redditGet("/subreddits/new", p);
      }),
    );

    let advancedAfter = false;
    for (const page of pages) {
      if (page.status !== "fulfilled") continue;
      const children = page.value?.data?.children || [];
      if (!children.length) continue;

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

      if (!advancedAfter) {
        const next = page.value?.data?.after;
        if (next) {
          after = next;
          advancedAfter = true;
        }
      }
      if (results.length >= targetCount) break;
    }

    if (!advancedAfter) break;
  }

  return results;
}

// ── NSFW ─────────────────────────────────────────────────────────────────────

async function fetchNsfwTrending(limit = 100) {
  // Same queries, sort by relevance = biggest/most-known NSFW subs
  return searchMulti(NSFW_QUERIES, "relevance", true, 10000, 10000000, limit);
}

async function fetchNsfwRising(limit = 100) {
  return searchMulti(NSFW_QUERIES, "activity", true, 1000, 300000, limit);
}

async function fetchNsfwNew(limit = 100) {
  return searchMulti(NSFW_QUERIES, "new", true, 500, 50000, limit);
}

// NSFW Unmoderated: MUST use search — include_over_18 is ignored on
// /subreddits/new with client_credentials OAuth
async function fetchNsfwUnmoderated(
  targetCount = 100,
  excludeSubs = new Set(),
) {
  const results = [];
  const seen = new Set(excludeSubs);

  const fetches = await Promise.allSettled(
    NSFW_QUERIES.map((q) =>
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
    for (const child of f.value.data.children) {
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
    if (results.length >= targetCount) break;
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
