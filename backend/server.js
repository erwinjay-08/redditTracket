require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const path = require('path');
const { execFile } = require("child_process");

const { saveSubredditData, stmts } = require('./db');
const reddit = require('./reddit');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../frontend/public')));

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
// nsfw=1 → show only 18+ subs; nsfw=0 (default) → hide 18+ subs
function wantsNsfw(req) { return req.query.nsfw === '1'; }
function filterNsfw(items, nsfw) {
  if (nsfw) return items; // already fetched NSFW-targeted results
  return items.filter(d => !d.over18); // only strip confirmed 18+ from SFW feed
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
      // ALWAYS fetch live NSFW subs
      const live = await reddit.fetchNsfwTrending(limit * 2); // fetch extra to ensure enough
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
    res.json({ source: 'live', data: filterNsfw(live.map(formatSub), false).slice(0, limit) });
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
    const results = await reddit.searchSubreddits(q, 25, nsfw);
    res.json({ data: filterNsfw(results.map(formatSub), nsfw).slice(0, 10) });
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

app.get("/api/user-ranking", async (req, res) => {
  const user = req.query.user;
  const limit = req.query.limit || 100;

  if (!user) return res.status(400).json({ error: "user param required" });

  const script = path.join(__dirname, "python/user_ranking.py");
  const args = ["--user", user, "--limit", limit];

  execFile("python", [script, ...args], { env: process.env }, (err, stdout, stderr) => {
    if (err) return res.status(500).json({ error: stderr || err.message });
    try {
      res.json({ data: JSON.parse(stdout) });
    } catch {
      res.status(500).json({ error: "Python output not valid JSON" });
    }
  });
});

app.get("/api/user-monthly", async (req, res) => {
  const user = req.query.user;
  const months = req.query.months || 1;
  const limit = req.query.limit || 2000;

  if (!user) return res.status(400).json({ error: "user param required" });

  const script = path.join(__dirname, "python/user_monthly_performance.py");
  const args = ["--user", user, "--months", months, "--limit", limit];

  execFile("python", [script, ...args], { env: process.env }, (err, stdout, stderr) => {
    if (err) return res.status(500).json({ error: stderr || err.message });
    try {
      res.json({ data: JSON.parse(stdout) });
    } catch {
      res.status(500).json({ error: "Python output not valid JSON" });
    }
  });
});

// GET /api/stats
app.get('/api/stats', (req, res) => {
  res.json({ last_refresh: cache['ts'] || null });
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
