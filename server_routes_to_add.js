// ═══════════════════════════════════════════════════════════════════════════
// STEP 1 — Add this line to the BOTTOM of reddit.js exports:
//
//   module.exports = {
//     fetchTrending, fetchNew, fetchNsfwTrending, fetchNsfwRising,
//     fetchNsfwNew, fetchRising, searchSubreddits, getSubreddit,
//     redditGet,   // ← ADD THIS
//   };
//
// ═══════════════════════════════════════════════════════════════════════════
// STEP 2 — Paste the routes below into server.js, BEFORE the catch-all route:
//   app.get('/{*path}', ...)
// ═══════════════════════════════════════════════════════════════════════════

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
