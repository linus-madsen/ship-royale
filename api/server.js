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

// ===== WebSocket Multiplayer =====
const http = require('http');
const { WebSocketServer } = require('ws');

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

const MAX_PLAYERS = 12;
const MATCHMAKING_TIME = 15;

let rooms = [];
let nextRoomId = 1;

function createRoom() {
  const room = {
    id: nextRoomId++,
    players: [],       // { ws, slot, name, alive: true }
    state: 'waiting',  // waiting | playing | done
    countdown: MATCHMAKING_TIME,
    interval: null,
    playerStates: {}   // slot -> {x, y, rotation, hp}
  };
  room.interval = null; // start ticking only when first player joins
  rooms.push(room);
  return room;
}

function tickRoom(room) {
  if (room.state !== 'waiting') return;
  room.countdown--;
  broadcastRoom(room, { type: 'waiting', players: room.players.length, countdown: room.countdown, names: room.players.map(p => p.name), roomId: room.id });
  if (room.countdown <= 0) startGame(room);
}

function findWaitingRoom() {
  return rooms.find(r => r.state === 'waiting' && r.players.length < MAX_PLAYERS);
}

function startGame(room) {
  if (room.state !== 'waiting') return;
  room.state = 'playing';
  clearInterval(room.interval);
  console.log(`[Room ${room.id}] Game starting with ${room.players.length} humans`);
  // Build player list: human players + AI to fill 12 slots
  const playerList = [];
  for (let i = 0; i < room.players.length; i++) {
    playerList.push({ slot: room.players[i].slot, name: room.players[i].name, isAI: false });
  }
  const usedSlots = new Set(room.players.map(p => p.slot));
  for (let s = 0; s < MAX_PLAYERS && playerList.length < MAX_PLAYERS; s++) {
    if (!usedSlots.has(s)) {
      playerList.push({ slot: s, name: null, isAI: true });
    }
  }
  // Send gameStart to each player with their slot
  for (const p of room.players) {
    if (p.ws.readyState === 1) {
      p.ws.send(JSON.stringify({ type: 'gameStart', slot: p.slot, players: playerList }));
    }
  }
}

function broadcastRoom(room, msg) {
  const data = JSON.stringify(msg);
  for (const p of room.players) {
    if (p.ws.readyState === 1) p.ws.send(data);
  }
}

function removePlayer(room, ws) {
  room.players = room.players.filter(p => p.ws !== ws);
  if (room.state === 'waiting' && room.players.length === 0) {
    clearInterval(room.interval);
    rooms = rooms.filter(r => r !== room);
  }
}

wss.on('connection', (ws) => {
  let playerRoom = null;
  let playerSlot = -1;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'join') {
      // Join matchmaking
      let room = findWaitingRoom();
      if (!room) room = createRoom();
      playerRoom = room;
      // Assign random available slot
      const usedSlots = new Set(room.players.map(p => p.slot));
      const availableSlots = [];
      for (let s = 0; s < MAX_PLAYERS; s++) {
        if (!usedSlots.has(s)) availableSlots.push(s);
      }
      playerSlot = availableSlots[Math.floor(Math.random() * availableSlots.length)];
      room.players.push({ ws, slot: playerSlot, name: String(msg.name || 'Anon').slice(0, 20), alive: true });
      // Start countdown on first player join
      if (!room.interval) {
        room.interval = setInterval(() => tickRoom(room), 1000);
      }
      console.log(`[Room ${room.id}] Player "${msg.name}" joined as slot ${playerSlot} (${room.players.length}/${MAX_PLAYERS})`);
      // Immediately send waiting status
      broadcastRoom(room, { type: 'waiting', players: room.players.length, countdown: room.countdown, names: room.players.map(p => p.name), roomId: room.id });
      // Auto-start if full
      if (room.players.length >= MAX_PLAYERS) startGame(room);

    } else if (msg.type === 'skip' && playerRoom && playerRoom.state === 'waiting') {
      // Mark this player as ready
      const player = playerRoom.players.find(p => p.ws === ws);
      if (player) player.ready = true;
      // Check if all humans are ready
      const allReady = playerRoom.players.every(p => p.ready);
      if (allReady) {
        startGame(playerRoom);
      } else {
        const readyCount = playerRoom.players.filter(p => p.ready).length;
        broadcastRoom(playerRoom, { type: 'waiting', players: playerRoom.players.length, countdown: playerRoom.countdown, names: playerRoom.players.map(p => p.name), roomId: playerRoom.id, ready: readyCount });
      }

    } else if (msg.type === 'state' && playerRoom && playerRoom.state === 'playing') {
      // Store and relay player state
      if (!playerRoom._stateCount) playerRoom._stateCount = 0;
      playerRoom._stateCount++;
      if (playerRoom._stateCount % 50 === 1) console.log(`[Room ${playerRoom.id}] State relay #${playerRoom._stateCount} from slot ${playerSlot} (x:${msg.x} y:${msg.y})`);
      playerRoom.playerStates[playerSlot] = { slot: playerSlot, x: msg.x, y: msg.y, vx: msg.vx || 0, vy: msg.vy || 0, rotation: msg.rotation, hp: msg.hp };
      // Broadcast all player states to everyone
      const states = Object.values(playerRoom.playerStates);
      const data = JSON.stringify({ type: 'update', players: states });
      for (const p of playerRoom.players) {
        if (p.ws !== ws && p.ws.readyState === 1) p.ws.send(data);
      }

    } else if (msg.type === 'fire' && playerRoom && playerRoom.state === 'playing') {
      const data = JSON.stringify({ type: 'action', slot: playerSlot, kind: msg.kind, x: msg.x, y: msg.y, angle: msg.angle, targetIdx: msg.targetIdx });
      for (const p of playerRoom.players) {
        if (p.ws !== ws && p.ws.readyState === 1) p.ws.send(data);
      }

    } else if (msg.type === 'kill' && playerRoom && playerRoom.state === 'playing') {
      const data = JSON.stringify({ type: 'kill', victimSlot: msg.victimSlot, killerSlot: msg.killerSlot });
      for (const p of playerRoom.players) {
        if (p.ws !== ws && p.ws.readyState === 1) p.ws.send(data);
      }

    } else if (msg.type === 'death' && playerRoom && playerRoom.state === 'playing') {
      const data = JSON.stringify({ type: 'death', slot: playerSlot });
      for (const p of playerRoom.players) {
        if (p.ws !== ws && p.ws.readyState === 1) p.ws.send(data);
      }
    }
  });

  ws.on('close', () => {
    if (playerRoom && playerRoom.state === 'waiting') {
      removePlayer(playerRoom, ws);
    } else if (playerRoom && playerRoom.state === 'playing') {
      // Broadcast disconnect — other clients will switch this ship to AI
      console.log(`[Room ${playerRoom.id}] Player slot ${playerSlot} disconnected`);
      const data = JSON.stringify({ type: 'disconnect', slot: playerSlot });
      for (const p of playerRoom.players) {
        if (p.ws !== ws && p.ws.readyState === 1) p.ws.send(data);
      }
      removePlayer(playerRoom, ws);
    }
  });
});

const PORT = process.env.PORT || 3847;
server.listen(PORT, '127.0.0.1', () => console.log('Warship API on port ' + PORT));
