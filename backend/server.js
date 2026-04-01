require("dotenv").config();
const express = require("express");
const cors = require("cors");
const cron = require("node-cron");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");

const { saveSubredditData, stmts } = require("./db");
const reddit = require("./reddit");

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "../frontend/public")));

// ─── Supabase ─────────────────────────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY,
);

// ─── Cache ────────────────────────────────────────────────────────────────────
const cache = {};
function bustCache() {
  Object.keys(cache).forEach((k) => delete cache[k]);
}

// ─── FIX #1 & #4: Manila midnight helper ─────────────────────────────────────
// All "today" cutoffs must use Manila time (UTC+8) so posts from e.g.
// 2026-03-30 22:39 UTC (= 2026-03-31 06:39 PHT) count as today, not yesterday.
function getManilaMidnight() {
  // Get today's date string in Manila timezone (YYYY-MM-DD)
  const manilaDateStr = new Date().toLocaleDateString("en-CA", {
    timeZone: "Asia/Manila",
  });
  // Return a Date object for Manila midnight expressed as UTC
  return new Date(manilaDateStr + "T00:00:00+08:00");
}

// ─── Formatters ───────────────────────────────────────────────────────────────
function formatSub(d) {
  const subscribers = d.subscribers || 0;
  const activeUsers = d.active_user_count || 0;
  const engagementRate =
    subscribers > 0
      ? parseFloat(((activeUsers / subscribers) * 100).toFixed(3))
      : 0;
  const qualityScore = subscribers * (1 + engagementRate * 2);
  return {
    name: d.display_name,
    title: d.title || d.display_name,
    description: d.public_description || "",
    subscribers,
    active_users: activeUsers,
    engagement_rate: engagementRate,
    quality_score: qualityScore,
    over18: d.over18 === true,
    created_utc: d.created_utc || 0,
    url: `https://reddit.com/r/${d.display_name}`,
    icon: d.icon_img || d.community_icon || null,
  };
}

function formatDbRow(r) {
  return {
    name: r.display_name || r.name,
    title: r.display_name || r.name,
    description: r.description || "",
    subscribers: r.subscribers || 0,
    active_users: r.active_users || 0,
    engagement_rate: 0,
    quality_score: r.subscribers || 0,
    over18: r.over18 === 1,
    growth_pct: parseFloat((r.growth_pct || 0).toFixed(2)),
    captured_at: r.captured_at,
    url: `https://reddit.com/r/${r.display_name || r.name}`,
  };
}

function scoreToStars(score, maxScore) {
  if (!maxScore) return "⭐";
  const r = score / maxScore;
  if (r >= 0.85) return "⭐⭐⭐⭐⭐";
  if (r >= 0.65) return "⭐⭐⭐⭐";
  if (r >= 0.45) return "⭐⭐⭐";
  if (r >= 0.25) return "⭐⭐";
  return "⭐";
}

function wantsNsfw(req) {
  return req.query.nsfw === "1";
}
function filterNsfw(items, nsfw) {
  if (nsfw) return items;
  return items.filter((d) => d.over18 !== true);
}

function sortByQuality(items) {
  return [...items].sort(
    (a, b) => (b.quality_score || 0) - (a.quality_score || 0),
  );
}

// ─── Data refresh ─────────────────────────────────────────────────────────────
async function refreshData() {
  console.log("[cron] Refreshing subreddit data...");
  try {
    const [trending, newSubs, rising] = await Promise.all([
      reddit.fetchTrending(50),
      reddit.fetchNew(25),
      reddit.fetchRising(25),
    ]);
    const all = [...trending, ...newSubs, ...rising];
    saveSubredditData(all);
    bustCache();
    console.log(`[cron] Saved ${all.length} snapshots`);
  } catch (err) {
    console.error("[cron] Error:", err.message);
  }
}

cron.schedule("*/30 * * * *", refreshData);
refreshData();

// ═══════════════════════════════════════════════════════════════════════════════
// SUBREDDIT TRACKING ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

app.get("/api/trending", async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 100, 100);
    const nsfw = wantsNsfw(req);
    let data, source;
    if (nsfw) {
      const live = await reddit.fetchNsfwTrending(limit * 2);
      data = sortByQuality(live.map(formatSub));
      source = "live";
    } else {
      const rows = stmts.getTrending.all(limit * 3);
      if (rows.length === 0) {
        const live = await reddit.fetchTrending(limit * 2);
        data = sortByQuality(live.map(formatSub));
        source = "live";
      } else {
        data = rows.map(formatDbRow);
        source = "db";
      }
    }
    res.json({ source, data: filterNsfw(data, nsfw).slice(0, limit) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/rising", async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 100, 100);
    const nsfw = wantsNsfw(req);
    if (nsfw) {
      const live = await reddit.fetchNsfwRising(limit);
      return res.json({
        source: "live",
        data: sortByQuality(live.map(formatSub)),
      });
    }
    const rows = stmts.getRising.all(limit * 3);
    if (rows.length === 0) {
      const live = await reddit.fetchRising(limit * 2);
      return res.json({
        source: "live",
        data: sortByQuality(filterNsfw(live.map(formatSub), false)).slice(
          0,
          limit,
        ),
      });
    }
    res.json({
      source: "db",
      data: filterNsfw(rows.map(formatDbRow), false).slice(0, limit),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/new", async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 100, 100);
    const nsfw = wantsNsfw(req);
    if (nsfw) {
      const live = await reddit.fetchNsfwNew(limit);
      return res.json({
        source: "live",
        data: sortByQuality(live.map(formatSub)),
      });
    }
    const live = await reddit.fetchNew(limit);
    res.json({ source: "live", data: sortByQuality(live.map(formatSub)) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/unmoderated", async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 100, 100);
    const nsfw = wantsNsfw(req);
    if (nsfw) {
      const live = await reddit.fetchNsfwUnmoderated(limit);
      return res.json({
        source: "live",
        data: sortByQuality(live.map(formatSub)),
      });
    }
    const live = await reddit.fetchUnmoderated(limit);
    res.json({ source: "live", data: sortByQuality(live.map(formatSub)) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/search", async (req, res) => {
  try {
    const q = req.query.q;
    if (!q) return res.status(400).json({ error: "q param required" });
    const nsfw = wantsNsfw(req);
    const tab = req.query.tab || "trending";
    const sortMap = { trending: "relevance", rising: "activity", new: "new" };
    const sort = sortMap[tab] || "relevance";
    const results = await reddit.searchSubreddits(q, 25, nsfw, sort);
    let filtered = filterNsfw(results.map(formatSub), nsfw);
    if (tab === "new") filtered = filtered.filter((d) => d.subscribers >= 5000);
    res.json({ data: sortByQuality(filtered).slice(0, 15) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/subreddit/:name", async (req, res) => {
  try {
    const name = req.params.name.toLowerCase();
    const since = Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60;
    const history = stmts.getGrowthData.all(name, since);
    const live = await reddit.getSubreddit(name);
    res.json({
      subreddit: formatSub(live),
      history: history.map((h) => ({
        subscribers: h.subscribers,
        active_users: h.active_users,
        captured_at: h.captured_at,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/stats", (req, res) => {
  res.json({ last_refresh: cache["ts"] || null });
});

app.get("/api/user-ranking", async (req, res) => {
  const username = req.query.user;
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  if (!username) return res.status(400).json({ error: "user param required" });
  try {
    const data = await reddit.redditGet(
      `/user/${encodeURIComponent(username)}/submitted`,
      { sort: "new", limit: 100, t: "all" },
    );
    const posts = data.data.children.map((c) => c.data);
    if (!posts.length) return res.json({ data: [] });
    const scores = {};
    for (const p of posts) {
      const sub = p.subreddit;
      if (!scores[sub])
        scores[sub] = { score: 0, posts: 0, upvotes: 0, comments: 0 };
      scores[sub].score += p.score + p.num_comments;
      scores[sub].posts += 1;
      scores[sub].upvotes += p.score;
      scores[sub].comments += p.num_comments;
    }
    const maxScore = Math.max(...Object.values(scores).map((s) => s.score));
    const ranked = Object.entries(scores)
      .sort((a, b) => b[1].score - a[1].score)
      .slice(0, limit)
      .map(([subreddit, d]) => ({
        subreddit,
        score: d.score,
        posts: d.posts,
        upvotes: d.upvotes,
        comments: d.comments,
        stars: scoreToStars(d.score, maxScore),
      }));
    res.json({ data: ranked });
  } catch (err) {
    const status = err.response?.status;
    if (status === 403 || status === 404)
      return res.status(200).json({
        banned: true,
        error: `The account u/${username} appears to be banned, suspended, or does not exist.`,
      });
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/user-monthly", async (req, res) => {
  const username = req.query.user;
  const months = parseFloat(req.query.months) || 1;
  const limit = Math.min(parseInt(req.query.limit) || 500, 1000);
  if (!username) return res.status(400).json({ error: "user param required" });
  const cutoff = Math.floor(Date.now() / 1000) - months * 30 * 24 * 3600;
  try {
    const posts = [];
    let after = null;
    while (posts.length < limit) {
      const params = { sort: "new", limit: 100, t: "all" };
      if (after) params.after = after;
      const data = await reddit.redditGet(
        `/user/${encodeURIComponent(username)}/submitted`,
        params,
      );
      const children = data.data.children;
      if (!children.length) break;
      let hitCutoff = false;
      for (const c of children) {
        const p = c.data;
        if (p.created_utc < cutoff) {
          hitCutoff = true;
          break;
        }
        posts.push(p);
      }
      after = data.data.after;
      if (!after || hitCutoff) break;
    }
    if (!posts.length) return res.json({ data: [] });
    const scores = {};
    for (const p of posts) {
      const sub = p.subreddit;
      if (!scores[sub])
        scores[sub] = { score: 0, posts: 0, upvotes: 0, comments: 0 };
      scores[sub].score += p.score + p.num_comments;
      scores[sub].posts += 1;
      scores[sub].upvotes += p.score;
      scores[sub].comments += p.num_comments;
    }
    const maxScore = Math.max(...Object.values(scores).map((s) => s.score));
    const ranked = Object.entries(scores)
      .sort((a, b) => b[1].score - a[1].score)
      .map(([subreddit, d]) => ({
        subreddit,
        score: d.score,
        posts: d.posts,
        upvotes: d.upvotes,
        comments: d.comments,
        stars: scoreToStars(d.score, maxScore),
      }));
    res.json({ data: ranked });
  } catch (err) {
    const status = err.response?.status;
    if (status === 403 || status === 404)
      return res.status(200).json({
        banned: true,
        error: `The account u/${username} appears to be banned, suspended, or does not exist.`,
      });
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/sub-post-timing", async (req, res) => {
  const subName = req.query.sub;
  const tzName = req.query.tz || "Asia/Manila";
  const limit = Math.min(parseInt(req.query.limit) || 500, 1000);
  if (!subName) return res.status(400).json({ error: "sub param required" });
  const now = Math.floor(Date.now() / 1000);
  const weekCutoff = now - 7 * 24 * 3600;
  const monthCutoff = now - 30 * 24 * 3600;
  try {
    const posts = [];
    let after = null;
    while (posts.length < limit) {
      const params = { limit: 100 };
      if (after) params.after = after;
      const data = await reddit.redditGet(
        `/r/${encodeURIComponent(subName)}/new`,
        params,
      );
      const children = data.data.children;
      if (!children.length) break;
      let hitCutoff = false;
      for (const c of children) {
        const p = c.data;
        if (p.created_utc < monthCutoff) {
          hitCutoff = true;
          break;
        }
        posts.push(p);
      }
      after = data.data.after;
      if (!after || hitCutoff) break;
    }
    function bucketPosts(cutoff) {
      const byDay = {};
      for (const p of posts) {
        if (p.created_utc < cutoff) continue;
        const date = new Date(p.created_utc * 1000);
        const dayStr = date.toLocaleDateString("en-US", {
          timeZone: tzName,
          weekday: "long",
        });
        const hourStr = date.toLocaleTimeString("en-US", {
          timeZone: tzName,
          hour: "2-digit",
          hour12: false,
        });
        const hour = parseInt(hourStr.split(":")[0]) % 24;
        if (!byDay[dayStr]) byDay[dayStr] = {};
        byDay[dayStr][hour] =
          (byDay[dayStr][hour] || 0) + p.score + p.num_comments;
      }
      return byDay;
    }
    res.json({
      data: { week: bucketPosts(weekCutoff), month: bucketPosts(monthCutoff) },
      meta: { sub: subName, tz: tzName, posts_scanned: posts.length },
    });
  } catch (err) {
    const status = err.response?.status;
    if (status === 403 || status === 404)
      return res.status(200).json({
        data: { week: {}, month: {} },
        meta: { sub: subName, tz: tzName, posts_scanned: 0 },
        warning: "This subreddit is private, quarantined, or age-restricted.",
      });
    if (status === 429)
      return res.status(200).json({
        data: { week: {}, month: {} },
        meta: { sub: subName, tz: tzName, posts_scanned: 0 },
        warning:
          "Reddit rate limit hit — please wait a few seconds and try again.",
      });
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/sub-engagement", async (req, res) => {
  const subName = req.query.sub;
  if (!subName) return res.status(400).json({ error: "sub param required" });
  try {
    const [about, hotData] = await Promise.all([
      reddit.getSubreddit(subName),
      reddit.getSubEngagement(subName, 25),
    ]);
    const subscribers = about.subscribers || 0;
    const over18 = about.over18 === true;
    const avgScore = hotData?.avgScore || 0;
    const avgComments = hotData?.avgComments || 0;
    const engagementRate =
      subscribers > 0 && avgScore > 0
        ? parseFloat(((avgScore / subscribers) * 100 * 10).toFixed(3))
        : 0;
    let safetyScore = 50;
    if (subscribers < 5000) safetyScore += 30;
    else if (subscribers < 50000) safetyScore += 20;
    else if (subscribers < 200000) safetyScore += 10;
    else if (subscribers < 500000) safetyScore += 0;
    else if (subscribers < 1000000) safetyScore -= 10;
    else safetyScore -= 20;
    if (avgScore > 500) safetyScore += 15;
    else if (avgScore > 100) safetyScore += 10;
    else if (avgScore > 20) safetyScore += 5;
    else safetyScore -= 5;
    if (over18) safetyScore += 10;
    safetyScore = Math.max(0, Math.min(100, safetyScore));
    let safetyLabel, safetyColor;
    if (safetyScore >= 75) {
      safetyLabel = "Great for new accounts";
      safetyColor = "green";
    } else if (safetyScore >= 55) {
      safetyLabel = "Good for new accounts";
      safetyColor = "blue";
    } else if (safetyScore >= 40) {
      safetyLabel = "Moderate — proceed with care";
      safetyColor = "amber";
    } else {
      safetyLabel = "Risky — high karma required";
      safetyColor = "red";
    }
    res.json({
      sub: subName,
      subscribers,
      over18,
      avg_score: avgScore,
      avg_comments: avgComments,
      engagement_rate: engagementRate,
      newcomer_safety: {
        score: safetyScore,
        label: safetyLabel,
        color: safetyColor,
      },
      hot_posts: hotData || null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/hot-analysis", async (req, res) => {
  const subName = req.query.sub;
  if (!subName) return res.status(400).json({ error: "sub param required" });
  try {
    const [about, hotData] = await Promise.all([
      reddit.getSubreddit(subName),
      reddit.getSubEngagement(subName, 25),
    ]);
    const subscribers = about.subscribers || 0;
    const avgScore = hotData?.avgScore || 0;
    const avgComments = hotData?.avgComments || 0;
    const ratio = subscribers > 0 ? (avgScore / subscribers) * 1000 : 0;
    let quality, qualityColor;
    if (ratio > 5) {
      quality = "Exceptional — very high engagement";
      qualityColor = "green";
    } else if (ratio > 1) {
      quality = "Good — solid engagement rate";
      qualityColor = "blue";
    } else if (ratio > 0.3) {
      quality = "Average — moderate engagement";
      qualityColor = "amber";
    } else {
      quality = "Low — possible bot-heavy or inactive audience";
      qualityColor = "red";
    }
    res.json({
      sub: subName,
      subscribers,
      avg_score: avgScore,
      avg_comments: avgComments,
      engagement_ratio: parseFloat(ratio.toFixed(4)),
      quality,
      quality_color: qualityColor,
      recommended: ratio > 0.3 && avgScore > 10,
      posts_analyzed: hotData?.postsAnalyzed || 0,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// POSTING INTELLIGENCE ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

app.post("/api/intel/auth", async (req, res) => {
  const { pin } = req.body;
  if (!pin) return res.status(400).json({ error: "PIN required" });
  const { data, error } = await supabase
    .from("vas")
    .select("id, name, created_at")
    .eq("pin", pin)
    .single();
  if (error || !data) return res.status(401).json({ error: "Invalid PIN" });
  res.json({ va: data });
});

app.get("/api/intel/vas", async (req, res) => {
  const { data, error } = await supabase
    .from("vas")
    .select("id, name, created_at")
    .order("name");
  if (error) return res.status(500).json({ error: error.message });
  res.json({ data });
});

app.post("/api/intel/vas", async (req, res) => {
  const { name, pin } = req.body;
  if (!name || !pin)
    return res.status(400).json({ error: "name and pin required" });
  const { data, error } = await supabase
    .from("vas")
    .insert({ name, pin })
    .select("id, name")
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ va: data });
});

app.get("/api/intel/models", async (req, res) => {
  const { va_id } = req.query;
  let query = supabase
    .from("models")
    .select(
      `id, model_name, va_id, created_at, vas(name), reddit_accounts(id, username, is_active, banned)`,
    )
    .order("model_name");
  if (va_id) query = query.eq("va_id", va_id);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ data });
});

app.post("/api/intel/models", async (req, res) => {
  const { va_id, model_name } = req.body;
  if (!va_id || !model_name)
    return res.status(400).json({ error: "va_id and model_name required" });
  const { data, error } = await supabase
    .from("models")
    .insert({ va_id, model_name })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ model: data });
});

app.delete("/api/intel/models/:id", async (req, res) => {
  const { error } = await supabase
    .from("models")
    .delete()
    .eq("id", req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

app.post("/api/intel/accounts", async (req, res) => {
  const { model_id, username } = req.body;
  if (!model_id || !username)
    return res.status(400).json({ error: "model_id and username required" });
  const { data, error } = await supabase
    .from("reddit_accounts")
    .insert({ model_id, username })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ account: data });
});

app.delete("/api/intel/accounts/:id", async (req, res) => {
  const { error } = await supabase
    .from("reddit_accounts")
    .delete()
    .eq("id", req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

app.get("/api/intel/posts", async (req, res) => {
  const { va_id, account_id, limit = 100 } = req.query;
  let query = supabase
    .from("post_logs")
    .select(
      `id, subreddit, post_url, post_title, posted_at, upvotes, comments, reached_hot, hot_rank, hot_duration_hours, notes, created_at, reddit_accounts(username, model_id, models(model_name, va_id, vas(name)))`,
    )
    .order("posted_at", { ascending: false })
    .limit(parseInt(limit));
  if (account_id) query = query.eq("account_id", account_id);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  let filtered = data;
  if (va_id)
    filtered = data.filter((p) => p.reddit_accounts?.models?.va_id === va_id);
  res.json({ data: filtered });
});

app.post("/api/intel/posts", async (req, res) => {
  const {
    account_id,
    subreddit,
    post_url,
    post_title,
    posted_at,
    upvotes,
    comments,
    reached_hot,
    hot_rank,
    hot_reached_at,
    hot_duration_hours,
    notes,
  } = req.body;
  if (!account_id || !subreddit)
    return res.status(400).json({ error: "account_id and subreddit required" });
  const { data, error } = await supabase
    .from("post_logs")
    .insert({
      account_id,
      subreddit: subreddit.toLowerCase().replace(/^r\//, ""),
      post_url,
      post_title,
      posted_at: posted_at || new Date().toISOString(),
      upvotes: upvotes || 0,
      comments: comments || 0,
      reached_hot: reached_hot || false,
      hot_rank,
      hot_reached_at,
      hot_duration_hours,
      notes,
    })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ post: data });
});

app.put("/api/intel/posts/:id", async (req, res) => {
  const {
    upvotes,
    comments,
    reached_hot,
    hot_rank,
    hot_reached_at,
    hot_duration_hours,
    notes,
  } = req.body;
  const { data, error } = await supabase
    .from("post_logs")
    .update({
      upvotes,
      comments,
      reached_hot,
      hot_rank,
      hot_reached_at,
      hot_duration_hours,
      notes,
    })
    .eq("id", req.params.id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ post: data });
});

app.delete("/api/intel/posts/:id", async (req, res) => {
  const { error } = await supabase
    .from("post_logs")
    .delete()
    .eq("id", req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ─── FIX #4: check-overlap uses Manila midnight ───────────────────────────────
app.get("/api/intel/check-overlap", async (req, res) => {
  const { subreddit, model_id } = req.query;
  if (!subreddit || !model_id)
    return res.status(400).json({ error: "subreddit and model_id required" });
  const sub = subreddit.toLowerCase().replace(/^r\//, "");
  const todayStart = getManilaMidnight(); // FIX
  const { data: accounts } = await supabase
    .from("reddit_accounts")
    .select("id, username")
    .eq("model_id", model_id);
  if (!accounts?.length) return res.json({ overlap: false });
  const { data: posts } = await supabase
    .from("post_logs")
    .select("id, account_id, reddit_accounts(username)")
    .in(
      "account_id",
      accounts.map((a) => a.id),
    )
    .eq("subreddit", sub)
    .gte("posted_at", todayStart.toISOString());
  if (posts?.length)
    return res.json({
      overlap: true,
      used_by: posts.map((p) => p.reddit_accounts?.username).filter(Boolean),
    });
  res.json({ overlap: false });
});

app.get("/api/intel/ratings", async (req, res) => {
  const { data, error } = await supabase
    .from("subreddit_ratings")
    .select("*, vas(name)")
    .order("updated_at", { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ data });
});

app.get("/api/intel/ratings/:sub", async (req, res) => {
  const sub = req.params.sub.toLowerCase().replace(/^r\//, "");
  const { data } = await supabase
    .from("subreddit_ratings")
    .select("*")
    .eq("subreddit", sub)
    .single();
  res.json({ rating: data || null });
});

app.post("/api/intel/ratings", async (req, res) => {
  const { subreddit, rating, reason, va_id } = req.body;
  if (!subreddit || !rating)
    return res.status(400).json({ error: "subreddit and rating required" });
  const sub = subreddit.toLowerCase().replace(/^r\//, "");
  const isNsfw = req.body.is_nsfw ?? false;
  const { data, error } = await supabase
    .from("subreddit_ratings")
    .upsert(
      {
        subreddit: sub,
        rating,
        reason,
        classified_by: va_id,
        is_nsfw: isNsfw,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "subreddit" },
    )
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ rating: data });
});

app.delete("/api/intel/ratings/:sub", async (req, res) => {
  const sub = req.params.sub.toLowerCase().replace(/^r\//, "");
  const { error } = await supabase
    .from("subreddit_ratings")
    .delete()
    .eq("subreddit", sub);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ─── Sync account ─────────────────────────────────────────────────────────────
app.post("/api/intel/sync-account", async (req, res) => {
  const { account_id, username } = req.body;
  if (!account_id || !username)
    return res.status(400).json({ error: "account_id and username required" });

  try {
    const posts = [];
    const seenIds = new Set();

    // ── Source 1: Profile listing (respects curation — may be incomplete) ──
    // Paginate up to 3 pages × 100 = 300 posts
    let profileFailed = false;
    try {
      let after = null;
      for (let page = 0; page < 3; page++) {
        const params = { sort: "new", limit: 100, t: "month" };
        if (after) params.after = after;
        const data = await reddit.redditGet(
          `/user/${encodeURIComponent(username)}/submitted`,
          params,
        );
        const children = data?.data?.children || [];
        if (!children.length) break;
        for (const child of children) {
          const p = child.data;
          if (p.id && !seenIds.has(p.id)) {
            seenIds.add(p.id);
            posts.push(p);
          }
        }
        after = data?.data?.after;
        if (!after) break; // no more pages
      }
    } catch (err) {
      const status = err.response?.status;
      if (status === 403 || status === 404) {
        // Account is banned/suspended
        await supabase
          .from("reddit_accounts")
          .update({ is_active: false, banned: true })
          .eq("id", account_id);
        return res.json({
          banned: true,
          error: `u/${username} appears to be banned or suspended.`,
        });
      }
      profileFailed = true;
      console.warn(`[sync] Profile fetch failed for ${username}:`, err.message);
    }

    // ── Source 2: Search by author (catches curated/hidden posts) ──
    // Paginate up to 5 pages × 100 = 500 posts searched
    // Reddit search ignores profile curation — posts still appear here
    // even when hidden from the user's profile page
    try {
      let after = null;
      for (let page = 0; page < 5; page++) {
        const params = {
          q: `author:${username}`,
          sort: "new",
          type: "link",
          limit: 100,
          t: "month",
        };
        if (after) params.after = after;
        const data = await reddit.redditGet("/search", params);
        const children = data?.data?.children || [];
        if (!children.length) break;
        let newOnThisPage = 0;
        for (const child of children) {
          const p = child.data;
          // Verify author matches (search can return fuzzy results)
          if (
            p.id &&
            !seenIds.has(p.id) &&
            p.author?.toLowerCase() === username.toLowerCase()
          ) {
            seenIds.add(p.id);
            posts.push(p);
            newOnThisPage++;
          }
        }
        after = data?.data?.after;
        // Stop if no new posts on this page or no more pages
        if (!after || newOnThisPage === 0) break;
      }
    } catch (err) {
      console.warn(`[sync] Search fetch failed for ${username}:`, err.message);
      // Don't fail the whole sync if search fails — profile data is still useful
    }

    if (!posts.length && profileFailed) {
      return res
        .status(500)
        .json({ error: `Could not fetch posts for u/${username}` });
    }

    // ── Upsert all collected posts ──
    let synced = 0;
    for (const p of posts) {
      const sub = p.subreddit.toLowerCase();
      const postedAt = new Date(p.created_utc * 1000).toISOString();

      const { data: existing } = await supabase
        .from("post_logs")
        .select("id")
        .eq("account_id", account_id)
        .eq("subreddit", sub)
        .eq("posted_at", postedAt)
        .maybeSingle();

      if (existing) {
        // Update metrics on existing posts (upvotes/comments change over time)
        await supabase
          .from("post_logs")
          .update({
            upvotes: p.score,
            comments: p.num_comments,
            post_url: `https://reddit.com${p.permalink}`,
            post_title: p.title,
            updated_at: new Date().toISOString(),
          })
          .eq("id", existing.id);
      } else {
        await supabase.from("post_logs").insert({
          account_id,
          subreddit: sub,
          post_url: `https://reddit.com${p.permalink}`,
          post_title: p.title,
          posted_at: postedAt,
          upvotes: p.score || 0,
          comments: p.num_comments || 0,
          updated_at: new Date().toISOString(),
        });
        synced++;
      }
    }

    await autoEvalSubreddits(posts);

    res.json({
      success: true,
      synced,
      total: posts.length,
    });
  } catch (err) {
    const status = err.response?.status;
    if (status === 403 || status === 404) {
      await supabase
        .from("reddit_accounts")
        .update({ is_active: false, banned: true })
        .eq("id", account_id);
      return res.json({
        banned: true,
        error: `u/${username} appears to be banned or suspended.`,
      });
    }
    res.status(500).json({ error: err.message });
  }
});

// ─── Auto-eval ────────────────────────────────────────────────────────────────
async function autoEvalSubreddits(posts) {
  const bySubreddit = {};
  for (const p of posts) {
    const sub = p.subreddit.toLowerCase();
    if (!bySubreddit[sub]) bySubreddit[sub] = [];
    bySubreddit[sub].push(p);
  }
  for (const [sub, subPosts] of Object.entries(bySubreddit)) {
    if (subPosts.length < 1) continue;
    const avgScore =
      subPosts.reduce((s, p) => s + p.score, 0) / subPosts.length;
    const avgComments =
      subPosts.reduce((s, p) => s + p.num_comments, 0) / subPosts.length;
    let rating = "neutral",
      reason = "";
    if (avgScore >= 100 || avgComments >= 20) {
      rating = "good";
      reason = `Auto: Avg ${Math.round(avgScore)} upvotes, ${Math.round(avgComments)} comments`;
    } else if (avgScore < 10 && subPosts.length >= 2) {
      rating = "bad";
      reason = `Auto: Low engagement — avg ${Math.round(avgScore)} upvotes only`;
    }
    if (rating !== "neutral") {
      const isNsfw = subPosts.some((p) => p.over_18 === true);
      await supabase.from("subreddit_ratings").upsert(
        {
          subreddit: sub,
          rating,
          reason,
          is_nsfw: isNsfw,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "subreddit", ignoreDuplicates: false },
      );
    }
  }
}

// ─── FIX #1 & #4: Dashboard uses Manila midnight ──────────────────────────────
app.get("/api/intel/dashboard", async (req, res) => {
  const { va_id, admin } = req.query;
  if (!va_id) return res.status(400).json({ error: "va_id required" });
  try {
    let modelsQuery = supabase
      .from("models")
      .select(
        "id, model_name, reddit_accounts(id, username, is_active, banned)",
      );
    if (admin !== "true") modelsQuery = modelsQuery.eq("va_id", va_id);
    const { data: models } = await modelsQuery;
    const accountIds = (models || []).flatMap((m) =>
      (m.reddit_accounts || []).map((a) => a.id),
    );
    const today = getManilaMidnight(); // FIX: was new Date(); today.setHours(0,0,0,0)
    const { data: posts } =
      accountIds.length > 0
        ? await supabase
            .from("post_logs")
            .select("*")
            .in("account_id", accountIds)
            .order("posted_at", { ascending: false })
            .limit(1000)
        : { data: [] };
    const todayPosts = (posts || []).filter(
      (p) => new Date(p.posted_at) >= today,
    );
    const accountStats = {};
    for (const p of posts || []) {
      if (!accountStats[p.account_id])
        accountStats[p.account_id] = {
          posts: 0,
          totalUpvotes: 0,
          totalComments: 0,
        };
      accountStats[p.account_id].posts++;
      accountStats[p.account_id].totalUpvotes += p.upvotes || 0;
      accountStats[p.account_id].totalComments += p.comments || 0;
    }
    const subLastUsed = {};
    for (const p of posts || []) {
      if (
        !subLastUsed[p.subreddit] ||
        new Date(p.posted_at) > new Date(subLastUsed[p.subreddit].date)
      ) {
        subLastUsed[p.subreddit] = {
          date: p.posted_at,
          account_id: p.account_id,
        };
      }
    }
    const REUSE_DAYS = 3;
    const reuseLocks = [];
    for (const [sub, info] of Object.entries(subLastUsed)) {
      const daysSince =
        (Date.now() - new Date(info.date)) / (1000 * 60 * 60 * 24);
      const daysLeft = Math.max(0, REUSE_DAYS - daysSince);
      reuseLocks.push({
        subreddit: sub,
        last_used: info.date,
        days_since: parseFloat(daysSince.toFixed(1)),
        days_left: parseFloat(daysLeft.toFixed(1)),
        locked: daysLeft > 0,
      });
    }
    reuseLocks.sort((a, b) => a.days_left - b.days_left);
    const subEngagement = {};
    for (const p of posts || []) {
      if (!subEngagement[p.subreddit])
        subEngagement[p.subreddit] = { total: 0, count: 0 };
      subEngagement[p.subreddit].total += (p.upvotes || 0) + (p.comments || 0);
      subEngagement[p.subreddit].count++;
    }
    const topSub =
      Object.entries(subEngagement)
        .map(([sub, d]) => ({ sub, avg: d.total / d.count, count: d.count }))
        .sort((a, b) => b.avg - a.avg)[0] || null;
    res.json({
      models: models || [],
      today_posts: todayPosts,
      account_stats: accountStats,
      reuse_locks: reuseLocks,
      top_sub: topSub,
      all_posts: posts || [],
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── FIX #4: All-overview uses Manila midnight ────────────────────────────────
app.get("/api/intel/all-overview", async (req, res) => {
  try {
    const { data: vas } = await supabase
      .from("vas")
      .select("id, name")
      .order("name");
    const { data: models } = await supabase
      .from("models")
      .select(
        "id, model_name, va_id, reddit_accounts(id, username, is_active, banned)",
      );
    const { data: posts } = await supabase
      .from("post_logs")
      .select(
        "account_id, subreddit, upvotes, comments, posted_at, reddit_accounts(username, model_id, models(model_name, va_id))",
      )
      .order("posted_at", { ascending: false })
      .limit(1000);
    const vaStats = {};
    for (const va of vas || [])
      vaStats[va.id] = {
        name: va.name,
        posts: 0,
        totalEng: 0,
        subs: new Set(),
        models: [],
      };
    const subUsageToday = {};
    const today = getManilaMidnight(); // FIX
    for (const p of posts || []) {
      const vaId = p.reddit_accounts?.models?.va_id;
      if (vaId && vaStats[vaId]) {
        vaStats[vaId].posts++;
        vaStats[vaId].totalEng += (p.upvotes || 0) + (p.comments || 0);
        vaStats[vaId].subs.add(p.subreddit);
      }
      if (new Date(p.posted_at) >= today) {
        const sub = p.subreddit;
        if (!subUsageToday[sub]) subUsageToday[sub] = [];
        subUsageToday[sub].push({
          username: p.reddit_accounts?.username,
          model: p.reddit_accounts?.models?.model_name,
          va_id: p.reddit_accounts?.models?.va_id,
        });
      }
    }
    for (const m of models || []) {
      if (vaStats[m.va_id])
        vaStats[m.va_id].models.push({
          id: m.id,
          name: m.model_name,
          accounts: m.reddit_accounts || [],
        });
    }
    const vaList = Object.entries(vaStats).map(([id, d]) => ({
      id,
      name: d.name,
      posts: d.posts,
      avgEng: d.posts > 0 ? parseFloat((d.totalEng / d.posts).toFixed(1)) : 0,
      subsCount: d.subs.size,
      models: d.models,
    }));
    const flagged = Object.entries(subUsageToday)
      .filter(([, users]) => users.length > 1)
      .map(([sub, users]) => ({ subreddit: sub, used_by: users }));
    res.json({
      vas: vaList,
      flagged_today: flagged,
      sub_usage_today: subUsageToday,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Top subs ─────────────────────────────────────────────────────────────────
app.get("/api/intel/top-subs", async (req, res) => {
  try {
    const { from, to } = req.query;
    let postsQuery = supabase
      .from("post_logs")
      .select(
        "subreddit, upvotes, comments, posted_at, account_id, reddit_accounts(username, models(model_name, vas(name)))",
      )
      .order("posted_at", { ascending: false })
      .limit(2000);
    if (from)
      postsQuery = postsQuery.gte("posted_at", new Date(from).toISOString());
    if (to)
      postsQuery = postsQuery.lte(
        "posted_at",
        new Date(to + "T23:59:59").toISOString(),
      );
    const { data: posts } = await postsQuery;
    const subStats = {};
    for (const p of posts || []) {
      const sub = p.subreddit;
      if (!subStats[sub])
        subStats[sub] = {
          sub,
          totalEng: 0,
          totalUpvotes: 0,
          totalComments: 0,
          count: 0,
          highEng: 0,
          vas: new Set(),
        };
      const eng = (p.upvotes || 0) + (p.comments || 0);
      subStats[sub].totalEng += eng;
      subStats[sub].totalUpvotes += p.upvotes || 0;
      subStats[sub].totalComments += p.comments || 0;
      subStats[sub].count++;
      if (eng > subStats[sub].highEng) subStats[sub].highEng = eng;
      const va = p.reddit_accounts?.models?.vas?.name;
      if (va) subStats[sub].vas.add(va);
    }
    const ranked = Object.values(subStats)
      .filter((s) => s.count >= 1)
      .map((s) => ({
        sub: s.sub,
        avg_engagement: parseFloat((s.totalEng / s.count).toFixed(1)),
        avg_upvotes: parseFloat((s.totalUpvotes / s.count).toFixed(1)),
        avg_comments: parseFloat((s.totalComments / s.count).toFixed(1)),
        peak_engagement: s.highEng,
        post_count: s.count,
        used_by_vas: [...s.vas],
        score: Math.round((s.totalEng / s.count) * Math.log(s.count + 1)),
      }))
      .sort((a, b) => b.score - a.score);
    const { data: ratingsMap } = await supabase
      .from("subreddit_ratings")
      .select("subreddit, is_nsfw");
    const nsfwLookup = {};
    for (const r of ratingsMap || [])
      nsfwLookup[r.subreddit] = r.is_nsfw === true;
    ranked.forEach((s) => {
      s.is_nsfw = nsfwLookup[s.sub] || false;
    });
    const { data: badRatings } = await supabase
      .from("subreddit_ratings")
      .select("subreddit, reason, updated_at, is_nsfw")
      .eq("rating", "bad")
      .order("updated_at", { ascending: false })
      .limit(20);
    const { data: bannedAccounts } = await supabase
      .from("reddit_accounts")
      .select("id, username, model_id, models(model_name, vas(name))")
      .eq("banned", true);
    const bannedWithLastSub = [];
    for (const acct of bannedAccounts || []) {
      const { data: lastPost } = await supabase
        .from("post_logs")
        .select("subreddit, posted_at")
        .eq("account_id", acct.id)
        .order("posted_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      bannedWithLastSub.push({
        id: acct.id,
        username: acct.username,
        model: acct.models?.model_name,
        va: acct.models?.vas?.name,
        last_sub: lastPost?.subreddit || null,
        last_posted: lastPost?.posted_at || null,
      });
    }
    res.json({
      top: ranked.slice(0, 50),
      consistent: ranked.filter((s) => s.post_count >= 3).slice(0, 5),
      risky: badRatings || [],
      banned_accounts: bannedWithLastSub,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Manual post logger ───────────────────────────────────────────────────────
app.post("/api/intel/log-post", async (req, res) => {
  const { url, va_id } = req.body;
  if (!url) return res.status(400).json({ error: "url required" });

  try {
    // Parse post ID from any Reddit URL format:
    //   https://reddit.com/r/cats/comments/abc123/title/
    //   https://www.reddit.com/r/cats/comments/abc123/
    const match = url.match(/reddit\.com\/r\/[^/]+\/comments\/([a-z0-9]+)/i);
    if (!match)
      return res.status(400).json({
        error:
          "Could not parse Reddit post URL. Make sure it contains /comments/{id}.",
      });
    const postId = match[1];

    // Fetch post data from Reddit API
    const apiData = await reddit.redditGet("/api/info", { id: `t3_${postId}` });
    const children = apiData?.data?.children || [];
    if (!children.length)
      return res.status(404).json({ error: "Post not found or removed." });

    const post = children[0].data;
    const author = post.author?.toLowerCase();
    const subreddit = post.subreddit?.toLowerCase();
    const postedAt = new Date(post.created_utc * 1000).toISOString();

    if (!author || author === "[deleted]")
      return res
        .status(400)
        .json({ error: "Post author is deleted or unavailable." });

    // Skip user-profile subs (r/u_username)
    if (subreddit?.startsWith("u_"))
      return res
        .status(400)
        .json({ error: "This is a user profile post, not a community post." });

    // Find matching account by author username (case-insensitive)
    const { data: account } = await supabase
      .from("reddit_accounts")
      .select("id, username, model_id, models(model_name, va_id, vas(name))")
      .ilike("username", author)
      .maybeSingle();

    if (!account)
      return res.status(404).json({
        error: `u/${post.author} is not registered in SubTracker. Add the account in Setup first.`,
        author: post.author,
        subreddit: post.subreddit,
      });

    // VA ownership check — non-admin VAs can only log their own accounts
    if (va_id && account.models?.va_id !== va_id) {
      return res.status(403).json({
        error: `@${post.author} belongs to another VA. You can only log posts from your own accounts.`,
      });
    }

    // Check for duplicate
    const { data: existing } = await supabase
      .from("post_logs")
      .select("id, upvotes, comments")
      .eq("account_id", account.id)
      .eq("subreddit", subreddit)
      .eq("posted_at", postedAt)
      .maybeSingle();

    if (existing) {
      // Update metrics if already exists
      await supabase
        .from("post_logs")
        .update({
          upvotes: post.score,
          comments: post.num_comments,
          post_url: `https://reddit.com${post.permalink}`,
          post_title: post.title,
        })
        .eq("id", existing.id);

      return res.json({
        duplicate: true,
        message: `Already logged. Metrics updated: ${post.score} upvotes, ${post.num_comments} comments.`,
        post: {
          subreddit: post.subreddit,
          title: post.title,
          upvotes: post.score,
          comments: post.num_comments,
          author: post.author,
          account_id: account.id,
          posted_at: postedAt,
        },
      });
    }

    // Insert new post log
    const { data: inserted, error: insertErr } = await supabase
      .from("post_logs")
      .insert({
        account_id: account.id,
        subreddit,
        post_url: `https://reddit.com${post.permalink}`,
        post_title: post.title,
        posted_at: postedAt,
        upvotes: post.score || 0,
        comments: post.num_comments || 0,
      })
      .select()
      .single();

    if (insertErr) return res.status(500).json({ error: insertErr.message });

    // Auto-eval this subreddit based on the new post
    await autoEvalSubreddits([post]);

    res.json({
      success: true,
      message: `Logged r/${post.subreddit} post by @${post.author}`,
      post: {
        subreddit: post.subreddit,
        title: post.title,
        upvotes: post.score,
        comments: post.num_comments,
        author: post.author,
        account_id: account.id,
        model: account.models?.model_name,
        va: account.models?.vas?.name,
        posted_at: postedAt,
        post_url: `https://reddit.com${post.permalink}`,
      },
    });
  } catch (err) {
    const status = err.response?.status;
    if (status === 404)
      return res.status(404).json({ error: "Post not found." });
    if (status === 403)
      return res
        .status(403)
        .json({ error: "This post is in a private or restricted subreddit." });
    res.status(500).json({ error: err.message });
  }
});

// ─── Scheduler uses Manila midnight ───────────────────────────────────
app.get("/api/intel/scheduler", async (req, res) => {
  const { va_id } = req.query;
  if (!va_id) return res.status(400).json({ error: "va_id required" });
  try {
    const { data: models } = await supabase
      .from("models")
      .select("id, model_name, reddit_accounts(id, username, banned)")
      .eq("va_id", va_id);
    const accountIds = (models || []).flatMap((m) =>
      (m.reddit_accounts || []).map((a) => a.id),
    );
    if (!accountIds.length)
      return res.json({
        recommendations: [],
        day: "",
        already_posted_today: [],
      });
    const { data: posts } = await supabase
      .from("post_logs")
      .select("subreddit, upvotes, comments, posted_at, account_id")
      .in("account_id", accountIds)
      .order("posted_at", { ascending: false })
      .limit(2000);
    const dayName = new Date().toLocaleDateString("en-US", {
      weekday: "long",
      timeZone: "Asia/Manila",
    });
    const todayStart = getManilaMidnight(); // FIX
    const subStats = {};
    for (const p of posts || []) {
      const sub = p.subreddit;
      if (!subStats[sub]) subStats[sub] = { total: 0, count: 0 };
      subStats[sub].total += (p.upvotes || 0) + (p.comments || 0);
      subStats[sub].count++;
    }
    const todayPosts = (posts || []).filter(
      (p) => new Date(p.posted_at) >= todayStart,
    );
    const postedTodaySubs = new Set(todayPosts.map((p) => p.subreddit));
    const recommendations = Object.entries(subStats)
      .map(([sub, s]) => ({
        sub,
        avg_engagement: parseFloat((s.total / s.count).toFixed(1)),
        post_count: s.count,
        already_posted_today: postedTodaySubs.has(sub),
      }))
      .sort((a, b) => b.avg_engagement - a.avg_engagement)
      .slice(0, 40);
    res.json({
      recommendations,
      day: dayName,
      already_posted_today: [...postedTodaySubs],
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Subs to try — NSFW now has SQLite fallback ───────────────────────
app.get("/api/intel/subs-to-try", async (req, res) => {
  const { va_id, nsfw = "0" } = req.query;
  if (!va_id) return res.status(400).json({ error: "va_id required" });
  try {
    const { data: models } = await supabase
      .from("models")
      .select("id, reddit_accounts(id)")
      .eq("va_id", va_id);
    const accountIds = (models || []).flatMap((m) =>
      (m.reddit_accounts || []).map((a) => a.id),
    );
    const alreadyPostedSubs = new Set();
    if (accountIds.length > 0) {
      const { data: postedPosts } = await supabase
        .from("post_logs")
        .select("subreddit")
        .in("account_id", accountIds);
      (postedPosts || []).forEach((p) =>
        alreadyPostedSubs.add(p.subreddit.toLowerCase()),
      );
    }
    const { data: badRatings } = await supabase
      .from("subreddit_ratings")
      .select("subreddit")
      .eq("rating", "bad");
    const badSubs = new Set((badRatings || []).map((r) => r.subreddit));
    const wantNsfw = nsfw === "1";
    let suggestions = [];

    if (wantNsfw) {
      // ── NSFW primary: live Reddit rising + new (same as main tracker) ──────
      // Prefer small-to-mid subs (5K–150K) with high engagement rate.
      // Filter out subs the VA has already posted in and bad-rated ones.
      try {
        const [risingRaw, newRaw] = await Promise.all([
          reddit.fetchNsfwRising(50),
          reddit.fetchNsfwNew(50),
        ]);
        const combined = [...risingRaw, ...newRaw].map(formatSub);
        const seen = new Set();
        suggestions = combined
          .filter((r) => {
            const name = (r.name || "").toLowerCase();
            if (seen.has(name)) return false;
            seen.add(name);
            const subs = r.subscribers || 0;
            if (subs < 5000 || subs > 150000) return false;
            if (alreadyPostedSubs.has(name)) return false;
            if (badSubs.has(name)) return false;
            return true;
          })
          .sort((a, b) => b.engagement_rate - a.engagement_rate)
          .slice(0, 40);
      } catch (err) {
        console.warn(
          "[subs-to-try] NSFW Reddit API failed, using ratings fallback:",
          err.message,
        );
        // ── Fallback: subreddit_ratings table ranked by post engagement ──────
        const { data: nsfwRated } = await supabase
          .from("subreddit_ratings")
          .select("subreddit, rating")
          .eq("is_nsfw", true)
          .neq("rating", "bad")
          .order("updated_at", { ascending: false });
        const { data: allPosts } = await supabase
          .from("post_logs")
          .select("subreddit, upvotes, comments")
          .order("posted_at", { ascending: false })
          .limit(2000);
        const subEngMap = {};
        const nsfwSubNames = new Set((nsfwRated || []).map((r) => r.subreddit));
        for (const p of allPosts || []) {
          const sub = p.subreddit.toLowerCase();
          if (!nsfwSubNames.has(sub)) continue;
          if (!subEngMap[sub]) subEngMap[sub] = { total: 0, count: 0 };
          subEngMap[sub].total += (p.upvotes || 0) + (p.comments || 0);
          subEngMap[sub].count++;
        }
        suggestions = (nsfwRated || [])
          .filter(
            (r) =>
              !alreadyPostedSubs.has(r.subreddit.toLowerCase()) &&
              !badSubs.has(r.subreddit),
          )
          .map((r) => {
            const eng = subEngMap[r.subreddit];
            const avgEng = eng ? eng.total / eng.count : 0;
            return {
              name: r.subreddit,
              subscribers: 0,
              active_users: 0,
              engagement_rate: parseFloat(avgEng.toFixed(1)),
              over18: true,
              description: `${r.rating} rated NSFW sub`,
              quality_score: avgEng,
            };
          })
          .sort((a, b) => b.engagement_rate - a.engagement_rate)
          .slice(0, 40);
      }
    } else {
      // ── SFW: SQLite trending/rising cache, cap at 150K subscribers ─────────
      const cached = stmts.getTrending.all(300);
      const risingRows = stmts.getRising ? stmts.getRising.all(150) : [];
      const combined = [...cached, ...risingRows];
      const seen = new Set();
      suggestions = combined
        .filter((r) => {
          const name = (r.display_name || r.name || "").toLowerCase();
          if (seen.has(name)) return false;
          seen.add(name);
          const isNsfw = r.over18 === 1 || r.over18 === true;
          if (isNsfw) return false;
          if (alreadyPostedSubs.has(name)) return false;
          if (badSubs.has(name)) return false;
          const subs = r.subscribers || 0;
          if (subs < 5000 || subs > 150000) return false; // cap 150K
          return true;
        })
        .map((r) => {
          const subs = r.subscribers || 0;
          const active = r.active_users || 0;
          const engRate =
            subs > 0 ? parseFloat(((active / subs) * 100).toFixed(3)) : 0;
          const qualityScore = subs * (1 + engRate * 2);
          return {
            name: r.display_name || r.name,
            subscribers: subs,
            active_users: active,
            engagement_rate: engRate,
            over18: false,
            description: r.description || "",
            quality_score: qualityScore,
          };
        })
        .sort((a, b) => b.quality_score - a.quality_score)
        .slice(0, 40);
    }

    res.json({ data: suggestions, excluded_count: alreadyPostedSubs.size });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── FIX #1 & #4: Post overview uses Manila midnight ─────────────────────────
app.get("/api/intel/post-overview", async (req, res) => {
  const { va_id, admin, days = "1" } = req.query;
  if (!va_id) return res.status(400).json({ error: "va_id required" });
  try {
    const daysBack = Math.min(parseInt(days) || 1, 30);
    // FIX: use Manila midnight, then subtract extra days if daysBack > 1
    const since = getManilaMidnight();
    if (daysBack > 1) since.setDate(since.getDate() - (daysBack - 1));
    let modelsQuery = supabase
      .from("models")
      .select(
        "id, model_name, va_id, reddit_accounts(id, username, banned), vas(name)",
      );
    if (admin !== "true") modelsQuery = modelsQuery.eq("va_id", va_id);
    const { data: models } = await modelsQuery;
    const accountMap = {};
    for (const m of models || []) {
      for (const a of m.reddit_accounts || []) {
        accountMap[a.id] = {
          username: a.username,
          model: m.model_name,
          va: m.vas?.name || "—",
        };
      }
    }
    const accountIds = Object.keys(accountMap);
    if (!accountIds.length) return res.json({ data: [] });
    const { data: posts } = await supabase
      .from("post_logs")
      .select(
        "id, account_id, subreddit, upvotes, comments, posted_at, post_url, post_title, updated_at",
      )
      .in("account_id", accountIds)
      .gte("posted_at", since.toISOString())
      .order("posted_at", { ascending: false })
      .limit(500);
    const enriched = (posts || []).map((p) => ({
      ...p,
      username: accountMap[p.account_id]?.username || "—",
      model: accountMap[p.account_id]?.model || "—",
      va: accountMap[p.account_id]?.va || "—",
    }));
    res.json({ data: enriched });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Engagement trend uses Manila midnight ────────────────────────────
app.get("/api/intel/engagement-trend", async (req, res) => {
  const { va_id, admin } = req.query;
  if (!va_id) return res.status(400).json({ error: "va_id required" });
  try {
    let modelsQuery = supabase
      .from("models")
      .select("id, reddit_accounts(id, banned)");
    if (admin !== "true") modelsQuery = modelsQuery.eq("va_id", va_id);
    const { data: models } = await modelsQuery;
    const accountIds = (models || []).flatMap((m) =>
      (m.reddit_accounts || []).map((a) => a.id),
    );
    if (!accountIds.length)
      return res.json({
        today: Array(24).fill(0),
        yesterday: Array(24).fill(0),
      });
    const todayStart = getManilaMidnight(); // FIX
    const yesterdayStart = new Date(todayStart);
    yesterdayStart.setDate(yesterdayStart.getDate() - 1);
    const twoDaysAgo = new Date(yesterdayStart);
    twoDaysAgo.setDate(twoDaysAgo.getDate() - 1);
    const { data: posts } = await supabase
      .from("post_logs")
      .select("upvotes, comments, posted_at")
      .in("account_id", accountIds)
      .gte("posted_at", twoDaysAgo.toISOString())
      .order("posted_at", { ascending: true });
    const today = Array(24).fill(0);
    const yesterday = Array(24).fill(0);
    for (const p of posts || []) {
      const d = new Date(p.posted_at);
      const eng = (p.upvotes || 0) + (p.comments || 0);
      // Use Manila hour for bucketing
      const h =
        parseInt(
          d
            .toLocaleTimeString("en-US", {
              timeZone: "Asia/Manila",
              hour: "2-digit",
              hour12: false,
            })
            .split(":")[0],
        ) % 24;
      if (d >= todayStart) today[h] += eng;
      else if (d >= yesterdayStart) yesterday[h] += eng;
    }
    res.json({ today, yesterday });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Sub score ────────────────────────────────────────────────────────────────
app.get("/api/intel/sub-score/:sub", async (req, res) => {
  const sub = req.params.sub.toLowerCase();
  try {
    const { data: posts } = await supabase
      .from("post_logs")
      .select("upvotes, comments, posted_at, reached_hot, hot_rank")
      .eq("subreddit", sub)
      .order("posted_at", { ascending: false })
      .limit(50);
    const hotData = await reddit.getSubEngagement(sub, 25).catch(() => null);
    const about = await reddit.getSubreddit(sub).catch(() => null);
    const avgEng = posts?.length
      ? posts.reduce((s, p) => s + (p.upvotes || 0) + (p.comments || 0), 0) /
        posts.length
      : 0;
    const hotPct = posts?.length
      ? (posts.filter((p) => p.reached_hot).length / posts.length) * 100
      : 0;
    const subscribers = about?.subscribers || 0;
    const ratio =
      subscribers > 0 && hotData?.avgScore
        ? (hotData.avgScore / subscribers) * 1000
        : 0;
    let score = 50;
    if (avgEng > 500) score += 20;
    else if (avgEng > 100) score += 10;
    else if (avgEng > 20) score += 5;
    else score -= 10;
    if (ratio > 5) score += 20;
    else if (ratio > 1) score += 10;
    else if (ratio < 0.3) score -= 15;
    if (hotPct > 50) score += 10;
    score = Math.max(0, Math.min(100, score));
    let label, color;
    if (score >= 75) {
      label = "Excellent";
      color = "green";
    } else if (score >= 55) {
      label = "Good";
      color = "blue";
    } else if (score >= 35) {
      label = "Average";
      color = "amber";
    } else {
      label = "Poor";
      color = "red";
    }
    const { data: rating } = await supabase
      .from("subreddit_ratings")
      .select("rating, reason")
      .eq("subreddit", sub)
      .maybeSingle();
    res.json({
      sub,
      score,
      label,
      color,
      post_count: posts?.length || 0,
      avg_engagement: parseFloat(avgEng.toFixed(1)),
      hot_rate: parseFloat(hotPct.toFixed(1)),
      engagement_ratio: parseFloat(ratio.toFixed(3)),
      rating: rating || null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── FIX #4: check-cross-overlap uses Manila midnight ────────────────────────
app.get("/api/intel/check-cross-overlap", async (req, res) => {
  const { subreddit } = req.query;
  if (!subreddit) return res.status(400).json({ error: "subreddit required" });
  const sub = subreddit.toLowerCase().replace(/^r\//, "");
  const today = getManilaMidnight(); // FIX
  const { data: posts } = await supabase
    .from("post_logs")
    .select(
      "account_id, reddit_accounts(username, models(model_name, vas(name)))",
    )
    .eq("subreddit", sub)
    .gte("posted_at", today.toISOString());
  const users = (posts || []).map((p) => ({
    username: p.reddit_accounts?.username,
    model: p.reddit_accounts?.models?.model_name,
    va: p.reddit_accounts?.models?.vas?.name,
  }));
  res.json({ overlap: users.length > 0, used_by: users });
});

app.get("/api/intel/check-username", async (req, res) => {
  const { username } = req.query;
  if (!username) return res.status(400).json({ error: "username required" });
  const { data } = await supabase
    .from("reddit_accounts")
    .select("id, username")
    .eq("username", username.replace(/^@/, ""))
    .maybeSingle();
  res.json({ exists: !!data });
});

app.patch("/api/intel/accounts/:id/status", async (req, res) => {
  const { banned } = req.body;
  const { data, error } = await supabase
    .from("reddit_accounts")
    .update({ banned: !!banned, is_active: !banned })
    .eq("id", req.params.id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ account: data });
});

// ─── Catch-all ────────────────────────────────────────────────────────────────
app.get("/{*path}", (req, res) => {
  res.sendFile(path.join(__dirname, "../frontend/public/index.html"));
});

app.listen(PORT, () => {
  console.log(`\n🚀 Reddit Tracker running at http://localhost:${PORT}`);
  console.log(`   API: http://localhost:${PORT}/api/trending\n`);
});
