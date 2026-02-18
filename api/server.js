const express = require('express');
const Database = require('better-sqlite3');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

const db = new Database(path.join(__dirname, 'warship.db'));
db.pragma('journal_mode = WAL');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS scores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL,
    player_id TEXT DEFAULT '',
    xp INTEGER NOT NULL,
    kills INTEGER DEFAULT 0,
    hits INTEGER DEFAULT 0,
    torpedoes_fired INTEGER DEFAULT 0,
    placement INTEGER DEFAULT 0,
    won INTEGER DEFAULT 0,
    game_time REAL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_scores_xp ON scores(xp DESC);
  CREATE INDEX IF NOT EXISTS idx_scores_date ON scores(created_at);
  CREATE INDEX IF NOT EXISTS idx_scores_user ON scores(username);
`);

// Submit score
app.post('/score', (req, res) => {
  const { username, xp, kills, hits, torpedoesFired, placement, won, gameTime } = req.body;
  if (!username || typeof xp !== 'number') return res.status(400).json({ error: 'Invalid data' });
  const name = String(username).slice(0, 20).replace(/[<>&"']/g, '');
  if (!name) return res.status(400).json({ error: 'Invalid username' });

  const pid = String(req.body.playerId || '').slice(0, 50);
  const stmt = db.prepare(`
    INSERT INTO scores (username, player_id, xp, kills, hits, torpedoes_fired, placement, won, game_time)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(name, pid, xp, kills || 0, hits || 0, torpedoesFired || 0, placement || 0, won ? 1 : 0, gameTime || 0);
  res.json({ id: result.lastInsertRowid, xp });
});

// Rename player (update all past scores)
app.post('/rename', (req, res) => {
  const { playerId, oldName, newName } = req.body;
  if (!newName) return res.status(400).json({ error: 'Invalid name' });
  const name = String(newName).slice(0, 20).replace(/[<>&"']/g, '');
  if (!name) return res.status(400).json({ error: 'Invalid name' });

  let updated;
  if (playerId) {
    updated = db.prepare('UPDATE scores SET username = ? WHERE player_id = ?').run(name, String(playerId).slice(0, 50));
  } else if (oldName) {
    updated = db.prepare('UPDATE scores SET username = ? WHERE username = ?').run(name, String(oldName).slice(0, 20));
  } else {
    return res.status(400).json({ error: 'Need playerId or oldName' });
  }
  res.json({ updated: updated.changes });
});

// Leaderboard: all-time top scores (best single game per player)
app.get('/leaderboard', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 20, 50);
  const rows = db.prepare(`
    SELECT username, MAX(xp) as best_xp, SUM(xp) as total_xp,
           COUNT(*) as games, SUM(kills) as total_kills, SUM(won) as wins,
           ROUND(1.0 * SUM(xp) / COUNT(*)) as avg_xp
    FROM scores
    GROUP BY username
    ORDER BY total_xp DESC
    LIMIT ?
  `).all(limit);
  res.json(rows);
});

// Leaderboard: best single game
app.get('/leaderboard/best', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 20, 50);
  const rows = db.prepare(`
    SELECT username, xp, kills, hits, placement, won, game_time,
           created_at
    FROM scores
    ORDER BY xp DESC
    LIMIT ?
  `).all(limit);
  res.json(rows);
});

// Leaderboard: today's best
app.get('/leaderboard/today', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 20, 50);
  const rows = db.prepare(`
    SELECT username, MAX(xp) as best_xp, SUM(xp) as total_xp,
           COUNT(*) as games, SUM(kills) as total_kills, SUM(won) as wins,
           ROUND(1.0 * SUM(xp) / COUNT(*)) as avg_xp
    FROM scores
    WHERE date(created_at) = date('now')
    GROUP BY username
    ORDER BY total_xp DESC
    LIMIT ?
  `).all(limit);
  res.json(rows);
});

// Player stats
app.get('/player/:username', (req, res) => {
  const name = String(req.params.username).slice(0, 20);
  const stats = db.prepare(`
    SELECT username, COUNT(*) as games, SUM(xp) as total_xp, MAX(xp) as best_xp,
           SUM(kills) as total_kills, SUM(won) as wins, AVG(placement) as avg_placement
    FROM scores WHERE username = ?
  `).get(name);
  if (!stats || !stats.games) return res.status(404).json({ error: 'Player not found' });
  res.json(stats);
});

const PORT = process.env.PORT || 3847;
app.listen(PORT, '127.0.0.1', () => console.log('Warship API on port ' + PORT));
