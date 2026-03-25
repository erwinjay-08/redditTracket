const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'tracker.db'));

// Enable WAL mode for better performance
db.pragma('journal_mode = WAL');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS subreddits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    display_name TEXT NOT NULL,
    description TEXT,
    created_utc INTEGER,
    over18 INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subreddit_name TEXT NOT NULL,
    subscribers INTEGER DEFAULT 0,
    active_users INTEGER DEFAULT 0,
    captured_at INTEGER NOT NULL,
    FOREIGN KEY (subreddit_name) REFERENCES subreddits(name)
  );

  CREATE INDEX IF NOT EXISTS idx_snapshots_name ON snapshots(subreddit_name);
  CREATE INDEX IF NOT EXISTS idx_snapshots_time ON snapshots(captured_at);
`);

// Prepared statements
const stmts = {
  upsertSub: db.prepare(`
    INSERT INTO subreddits (name, display_name, description, created_utc, over18)
    VALUES (@name, @display_name, @description, @created_utc, @over18)
    ON CONFLICT(name) DO UPDATE SET
      description = excluded.description
  `),

  insertSnapshot: db.prepare(`
    INSERT INTO snapshots (subreddit_name, subscribers, active_users, captured_at)
    VALUES (@subreddit_name, @subscribers, @active_users, @captured_at)
  `),

  getLatestSnapshots: db.prepare(`
    SELECT s.name, s.display_name, s.description, s.over18,
           sn.subscribers, sn.active_users, sn.captured_at
    FROM subreddits s
    JOIN snapshots sn ON sn.subreddit_name = s.name
    WHERE sn.id IN (
      SELECT MAX(id) FROM snapshots GROUP BY subreddit_name
    )
    ORDER BY sn.subscribers DESC
    LIMIT ?
  `),

  getGrowthData: db.prepare(`
    SELECT subreddit_name, subscribers, active_users, captured_at
    FROM snapshots
    WHERE subreddit_name = ?
      AND captured_at > ?
    ORDER BY captured_at ASC
  `),

  getTrending: db.prepare(`
    SELECT
      s.name, s.display_name, s.description,
      latest.subscribers,
      latest.active_users,
      latest.captured_at,
      COALESCE(prev.subscribers, latest.subscribers) as prev_subscribers,
      CAST(latest.subscribers - COALESCE(prev.subscribers, latest.subscribers) AS REAL)
        / MAX(COALESCE(prev.subscribers, 1), 1) * 100 as growth_pct
    FROM subreddits s
    JOIN snapshots latest ON latest.subreddit_name = s.name
      AND latest.id = (SELECT MAX(id) FROM snapshots WHERE subreddit_name = s.name)
    LEFT JOIN snapshots prev ON prev.subreddit_name = s.name
      AND prev.captured_at <= (strftime('%s', 'now') - 86400)
      AND prev.id = (
        SELECT MAX(id) FROM snapshots
        WHERE subreddit_name = s.name
          AND captured_at <= (strftime('%s', 'now') - 86400)
      )
    WHERE latest.subscribers > 1000
    ORDER BY latest.active_users DESC
    LIMIT ?
  `),

  getRising: db.prepare(`
    SELECT
      s.name, s.display_name, s.description,
      latest.subscribers, latest.active_users, latest.captured_at,
      COALESCE(prev.subscribers, 0) as prev_subscribers,
      CAST(latest.subscribers - COALESCE(prev.subscribers, 0) AS REAL)
        / MAX(COALESCE(prev.subscribers, 1), 1) * 100 as growth_pct
    FROM subreddits s
    JOIN snapshots latest ON latest.subreddit_name = s.name
      AND latest.id = (SELECT MAX(id) FROM snapshots WHERE subreddit_name = s.name)
    LEFT JOIN snapshots prev ON prev.subreddit_name = s.name
      AND prev.id = (
        SELECT MIN(id) FROM snapshots WHERE subreddit_name = s.name
      )
    WHERE latest.subscribers > 100
    ORDER BY growth_pct DESC
    LIMIT ?
  `),
};

function saveSubredditData(data) {
  const now = Math.floor(Date.now() / 1000);
  const save = db.transaction((items) => {
    for (const item of items) {
      stmts.upsertSub.run({
        name: item.display_name.toLowerCase(),
        display_name: item.display_name,
        description: item.public_description || item.title || '',
        created_utc: item.created_utc || 0,
        over18: item.over18 ? 1 : 0,
      });
      stmts.insertSnapshot.run({
        subreddit_name: item.display_name.toLowerCase(),
        subscribers: item.subscribers || 0,
        active_users: item.active_user_count || 0,
        captured_at: now,
      });
    }
  });
  save(data);
}

module.exports = { db, saveSubredditData, stmts };
