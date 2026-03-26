require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const path = require('path');

const { saveSubredditData, stmts } = require('./db');
const reddit = require('./reddit');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../frontend/public')));

// ─── Helper Functions 

function formatSub(d) {
  return {
    name: d.display_name,
    title: d.title || d.display_name,
    description: d.public_description || '',
    subscribers: d.subscribers || 0,
    active_users: d.active_user_count || 0,
    over18: d.over18 || false,
    created_utc: d.created_utc || 0,
    url: `https://reddit.com/r/${d.display_name}`,
    icon: d.icon_img || d.community_icon || null,
  };
}

function formatDbRow(r) {
  return {
    name: r.display_name || r.name,
    title: r.display_name || r.name,
    description: r.description || '',
    subscribers: r.subscribers || 0,
    active_users: r.active_users || 0,
    over18: r.over18 === 1,
    growth_pct: parseFloat((r.growth_pct || 0).toFixed(2)),
    captured_at: r.captured_at,
    url: `https://reddit.com/r/${r.display_name || r.name}`,
  };
}

function scoreToStars(score, maxScore) {
  if (!maxScore) return '⭐';
  const r = score / maxScore;
  if (r >= 0.85) return '⭐⭐⭐⭐⭐';
  if (r >= 0.65) return '⭐⭐⭐⭐';
  if (r >= 0.45) return '⭐⭐⭐';
  if (r >= 0.25) return '⭐⭐';
  return '⭐';
}

// ─── NSFW helpers ─────────────────────────────────────────────────────────────
function wantsNsfw(req) { return req.query.nsfw === '1'; }
function filterNsfw(items, nsfw) {
  if (nsfw) return items; 
  return items.filter(d => !d.over18);
}

// ─── Cache ────────────────────────────────────────────────────────────────────
const cache = {};
function bustCache() { Object.keys(cache).forEach(k => delete cache[k]); }


// ─── Data refresh ─────────────────────────────────────────────────────────────
async function refreshData() {
  console.log('[cron] Refreshing subreddit data...');
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
    console.error('[cron] Error:', err.message);
  }
}

cron.schedule('*/30 * * * *', refreshData);
refreshData();

// ─── NSFW helpers ─────────────────────────────────────────────────────────────
function wantsNsfw(req) { return req.query.nsfw === '1'; }
function filterNsfw(items, nsfw) {
  if (nsfw) return items; 
  return items.filter(d => !d.over18); 
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// GET /api/trending
app.get('/api/trending', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 20, 50);
    const nsfw = wantsNsfw(req);

    let data;
    let source;

    if (nsfw) {
      const live = await reddit.fetchNsfwTrending(limit * 2);
      data = live.map(formatSub);
      source = 'live';
    } else {
      const rows = stmts.getTrending.all(limit * 3);
      if (rows.length === 0) {
        const live = await reddit.fetchTrending(limit * 2);
        data = live.map(formatSub);
        source = 'live';
      } else {
        data = rows.map(formatDbRow);
        source = 'db';
      }
    }

    res.json({ source, data: filterNsfw(data, nsfw).slice(0, limit) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/rising
app.get('/api/rising', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 20, 50);
    const nsfw = wantsNsfw(req);

    if (nsfw) {
      const live = await reddit.fetchNsfwRising(limit);
      return res.json({ source: 'live', data: live.map(formatSub) });
    }

    const rows = stmts.getRising.all(limit * 3);
    if (rows.length === 0) {
      const live = await reddit.fetchRising(limit * 2);
      return res.json({ source: 'live', data: filterNsfw(live.map(formatSub), false).slice(0, limit) });
    }
    res.json({ source: 'db', data: filterNsfw(rows.map(formatDbRow), false).slice(0, limit) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/new
app.get('/api/new', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 20, 50);
    const nsfw = wantsNsfw(req);

    if (nsfw) {
      const live = await reddit.fetchNsfwNew(limit);
      return res.json({ source: 'live', data: live.map(formatSub) });
    }

    const live = await reddit.fetchNew(limit * 2);
    // Don't use filterNsfw here — new subs have unreliable over18 flags
    const data = live.map(formatSub).filter(d => d.over18 !== true).slice(0, limit);
    res.json({ source: 'live', data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/search?q=...&nsfw=0|1
app.get('/api/search', async (req, res) => {
  try {
    const q = req.query.q;
    if (!q) return res.status(400).json({ error: 'q param required' });

    const nsfw = wantsNsfw(req);
    const tab  = req.query.tab || 'trending';

    // map tab → Reddit sort param
    const sortMap = { trending: 'relevance', rising: 'activity', new: 'new' };
    const sort = sortMap[tab] || 'relevance';

    const results = await reddit.searchSubreddits(q, 25, nsfw, sort);
    let filtered = filterNsfw(results.map(formatSub), nsfw);

    if (tab === 'new') filtered = filtered.filter(d => d.subscribers >= 5000);

    res.json({ data: filtered.slice(0, 15) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// GET /api/subreddit/:name — detail + growth history
app.get('/api/subreddit/:name', async (req, res) => {
  try {
    const name = req.params.name.toLowerCase();
    const since = Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60;
    const history = stmts.getGrowthData.all(name, since);
    const live = await reddit.getSubreddit(name);
    res.json({
      subreddit: formatSub(live),
      history: history.map(h => ({ subscribers: h.subscribers, active_users: h.active_users, captured_at: h.captured_at })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// GET /api/stats
app.get('/api/stats', (req, res) => {
  res.json({ last_refresh: cache['ts'] || null });
});

// ─── Star rating helper ───────────────────────────────────────────────────────
function scoreToStars(score, maxScore) {
  if (!maxScore) return '⭐';
  const r = score / maxScore;
  if (r >= 0.85) return '⭐⭐⭐⭐⭐';
  if (r >= 0.65) return '⭐⭐⭐⭐';
  if (r >= 0.45) return '⭐⭐⭐';
  if (r >= 0.25) return '⭐⭐';
  return '⭐';
}

// ─── GET /api/user-ranking?user=USERNAME&limit=100 ────────────────────────────
app.get('/api/user-ranking', async (req, res) => {
  const username = req.query.user;
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  if (!username) return res.status(400).json({ error: 'user param required' });

  try {
    const data = await reddit.redditGet(`/user/${encodeURIComponent(username)}/submitted`, {
      sort: 'new', limit: 100, t: 'all'
    });

    const posts = data.data.children.map(c => c.data);
    if (!posts.length) return res.json({ data: [] });

    const scores = {};
    for (const p of posts) {
      const sub = p.subreddit;
      if (!scores[sub]) scores[sub] = { score: 0, posts: 0, upvotes: 0, comments: 0 };
      scores[sub].score    += p.score + p.num_comments;
      scores[sub].posts    += 1;
      scores[sub].upvotes  += p.score;
      scores[sub].comments += p.num_comments;
    }

    const maxScore = Math.max(...Object.values(scores).map(s => s.score));
    const ranked = Object.entries(scores)
      .sort((a, b) => b[1].score - a[1].score)
      .slice(0, limit)
      .map(([subreddit, d]) => ({
        subreddit, score: d.score, posts: d.posts,
        upvotes: d.upvotes, comments: d.comments,
        stars: scoreToStars(d.score, maxScore),
      }));

    res.json({ data: ranked });
  } catch (err) {
    console.error('[user-ranking]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/user-monthly?user=USERNAME&months=1&limit=500 ──────────────────
app.get('/api/user-monthly', async (req, res) => {
  const username = req.query.user;
  const months   = parseFloat(req.query.months) || 1;
  const limit    = Math.min(parseInt(req.query.limit) || 500, 1000);
  if (!username) return res.status(400).json({ error: 'user param required' });

  const cutoff = Math.floor(Date.now() / 1000) - (months * 30 * 24 * 3600);

  try {
    const posts = [];
    let after = null;

    while (posts.length < limit) {
      const params = { sort: 'new', limit: 100, t: 'all' };
      if (after) params.after = after;

      const data = await reddit.redditGet(`/user/${encodeURIComponent(username)}/submitted`, params);
      const children = data.data.children;
      if (!children.length) break;

      let hitCutoff = false;
      for (const c of children) {
        const p = c.data;
        if (p.created_utc < cutoff) { hitCutoff = true; break; }
        posts.push(p);
      }

      after = data.data.after;
      if (!after || hitCutoff) break;
    }

    if (!posts.length) return res.json({ data: [] });

    const scores = {};
    for (const p of posts) {
      const sub = p.subreddit;
      if (!scores[sub]) scores[sub] = { score: 0, posts: 0, upvotes: 0, comments: 0 };
      scores[sub].score    += p.score + p.num_comments;
      scores[sub].posts    += 1;
      scores[sub].upvotes  += p.score;
      scores[sub].comments += p.num_comments;
    }

    const maxScore = Math.max(...Object.values(scores).map(s => s.score));
    const ranked = Object.entries(scores)
      .sort((a, b) => b[1].score - a[1].score)
      .map(([subreddit, d]) => ({
        subreddit, score: d.score, posts: d.posts,
        upvotes: d.upvotes, comments: d.comments,
        stars: scoreToStars(d.score, maxScore),
      }));

    res.json({ data: ranked });
  } catch (err) {
    console.error('[user-monthly]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/sub-post-timing?sub=NAME&tz=Asia/Manila&limit=500 ──────────────
app.get('/api/sub-post-timing', async (req, res) => {
  const subName = req.query.sub;
  const tzName  = req.query.tz || 'Asia/Manila';
  const limit   = Math.min(parseInt(req.query.limit) || 500, 1000);
  if (!subName) return res.status(400).json({ error: 'sub param required' });

  const now          = Math.floor(Date.now() / 1000);
  const weekCutoff   = now - 7  * 24 * 3600;
  const monthCutoff  = now - 30 * 24 * 3600;

  try {
    const posts = [];
    let after = null;

    while (posts.length < limit) {
      const params = { limit: 100 };
      if (after) params.after = after;
      const data = await reddit.redditGet(`/r/${encodeURIComponent(subName)}/new`, params);
      const children = data.data.children;
      if (!children.length) break;

      let hitCutoff = false;
      for (const c of children) {
        const p = c.data;
        if (p.created_utc < monthCutoff) { hitCutoff = true; break; }
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

        // Get local day name
        const dayStr  = date.toLocaleDateString('en-US', { timeZone: tzName, weekday: 'long' });
        // Get local hour (0-23)
        const hourStr = date.toLocaleTimeString('en-US', { timeZone: tzName, hour: '2-digit', hour12: false });
        const hour    = parseInt(hourStr.split(':')[0]) % 24;

        if (!byDay[dayStr]) byDay[dayStr] = {};
        byDay[dayStr][hour] = (byDay[dayStr][hour] || 0) + p.score + p.num_comments;
      }
      return byDay;
    }

    res.json({
      data: {
        week:  bucketPosts(weekCutoff),
        month: bucketPosts(monthCutoff),
      },
      meta: { sub: subName, tz: tzName, posts_scanned: posts.length }
    });
  } catch (err) {
    console.error('[sub-post-timing]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Catch-all → frontend
app.get('/{*path}', (req, res) => {
  res.sendFile(path.join(__dirname, '../index.html'));
});



// ─── Formatters ───────────────────────────────────────────────────────────────
function formatSub(d) {
  return {
    name: d.display_name,
    title: d.title || d.display_name,
    description: d.public_description || '',
    subscribers: d.subscribers || 0,
    active_users: d.active_user_count || 0,
    over18: d.over18 || false,
    created_utc: d.created_utc || 0,
    url: `https://reddit.com/r/${d.display_name}`,
    icon: d.icon_img || d.community_icon || null,
  };
}

function formatDbRow(r) {
  return {
    name: r.display_name || r.name,
    title: r.display_name || r.name,
    description: r.description || '',
    subscribers: r.subscribers || 0,
    active_users: r.active_users || 0,
    over18: r.over18 === 1,
    growth_pct: parseFloat((r.growth_pct || 0).toFixed(2)),
    captured_at: r.captured_at,
    url: `https://reddit.com/r/${r.display_name || r.name}`,
  };
}

app.listen(PORT, () => {
  console.log(`\n🚀 Reddit Tracker running at http://localhost:${PORT}`);
  console.log(`   API: http://localhost:${PORT}/api/trending\n`);
});
