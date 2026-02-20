const express = require('express');
const Database = require('better-sqlite3');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

const db = new Database(path.join(__dirname, 'warship.db'));
db.pragma('journal_mode = WAL');

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

// === Leaderboard REST endpoints (unchanged) ===
app.post('/score', (req, res) => {
  const { username, xp, kills, hits, torpedoesFired, placement, won, gameTime } = req.body;
  if (!username || typeof xp !== 'number') return res.status(400).json({ error: 'Invalid data' });
  const name = String(username).slice(0, 20).replace(/[<>&"']/g, '');
  if (!name) return res.status(400).json({ error: 'Invalid username' });
  const pid = String(req.body.playerId || '').slice(0, 50);
  const stmt = db.prepare(`INSERT INTO scores (username, player_id, xp, kills, hits, torpedoes_fired, placement, won, game_time) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const result = stmt.run(name, pid, xp, kills || 0, hits || 0, torpedoesFired || 0, placement || 0, won ? 1 : 0, gameTime || 0);
  res.json({ id: result.lastInsertRowid, xp });
});

app.post('/rename', (req, res) => {
  const { playerId, oldName, newName } = req.body;
  if (!newName) return res.status(400).json({ error: 'Invalid name' });
  const name = String(newName).slice(0, 20).replace(/[<>&"']/g, '');
  if (!name) return res.status(400).json({ error: 'Invalid name' });
  let updated;
  if (playerId) updated = db.prepare('UPDATE scores SET username = ? WHERE player_id = ?').run(name, String(playerId).slice(0, 50));
  else if (oldName) updated = db.prepare('UPDATE scores SET username = ? WHERE username = ?').run(name, String(oldName).slice(0, 20));
  else return res.status(400).json({ error: 'Need playerId or oldName' });
  res.json({ updated: updated.changes });
});

app.get('/leaderboard', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 20, 50);
  res.json(db.prepare(`SELECT username, MAX(xp) as best_xp, SUM(xp) as total_xp, COUNT(*) as games, SUM(kills) as total_kills, SUM(won) as wins, ROUND(1.0 * SUM(xp) / COUNT(*)) as avg_xp FROM scores GROUP BY username ORDER BY total_xp DESC LIMIT ?`).all(limit));
});

app.get('/leaderboard/best', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 20, 50);
  res.json(db.prepare(`SELECT username, xp, kills, hits, placement, won, game_time, created_at FROM scores ORDER BY xp DESC LIMIT ?`).all(limit));
});

app.get('/leaderboard/today', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 20, 50);
  res.json(db.prepare(`SELECT username, MAX(xp) as best_xp, SUM(xp) as total_xp, COUNT(*) as games, SUM(kills) as total_kills, SUM(won) as wins, ROUND(1.0 * SUM(xp) / COUNT(*)) as avg_xp FROM scores WHERE date(created_at) = date('now') GROUP BY username ORDER BY total_xp DESC LIMIT ?`).all(limit));
});

app.get('/player/:username', (req, res) => {
  const name = String(req.params.username).slice(0, 20);
  const stats = db.prepare(`SELECT username, COUNT(*) as games, SUM(xp) as total_xp, MAX(xp) as best_xp, SUM(kills) as total_kills, SUM(won) as wins, AVG(placement) as avg_placement FROM scores WHERE username = ?`).get(name);
  if (!stats || !stats.games) return res.status(404).json({ error: 'Player not found' });
  res.json(stats);
});

// ========== GAME CONSTANTS ==========
const MAP_W = 4000, MAP_H = 3200;
const MAX_SPEED = 200, MIN_SPEED = 40;
const TURN_RATE = 1.8, TURN_RATE_CLOSE = 12.0, CLOSE_DIST = 120, DECEL_DIST = 150;
const WAYPOINT_REACH = 20, ISLAND_MARGIN = 40;
const AVOIDANCE_RANGE = 100, AVOIDANCE_FORCE = 3.0, MAP_PAD = 50;
const FIRE_RANGE = 350, FIRE_COOLDOWN = 1.5;
const CANNONBALL_SPEED = 250, CANNONBALL_DAMAGE = 1;
const MAX_HP = 10;
const BROADSIDE_ANGLE = Math.PI / 3, FORWARD_ANGLE = Math.PI / 4;
const TORPEDO_SPEED = 180, TORPEDO_DAMAGE = 3, TORPEDO_BLAST_RADIUS = 120;
const TORPEDO_LIFE = 4.0, TORPEDO_TURN_RATE = 0.8, STARTING_TORPEDOES = 1;
const MINE_DAMAGE = 3, MINE_BLAST_RADIUS = 100, MINE_LIFETIME = 30, STARTING_MINES = 0;
const ENEMY_COUNT = 11;
const ENEMY_SPEED_BASE = 70, ENEMY_TURN_RATE_BASE = 1.2, ENEMY_WANDER_INTERVAL = 4;
const ENEMY_COLORS = [0xff4444, 0x44ff44, 0x4488ff, 0xff44ff, 0xffaa00, 0x00ffcc, 0xff8888, 0xaaaaff, 0xffff44, 0x44ffff, 0xff6600];
const ENEMY_NAMES = ['Blackbeard','Bonny','Drake','Kidd','Rackham','Silver','Hook','Barbossa','Calico','Teach','Morgan'];
const ZONE_PHASES = [
  { radius: 1500, delay: 30, shrinkTime: 15 },
  { radius: 1000, delay: 40, shrinkTime: 12 },
  { radius: 650,  delay: 35, shrinkTime: 10 },
  { radius: 350,  delay: 30, shrinkTime: 10 },
  { radius: 120,  delay: 25, shrinkTime: 8 }
];
const ZONE_DPS = 1.5;
const TICK_RATE = 30; // Hz
const TICK_MS = 1000 / TICK_RATE;

const islandDefs = [
  {x:375,y:373,key:'island6',scale:0.8},{x:750,y:400,key:'island1',scale:0.9},{x:1312,y:267,key:'island1',scale:0.8},
  {x:1875,y:440,key:'island6',scale:0.6},{x:2438,y:240,key:'island3',scale:0.85},{x:3000,y:400,key:'island2',scale:0.7},
  {x:3625,y:400,key:'island2',scale:0.8},{x:438,y:773,key:'island2',scale:0.85},{x:1000,y:907,key:'island6',scale:0.9},
  {x:1625,y:733,key:'island1',scale:0.75},{x:2188,y:893,key:'island6',scale:0.7},{x:2750,y:773,key:'island6',scale:0.85},
  {x:3375,y:880,key:'island5',scale:0.9},{x:3875,y:733,key:'island1',scale:0.7},{x:375,y:1227,key:'island5',scale:0.75},
  {x:812,y:1360,key:'island4',scale:0.65},{x:1375,y:1173,key:'island1',scale:0.85},{x:1938,y:1333,key:'island1',scale:0.9},
  {x:2500,y:1227,key:'island1',scale:0.8},{x:3062,y:1373,key:'island2',scale:0.75},{x:3625,y:1200,key:'island2',scale:0.85},
  {x:500,y:1707,key:'island5',scale:0.8},{x:1062,y:1827,key:'island5',scale:0.85},{x:1688,y:1667,key:'island1',scale:0.75},
  {x:2250,y:1840,key:'island5',scale:0.7},{x:2812,y:1693,key:'island2',scale:0.9},{x:3375,y:1813,key:'island6',scale:0.75},
  {x:3875,y:1667,key:'island6',scale:0.65},{x:438,y:2133,key:'island6',scale:0.8},{x:875,y:2293,key:'island5',scale:0.75},
  {x:1438,y:2107,key:'island4',scale:0.9},{x:2000,y:2267,key:'island2',scale:0.7},{x:2562,y:2160,key:'island4',scale:0.85},
  {x:3125,y:2307,key:'island5',scale:0.7},{x:3688,y:2133,key:'island3',scale:0.8},{x:562,y:2600,key:'island7',scale:0.85},
  {x:1188,y:2747,key:'island7',scale:0.9},{x:1812,y:2560,key:'island1',scale:0.7},{x:2375,y:2733,key:'island7',scale:0.8},
  {x:2938,y:2600,key:'island7',scale:0.85},{x:3500,y:2773,key:'island2',scale:0.75},{x:438,y:2933,key:'island6',scale:0.7},
  {x:1000,y:2933,key:'island4',scale:0.8},{x:1625,y:2867,key:'island3',scale:0.75},{x:2250,y:2960,key:'island3',scale:0.65},
  {x:2875,y:2880,key:'island2',scale:0.8},{x:3500,y:2933,key:'island2',scale:0.7},
];

// All island images are 192x192px. Radius = displayWidth * 0.45 (matching client)
const ISLAND_IMG_SIZE = 192;
const islandCircles = islandDefs.map(d => ({ x: d.x, y: d.y, r: ISLAND_IMG_SIZE * d.scale * 0.45 }));

// ========== PHYSICS HELPERS ==========
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function dist(ax, ay, bx, by) { const dx = bx - ax, dy = by - ay; return Math.sqrt(dx * dx + dy * dy); }
function angleWrap(a) { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; }

function segmentHitsCircle(ax, ay, bx, by, cx, cy, r) {
  const dx = bx - ax, dy = by - ay, fx = ax - cx, fy = ay - cy;
  const a = dx * dx + dy * dy;
  if (a < 0.001) return fx * fx + fy * fy < r * r;
  const b = 2 * (fx * dx + fy * dy), c = fx * fx + fy * fy - r * r;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return false;
  const sq = Math.sqrt(disc), t1 = (-b - sq) / (2 * a), t2 = (-b + sq) / (2 * a);
  return (t1 >= 0 && t1 <= 1) || (t2 >= 0 && t2 <= 1) || (t1 < 0 && t2 > 1);
}

function hasLineOfSight(ax, ay, bx, by) {
  for (const isl of islandCircles) {
    if (segmentHitsCircle(ax, ay, bx, by, isl.x, isl.y, isl.r)) return false;
  }
  return true;
}

function getAvoidanceSteer(sx, sy) {
  let stX = 0, stY = 0;
  for (const isl of islandCircles) {
    const dx = sx - isl.x, dy = sy - isl.y, d = Math.sqrt(dx * dx + dy * dy);
    const ed = d - isl.r;
    if (ed < AVOIDANCE_RANGE && d > 0.1) {
      let str = Math.pow(1 - Math.max(ed, 0) / AVOIDANCE_RANGE, 2) * AVOIDANCE_FORCE;
      if (ed < 0) str = AVOIDANCE_FORCE * 5;
      stX += (dx / d) * str; stY += (dy / d) * str;
    }
  }
  const er = AVOIDANCE_RANGE;
  if (sx < er) stX += Math.pow(1 - sx / er, 2) * AVOIDANCE_FORCE;
  if (sx > MAP_W - er) stX -= Math.pow(1 - (MAP_W - sx) / er, 2) * AVOIDANCE_FORCE;
  if (sy < er) stY += Math.pow(1 - sy / er, 2) * AVOIDANCE_FORCE;
  if (sy > MAP_H - er) stY -= Math.pow(1 - (MAP_H - sy) / er, 2) * AVOIDANCE_FORCE;
  return { x: stX, y: stY };
}

function enforceOutsideIslands(sx, sy) {
  let px = clamp(sx, MAP_PAD, MAP_W - MAP_PAD);
  let py = clamp(sy, MAP_PAD, MAP_H - MAP_PAD);
  for (let pass = 0; pass < 2; pass++) {
    for (const isl of islandCircles) {
      const dx = px - isl.x, dy = py - isl.y, d = Math.sqrt(dx * dx + dy * dy);
      const mn = isl.r + 10;
      if (d < mn) {
        if (d < 0.1) px = isl.x + mn;
        else { px = isl.x + (dx / d) * mn; py = isl.y + (dy / d) * mn; }
      }
    }
  }
  return { x: px, y: py };
}

function moveShip(obj, targetX, targetY, spd, turnRate, dt) {
  const d = dist(obj.x, obj.y, targetX, targetY);
  let desiredAngle = Math.atan2(targetY - obj.y, targetX - obj.x);
  const av = getAvoidanceSteer(obj.x, obj.y);
  if (av.x !== 0 || av.y !== 0) {
    const aAngle = Math.atan2(av.y, av.x);
    const aStr = Math.sqrt(av.x * av.x + av.y * av.y);
    const blend = Math.min(aStr / AVOIDANCE_FORCE, 0.85);
    desiredAngle = Math.atan2(
      Math.sin(desiredAngle) * (1 - blend) + Math.sin(aAngle) * blend,
      Math.cos(desiredAngle) * (1 - blend) + Math.cos(aAngle) * blend
    );
  }
  const diff = angleWrap(desiredAngle - obj.rotation);
  obj.rotation += clamp(diff, -turnRate * dt, turnRate * dt);
  obj.vx = Math.cos(obj.rotation) * spd;
  obj.vy = Math.sin(obj.rotation) * spd;
  const safe = enforceOutsideIslands(obj.x + obj.vx * dt, obj.y + obj.vy * dt);
  obj.x = clamp(safe.x, 0, MAP_W);
  obj.y = clamp(safe.y, 0, MAP_H);
  return d;
}

function canFire(shipObj, targetX, targetY) {
  const angleToTarget = Math.atan2(targetY - shipObj.y, targetX - shipObj.x);
  const relAngle = Math.abs(angleWrap(angleToTarget - shipObj.rotation));
  if (relAngle < FORWARD_ANGLE) return true;
  const lo = Math.PI / 2 - BROADSIDE_ANGLE, hi = Math.PI / 2 + BROADSIDE_ANGLE;
  if ((relAngle > lo && relAngle < hi) || (relAngle > Math.PI - hi && relAngle < Math.PI - lo)) return true;
  return false;
}

function getFireAngle(shipObj, targetX, targetY) {
  const angleToTarget = Math.atan2(targetY - shipObj.y, targetX - shipObj.x);
  const relAngle = angleWrap(angleToTarget - shipObj.rotation);
  if (Math.abs(relAngle) < FORWARD_ANGLE) return angleToTarget;
  return relAngle > 0 ? shipObj.rotation + Math.PI / 2 : shipObj.rotation - Math.PI / 2;
}

function findNearestTarget(ships, fromX, fromY, excludeSlot) {
  let best = null, bestDist = Infinity;
  for (const s of ships) {
    if (s.slot === excludeSlot || !s.alive || s.hp <= 0) continue;
    const d = dist(fromX, fromY, s.x, s.y);
    if (d < bestDist) { bestDist = d; best = { x: s.x, y: s.y, slot: s.slot, dist: d }; }
  }
  return best;
}

function isInZone(px, py, zone) {
  return dist(px, py, zone.cx, zone.cy) <= zone.radius;
}

// Pathfinding helpers
function findBlockingIsland(ax, ay, bx, by) {
  for (const s of islandCircles) {
    if (segmentHitsCircle(ax, ay, bx, by, s.x, s.y, s.r)) return s;
  }
  return null;
}

function getBypassPoints(ax, ay, bx, by, isl) {
  const dx = bx - ax, dy = by - ay, len = Math.sqrt(dx * dx + dy * dy);
  if (len < 1) return [{ x: bx, y: by }];
  const nx = -dy / len, ny = dx / len, br = isl.r + ISLAND_MARGIN;
  const p1 = { x: isl.x + nx * br, y: isl.y + ny * br };
  const p2 = { x: isl.x - nx * br, y: isl.y - ny * br };
  const d1 = dist(ax, ay, p1.x, p1.y) + dist(p1.x, p1.y, bx, by);
  const d2 = dist(ax, ay, p2.x, p2.y) + dist(p2.x, p2.y, bx, by);
  return d1 <= d2 ? [p1] : [p2];
}

function resolveSegment(ax, ay, bx, by, depth) {
  if (depth > 3) return [{ x: bx, y: by }];
  const isl = findBlockingIsland(ax, ay, bx, by);
  if (!isl) return [{ x: bx, y: by }];
  const bp = getBypassPoints(ax, ay, bx, by, isl)[0];
  return resolveSegment(ax, ay, bp.x, bp.y, depth + 1).concat(resolveSegment(bp.x, bp.y, bx, by, depth + 1));
}

function planPath(fx, fy, tx, ty) { return resolveSegment(fx, fy, tx, ty, 0); }

// ========== ROOM / GAME LOOP ==========
const MAX_PLAYERS = 12;
const MATCHMAKING_TIME = 15;

let rooms = [];
let nextRoomId = 1;
let nextLootId = 1;

function createRoom() {
  const room = {
    id: nextRoomId++,
    players: [],        // { ws, slot, name, playerId, alive: true, ready: false }
    state: 'waiting',   // waiting | playing | done
    countdown: MATCHMAKING_TIME,
    countdownInterval: null,
    tickInterval: null,
    // Game state (populated on start)
    ships: [],          // slot-indexed array of ship objects
    cannonballs: [],
    torpedoes: [],
    mines: [],
    loot: [],
    blasts: [],
    seaMonsters: [],
    zone: { cx: MAP_W / 2, cy: MAP_H / 2, radius: 1500, targetRadius: 1500, targetCX: MAP_W / 2, targetCY: MAP_H / 2, phase: 0, timer: 0, shrinking: false, shrinkSpeed: 0 },
    gameTime: 0,
    aliveCount: 0,
    healthSpawnTimer: 8 + Math.random() * 4,
    events: [],         // queued events to broadcast
    sounds: [],         // queued sounds to broadcast
  };
  rooms.push(room);
  return room;
}

function findWaitingRoom() {
  return rooms.find(r => r.state === 'waiting' && r.players.length < MAX_PLAYERS);
}

function broadcastRoom(room, msg) {
  const data = JSON.stringify(msg);
  for (const p of room.players) {
    if (p.ws && p.ws.readyState === 1) p.ws.send(data);
  }
}

function sendTo(ws, msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function tickWaiting(room) {
  if (room.state !== 'waiting') return;
  room.countdown--;
  broadcastRoom(room, {
    type: 'waiting', players: room.players.length, countdown: room.countdown,
    names: room.players.map(p => p.name), roomId: room.id
  });
  if (room.countdown <= 0) startGame(room);
}

function startGame(room) {
  if (room.state !== 'waiting') return;
  room.state = 'playing';
  clearInterval(room.countdownInterval);
  console.log(`[Room ${room.id}] Game starting with ${room.players.length} humans`);

  // Assign slots: humans already have slots, fill rest with AI
  const usedSlots = new Set(room.players.map(p => p.slot));
  const allSlots = [];
  for (let s = 0; s < MAX_PLAYERS; s++) allSlots.push(s);

  // Create ships for all 12 slots
  room.ships = [];
  for (let s = 0; s < MAX_PLAYERS; s++) {
    const angle = (s / 12) * Math.PI * 2 - Math.PI / 2;
    let sx = MAP_W / 2 + Math.cos(angle) * 1400;
    let sy = MAP_H / 2 + Math.sin(angle) * 1200;
    sx = clamp(sx, 150, MAP_W - 150);
    sy = clamp(sy, 150, MAP_H - 150);

    const human = room.players.find(p => p.slot === s);
    const isAI = !human;
    const aiIdx = isAI ? room.ships.filter(sh => sh.isAI).length : -1;

    room.ships.push({
      slot: s,
      x: sx, y: sy,
      vx: 0, vy: 0,
      rotation: Math.atan2(MAP_H / 2 - sy, MAP_W / 2 - sx),
      hp: MAX_HP,
      alive: true,
      isAI: isAI,
      name: human ? human.name : (ENEMY_NAMES[aiIdx % ENEMY_NAMES.length] || 'Bot' + s),
      color: ENEMY_COLORS[s % ENEMY_COLORS.length],
      fireTimer: Math.random() * FIRE_COOLDOWN,
      torpedoes: STARTING_TORPEDOES,
      mines: STARTING_MINES,
      waypoints: [],
      // AI state
      aggressive: isAI && (aiIdx % 3 === 0),
      wanderTarget: null,
      wanderTimer: 0,
      speedMult: isAI ? (0.9 + Math.random() * 0.3) : 1.0,
      torpTimer: 0,
      mineTimer: 0,
      lastAttacker: -2,
      // Buff timers
      speedBuff: 0,
      fireBuff: 0,
      fireMult: 1.0,
      // Stats (for humans)
      kills: 0,
      hits: 0,
      dmgDealt: 0,
      torpsFired: 0,
      xp: 0,
    });
  }

  room.aliveCount = MAX_PLAYERS;

  // Zone init
  room.zone = {
    cx: MAP_W / 2, cy: MAP_H / 2, radius: 1500,
    targetRadius: 1500, targetCX: MAP_W / 2, targetCY: MAP_H / 2,
    phase: 0, timer: ZONE_PHASES[0].delay, shrinking: false, shrinkSpeed: 0
  };

  // Spawn initial loot
  room.loot = [];
  for (let i = 0; i < 30; i++) {
    const types = ['T', 'S', 'C', 'M'];
    spawnLootInZone(room, types[Math.floor(Math.random() * types.length)], 1500);
  }

  // Spawn sea monsters
  room.seaMonsters = [];
  const initZoneR = ZONE_PHASES[0].radius;
  for (let i = 0; i < 8; i++) {
    let mx, my, valid = false;
    for (let a = 0; a < 30; a++) {
      const mAngle = (i / 8) * Math.PI * 2 + (Math.random() - 0.5) * 0.6;
      const mDist = initZoneR + 150 + Math.random() * 300;
      mx = clamp(MAP_W / 2 + Math.cos(mAngle) * mDist, 80, MAP_W - 80);
      my = clamp(MAP_H / 2 + Math.sin(mAngle) * mDist, 80, MAP_H - 80);
      valid = true;
      for (const isl of islandCircles) {
        if (dist(mx, my, isl.x, isl.y) < isl.r + 80) { valid = false; break; }
      }
      if (valid) break;
    }
    if (valid) {
      room.seaMonsters.push({ x: mx, y: my, frame: 0, timer: Math.random() * 2, type: i % 2 === 0 ? 'kraken' : 'serpent' });
    }
  }

  // Build player list for gameStart message
  const playerList = room.ships.map(s => ({ slot: s.slot, name: s.name, isAI: s.isAI, color: s.color }));

  // Send gameStart to each human
  for (const p of room.players) {
    sendTo(p.ws, {
      type: 'gameStart',
      slot: p.slot,
      players: playerList,
      islands: islandDefs,
      monsters: room.seaMonsters.map(m => ({ x: m.x, y: m.y, type: m.type })),
    });
  }

  // Start game tick
  room.tickInterval = setInterval(() => tickGame(room), TICK_MS);
}

function spawnLootInZone(room, type, radius) {
  const cx = room.zone ? room.zone.cx : MAP_W / 2;
  const cy = room.zone ? room.zone.cy : MAP_H / 2;
  for (let a = 0; a < 20; a++) {
    const angle = Math.random() * Math.PI * 2;
    const r = Math.random() * (radius - 50);
    const lx = cx + Math.cos(angle) * r;
    const ly = cy + Math.sin(angle) * r;
    let valid = true;
    for (const isl of islandCircles) {
      if (dist(lx, ly, isl.x, isl.y) < isl.r + 30) { valid = false; break; }
    }
    if (valid) {
      room.loot.push({ id: nextLootId++, x: lx, y: ly, type: type });
      return;
    }
  }
}

function spawnLootAt(room, x, y, count) {
  const types = ['T', 'H', 'S', 'C', 'M'];
  for (let i = 0; i < count; i++) {
    const type = types[Math.floor(Math.random() * types.length)];
    room.loot.push({ id: nextLootId++, x: x + (Math.random() - 0.5) * 60, y: y + (Math.random() - 0.5) * 60, type: type });
  }
}

function addSound(room, name, x, y, vol) {
  room.sounds.push({ name, x: Math.round(x), y: Math.round(y), volume: vol });
}

function addKill(room, victimSlot, killerSlot) {
  const victim = room.ships[victimSlot];
  const killer = killerSlot >= 0 ? room.ships[killerSlot] : null;
  const killerName = killerSlot === -3 ? '🐙 Sea Monster' : (killerSlot === -2 ? 'The Abyss' : (killer ? killer.name : '???'));
  const killerColor = killerSlot === -3 ? '#9933ff' : (killerSlot === -2 ? '#ff00ff' : (killer ? '#' + killer.color.toString(16).padStart(6, '0') : '#888888'));

  room.events.push({
    type: 'kill',
    victim: victim.name,
    victimColor: '#' + victim.color.toString(16).padStart(6, '0'),
    killer: killerName,
    killerColor: killerColor,
    victimSlot: victimSlot,
    killerSlot: killerSlot,
  });
}

function damageShip(room, targetSlot, dmg, attackerSlot) {
  const target = room.ships[targetSlot];
  if (!target || !target.alive || target.hp <= 0) return;

  target.hp = Math.max(0, target.hp - dmg);
  target.lastAttacker = attackerSlot;

  if (attackerSlot >= 0) {
    const attacker = room.ships[attackerSlot];
    if (attacker && !attacker.isAI) {
      attacker.dmgDealt += dmg;
      attacker.hits++;
      attacker.xp += 10;
    }
  }

  if (target.hp <= 0) {
    target.alive = false;
    target.placement = room.aliveCount; // record placement at time of death (e.g. 5 alive = 5th place)
    room.aliveCount--;
    addKill(room, targetSlot, attackerSlot);

    if (attackerSlot >= 0) {
      const attacker = room.ships[attackerSlot];
      if (attacker) { attacker.kills++; attacker.xp += 100; }
    }

    // Drop loot
    spawnLootAt(room, target.x, target.y, 2);

    // Sound
    addSound(room, 'sfx_sink', target.x, target.y, 1.0);

    // Check for game over
    checkGameOver(room);
  }
}

function checkGameOver(room) {
  if (room.state !== 'playing') return;

  // Count alive humans
  const aliveHumans = [];
  const aliveShips = room.ships.filter(s => s.alive);

  for (const s of aliveShips) {
    if (!s.isAI) aliveHumans.push(s);
  }

  if (room.aliveCount <= 1) {
    // Game over — someone won (or everyone died)
    endGame(room);
  }

  // Also check if all humans are dead
  if (aliveHumans.length === 0 && room.players.length > 0) {
    endGame(room);
  }
}

function endGame(room) {
  if (room.state === 'done') return;
  room.state = 'done';
  clearInterval(room.tickInterval);

  const winner = room.ships.find(s => s.alive);

  for (const p of room.players) {
    const ship = room.ships.find(s => s.slot === p.slot);
    if (!ship) continue;

    const won = ship.alive && room.aliveCount <= 1;
    const place = won ? 1 : (ship.placement || room.aliveCount + 1);
    const placementBonus = (MAX_PLAYERS - place) * 50;
    ship.xp += placementBonus;
    if (won) ship.xp += 500;

    sendTo(p.ws, {
      type: 'gameOver',
      won: won,
      place: place,
      xp: ship.xp,
      kills: ship.kills,
      hits: ship.hits,
      torpsFired: ship.torpsFired,
      time: room.gameTime,
    });

    // Save score
    try {
      const stmt = db.prepare(`INSERT INTO scores (username, player_id, xp, kills, hits, torpedoes_fired, placement, won, game_time) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      stmt.run(ship.name, p.playerId || '', ship.xp, ship.kills, ship.hits, ship.torpsFired, place, won ? 1 : 0, room.gameTime);
    } catch (e) { console.error('Score save error:', e); }
  }

  // Clean up room after a delay
  setTimeout(() => {
    rooms = rooms.filter(r => r !== room);
  }, 5000);
}

function tickGame(room) {
  if (room.state !== 'playing') return;
  const dt = TICK_MS / 1000;
  room.gameTime += dt;
  room.events = [];
  room.sounds = [];

  // === Zone ===
  const z = room.zone;
  if (z.phase < ZONE_PHASES.length) {
    if (!z.shrinking) {
      z.timer -= dt;
      if (z.timer <= 0) {
        z.shrinking = true;
        const phase = ZONE_PHASES[z.phase];
        z.targetRadius = phase.radius;
        z.targetCX = clamp(MAP_W / 2 + (Math.random() - 0.5) * (1500 - phase.radius) * 0.5, phase.radius + 50, MAP_W - phase.radius - 50);
        z.targetCY = clamp(MAP_H / 2 + (Math.random() - 0.5) * (1200 - phase.radius) * 0.4, phase.radius + 50, MAP_H - phase.radius - 50);
        z.shrinkSpeed = (z.radius - z.targetRadius) / phase.shrinkTime;
      }
    } else {
      z.radius = Math.max(z.targetRadius, z.radius - z.shrinkSpeed * dt);
      z.cx += (z.targetCX - z.cx) * dt * 2;
      z.cy += (z.targetCY - z.cy) * dt * 2;
      if (Math.abs(z.radius - z.targetRadius) < 1) {
        z.radius = z.targetRadius;
        z.shrinking = false;
        z.phase++;
        if (z.phase < ZONE_PHASES.length) z.timer = ZONE_PHASES[z.phase].delay;
      }
    }
  }

  // === Zone damage ===
  for (const s of room.ships) {
    if (s.alive && !isInZone(s.x, s.y, z)) {
      damageShip(room, s.slot, ZONE_DPS * dt, -2);
    }
  }

  // === Buff timers ===
  for (const s of room.ships) {
    if (!s.alive) continue;
    if (s.speedBuff > 0) { s.speedBuff -= dt; if (s.speedBuff <= 0) s.speedMult = s.isAI ? s.speedMult : 1.0; }
    if (s.fireBuff > 0) { s.fireBuff -= dt; if (s.fireBuff <= 0) s.fireMult = 1.0; }
  }

  // === Ship movement + AI ===
  for (const s of room.ships) {
    if (!s.alive) continue;
    s.fireTimer -= dt;

    if (s.isAI) {
      // AI logic
      const espd = ENEMY_SPEED_BASE * s.speedMult;
      const eturn = ENEMY_TURN_RATE_BASE;
      const nearest = findNearestTarget(room.ships, s.x, s.y, s.slot);
      const distToNearest = nearest ? nearest.dist : 9999;

      // AI loot seeking
      let lootTarget = null;
      if (s.hp < 5 || !s.torpedoes || !s.mines) {
        let bestLD = 400;
        for (const lc of room.loot) {
          const ld = dist(s.x, s.y, lc.x, lc.y);
          if (ld < bestLD) { bestLD = ld; lootTarget = lc; }
        }
      }

      if (lootTarget && distToNearest > FIRE_RANGE) {
        moveShip(s, lootTarget.x, lootTarget.y, espd, eturn, dt);
      } else if (nearest && distToNearest < FIRE_RANGE * 1.5 && (s.aggressive || distToNearest < FIRE_RANGE * 0.8)) {
        const angleToTgt = Math.atan2(nearest.y - s.y, nearest.x - s.x);
        const strafeAngle = angleToTgt + (Math.sin(room.gameTime + s.slot) > 0 ? Math.PI / 2 : -Math.PI / 2);
        moveShip(s, s.x + Math.cos(strafeAngle) * 200, s.y + Math.sin(strafeAngle) * 200, espd, eturn, dt);
      } else if (!isInZone(s.x, s.y, z)) {
        moveShip(s, z.cx, z.cy, espd * 1.2, eturn, dt);
      } else {
        s.wanderTimer -= dt;
        if (!s.wanderTarget || s.wanderTimer <= 0) {
          s.wanderTarget = {
            x: clamp(z.cx + (Math.random() - 0.5) * z.radius, 100, MAP_W - 100),
            y: clamp(z.cy + (Math.random() - 0.5) * z.radius, 100, MAP_H - 100)
          };
          s.wanderTimer = ENEMY_WANDER_INTERVAL + Math.random() * 2;
        }
        const wd = moveShip(s, s.wanderTarget.x, s.wanderTarget.y, espd, eturn, dt);
        if (wd < 50) s.wanderTimer = 0;
      }

      // AI cannon fire
      if (nearest && distToNearest < FIRE_RANGE && s.fireTimer <= 0) {
        const tgt = room.ships.find(sh => sh.slot === nearest.slot);
        if (tgt && canFire(s, tgt.x, tgt.y) && hasLineOfSight(s.x, s.y, tgt.x, tgt.y)) {
          const fa = getFireAngle(s, tgt.x, tgt.y);
          room.cannonballs.push({ x: s.x, y: s.y, vx: Math.cos(fa) * CANNONBALL_SPEED, vy: Math.sin(fa) * CANNONBALL_SPEED, owner: s.slot, life: 2.0 });
          addSound(room, 'sfx_cannon', s.x, s.y, 0.4);
          s.fireTimer = FIRE_COOLDOWN;
        }
      }

      // AI torpedo
      if (s.torpedoes > 0 && nearest && distToNearest < FIRE_RANGE * 1.2) {
        if (s.torpTimer <= 0) {
          const ta = Math.atan2(nearest.y - s.y, nearest.x - s.x);
          room.torpedoes.push({ x: s.x, y: s.y, vx: Math.cos(ta) * TORPEDO_SPEED, vy: Math.sin(ta) * TORPEDO_SPEED, rotation: ta, owner: s.slot, targetSlot: nearest.slot, life: TORPEDO_LIFE });
          addSound(room, 'sfx_torpedo', s.x, s.y, 0.6);
          s.torpedoes--;
          s.torpTimer = 5 + Math.random() * 3;
        }
      }
      if (s.torpTimer > 0) s.torpTimer -= dt;

      // AI mine
      if (s.mines > 0 && nearest && distToNearest < FIRE_RANGE * 0.7) {
        if (s.mineTimer <= 0) {
          room.mines.push({ x: s.x, y: s.y, owner: s.slot, life: MINE_LIFETIME, armTimer: 1.0 });
          s.mines--;
          s.mineTimer = 8 + Math.random() * 4;
        }
      }
      if (s.mineTimer > 0) s.mineTimer -= dt;

    } else {
      // Human player — follow waypoints
      const spdMult = s.speedBuff > 0 ? 1.5 : 1.0;
      if (s.waypoints.length > 0) {
        // Pop current waypoint when reached
        if (dist(s.x, s.y, s.waypoints[0].x, s.waypoints[0].y) < WAYPOINT_REACH) {
          s.waypoints.shift();
          s._stuckTimer = 0; s._hadSpeed = false; // reset stuck detection on normal reach
          if (s.waypoints.length === 0) { s.vx *= 0.5; s.vy *= 0.5; }
        }
        // Stuck recovery: if ship has been trying to move but can't for a while, skip waypoint
        if (s.waypoints.length > 0) {
          if (!s._stuckTimer) s._stuckTimer = 0;
          if (!s._hadSpeed) s._hadSpeed = false;
          const spd = Math.sqrt(s.vx * s.vx + s.vy * s.vy);
          if (spd > 20) s._hadSpeed = true;
          if (s._hadSpeed && spd < 3) s._stuckTimer += dt;
          else if (spd >= 5) s._stuckTimer = 0;
          if (s._stuckTimer > 8.0) { s.waypoints.shift(); s._stuckTimer = 0; s._hadSpeed = false; }
        }
        if (s.waypoints.length > 0) {
          const target = s.waypoints[0];
          const d = dist(s.x, s.y, target.x, target.y);
          const closeness = Math.max(0, 1 - d / CLOSE_DIST);
          const effTurn = TURN_RATE + (TURN_RATE_CLOSE - TURN_RATE) * closeness;
          let speed = MAX_SPEED * spdMult;
          if (s.waypoints.length === 1 && d < DECEL_DIST) { const tt = d / DECEL_DIST; speed = MIN_SPEED + (speed - MIN_SPEED) * tt * tt; }
          const desA = Math.atan2(target.y - s.y, target.x - s.x);
          const dff = Math.abs(angleWrap(desA - s.rotation));
          const aPen = Math.min(dff / Math.PI, 1);
          speed *= Math.max((1 - closeness * aPen * 0.8) * (1 - 0.4 * aPen), 0.12);
          moveShip(s, target.x, target.y, speed, effTurn, dt);
        }
      } else {
        // Drift
        s.vx *= 0.92; s.vy *= 0.92;
        if (Math.abs(s.vx) < 0.5) s.vx = 0;
        if (Math.abs(s.vy) < 0.5) s.vy = 0;
        const av = getAvoidanceSteer(s.x, s.y);
        s.vx += av.x * 30 * dt; s.vy += av.y * 30 * dt;
        const safe = enforceOutsideIslands(s.x + s.vx * dt, s.y + s.vy * dt);
        s.x = clamp(safe.x, 0, MAP_W); s.y = clamp(safe.y, 0, MAP_H);
      }

      // Human auto-fire cannons
      if (s.fireTimer <= 0) {
        const nearest = findNearestTarget(room.ships, s.x, s.y, s.slot);
        if (nearest && nearest.dist < FIRE_RANGE) {
          const tgt = room.ships.find(sh => sh.slot === nearest.slot);
          if (tgt && canFire(s, tgt.x, tgt.y) && hasLineOfSight(s.x, s.y, tgt.x, tgt.y)) {
            const fa = getFireAngle(s, tgt.x, tgt.y);
            room.cannonballs.push({ x: s.x, y: s.y, vx: Math.cos(fa) * CANNONBALL_SPEED, vy: Math.sin(fa) * CANNONBALL_SPEED, owner: s.slot, life: 2.0 });
            addSound(room, 'sfx_cannon', s.x, s.y, 0.4);
            s.fireTimer = FIRE_COOLDOWN * s.fireMult;
          }
        }
      }
    }

    // Loot pickup (all ships)
    for (let li = room.loot.length - 1; li >= 0; li--) {
      const lc = room.loot[li];
      if (dist(s.x, s.y, lc.x, lc.y) < 35) {
        if (lc.type === 'T') s.torpedoes++;
        else if (lc.type === 'M') s.mines++;
        else if (lc.type === 'H') s.hp = Math.min(MAX_HP, s.hp + 3);
        else if (lc.type === 'S') { s.speedMult = s.isAI ? Math.min(2.0, s.speedMult + 0.3) : 1.5; s.speedBuff = 8; }
        else if (lc.type === 'C') { s.fireMult = 0.5; s.fireBuff = 10; }
        if (!s.isAI) { s.xp += 5; addSound(room, lc.type === 'H' ? 'sfx_heal' : (lc.type === 'S' ? 'sfx_speed' : 'sfx_pickup'), s.x, s.y, 0.7); }
        room.loot.splice(li, 1);
      }
    }
  }

  // === Update cannonballs ===
  const aliveBalls = [];
  for (const ball of room.cannonballs) {
    ball.x += ball.vx * dt; ball.y += ball.vy * dt; ball.life -= dt;
    if (ball.life <= 0 || ball.x < 0 || ball.x > MAP_W || ball.y < 0 || ball.y > MAP_H) continue;

    let hitIsland = false;
    for (const isl of islandCircles) {
      if (dist(ball.x, ball.y, isl.x, isl.y) < isl.r) { hitIsland = true; break; }
    }
    if (hitIsland) continue;

    let hit = false;
    for (const s of room.ships) {
      if (s.slot === ball.owner || !s.alive) continue;
      if (dist(ball.x, ball.y, s.x, s.y) < 25) {
        damageShip(room, s.slot, CANNONBALL_DAMAGE, ball.owner);
        hit = true; break;
      }
    }
    if (hit) continue;
    aliveBalls.push(ball);
  }
  room.cannonballs = aliveBalls;

  // === Update torpedoes ===
  const aliveTorps = [];
  for (const torp of room.torpedoes) {
    // Homing
    const target = room.ships.find(s => s.slot === torp.targetSlot && s.alive);
    if (target) {
      const da = Math.atan2(target.y - torp.y, target.x - torp.x);
      const ca = Math.atan2(torp.vy, torp.vx);
      const dd = angleWrap(da - ca);
      const newA = ca + clamp(dd, -TORPEDO_TURN_RATE * dt, TORPEDO_TURN_RATE * dt);
      torp.vx = Math.cos(newA) * TORPEDO_SPEED; torp.vy = Math.sin(newA) * TORPEDO_SPEED;
    }
    torp.x += torp.vx * dt; torp.y += torp.vy * dt; torp.life -= dt;
    torp.rotation = Math.atan2(torp.vy, torp.vx);
    if (torp.life <= 0 || torp.x < 0 || torp.x > MAP_W || torp.y < 0 || torp.y > MAP_H) continue;

    let explode = false;
    for (const isl of islandCircles) {
      if (dist(torp.x, torp.y, isl.x, isl.y) < isl.r) { explode = true; break; }
    }
    if (!explode) {
      for (const s of room.ships) {
        if (s.slot === torp.owner || !s.alive) continue;
        if (dist(torp.x, torp.y, s.x, s.y) < 30) { explode = true; break; }
      }
    }

    if (explode) {
      room.blasts.push({ x: torp.x, y: torp.y, radius: TORPEDO_BLAST_RADIUS, life: 0.5 });
      addSound(room, 'sfx_torpedo', torp.x, torp.y, 1.0);
      for (const s of room.ships) {
        if (!s.alive) continue;
        if (dist(torp.x, torp.y, s.x, s.y) < TORPEDO_BLAST_RADIUS) {
          // Friendly fire reduced: owner takes less
          const dmg = s.slot === torp.owner ? 1 : TORPEDO_DAMAGE;
          damageShip(room, s.slot, dmg, torp.owner);
        }
      }
      continue;
    }
    aliveTorps.push(torp);
  }
  room.torpedoes = aliveTorps;

  // === Update mines ===
  const aliveMines = [];
  for (const mine of room.mines) {
    mine.life -= dt;
    if (mine.life <= 0) continue;
    if (mine.armTimer > 0) { mine.armTimer -= dt; aliveMines.push(mine); continue; }

    let explode = false;
    for (const s of room.ships) {
      if (!s.alive) continue;
      if (dist(mine.x, mine.y, s.x, s.y) < 40) { explode = true; break; }
    }

    if (explode) {
      room.blasts.push({ x: mine.x, y: mine.y, radius: MINE_BLAST_RADIUS, life: 0.5 });
      addSound(room, 'sfx_mine', mine.x, mine.y, 1.0);
      for (const s of room.ships) {
        if (!s.alive) continue;
        if (dist(mine.x, mine.y, s.x, s.y) < MINE_BLAST_RADIUS) {
          damageShip(room, s.slot, MINE_DAMAGE, mine.owner);
        }
      }
      continue;
    }
    aliveMines.push(mine);
  }
  room.mines = aliveMines;

  // === Sea monsters ===
  for (const sm of room.seaMonsters) {
    sm.timer -= dt;
    if (sm.timer <= 0) { sm.frame = 1 - sm.frame; sm.timer = 0.8 + Math.random() * 0.4; }

    // Move to stay outside zone
    const smDist = dist(sm.x, sm.y, z.cx, z.cy);
    const targetDist = z.radius + 100 + (room.seaMonsters.indexOf(sm) % 3) * 50;
    if (smDist < targetDist || smDist > targetDist + 200) {
      const smAngle = Math.atan2(sm.y - z.cy, sm.x - z.cx);
      const goalX = clamp(z.cx + Math.cos(smAngle) * targetDist, 80, MAP_W - 80);
      const goalY = clamp(z.cy + Math.sin(smAngle) * targetDist, 80, MAP_H - 80);
      sm.x += (goalX - sm.x) * dt * 0.5;
      sm.y += (goalY - sm.y) * dt * 0.5;
    }

    // Collision
    for (const s of room.ships) {
      if (!s.alive) continue;
      if (dist(sm.x, sm.y, s.x, s.y) < 50) {
        addSound(room, 'sfx_kraken', sm.x, sm.y, 1.0);
        damageShip(room, s.slot, MAX_HP, -3);
      }
    }
  }

  // === Blast decay ===
  room.blasts = room.blasts.filter(b => { b.life -= dt; return b.life > 0; });

  // === Periodic loot spawns ===
  room.healthSpawnTimer -= dt;
  if (room.healthSpawnTimer <= 0) {
    room.healthSpawnTimer = 10 + Math.random() * 10;
    const enemiesAlive = room.ships.filter(s => s.alive).length;
    const halfDead = enemiesAlive <= Math.floor(MAX_PLAYERS / 2);
    const spawnType = halfDead ? ['T', 'H', 'S', 'C', 'M'][Math.floor(Math.random() * 5)] : 'H';
    spawnLootInZone(room, spawnType, z.radius);
  }

  // === Broadcast state ===
  const stateMsg = {
    type: 'state',
    ships: room.ships.map(s => ({
      slot: s.slot, x: Math.round(s.x), y: Math.round(s.y),
      rotation: Math.round(s.rotation * 1000) / 1000,
      hp: Math.round(s.hp * 10) / 10, alive: s.alive,
      name: s.name, color: s.color, isAI: s.isAI,
      torpedoes: s.torpedoes, mines: s.mines, waypoints: s.waypoints ? s.waypoints.length : 0,
      speedBuff: s.speedBuff > 0 ? Math.ceil(s.speedBuff) : 0,
      fireBuff: s.fireBuff > 0 ? Math.ceil(s.fireBuff) : 0,
    })),
    cannonballs: room.cannonballs.map(b => ({ x: Math.round(b.x), y: Math.round(b.y), owner: b.owner })),
    torpedoes: room.torpedoes.map(t => ({ x: Math.round(t.x), y: Math.round(t.y), rotation: Math.round(t.rotation * 1000) / 1000 })),
    mines: room.mines.map(m => ({ x: Math.round(m.x), y: Math.round(m.y), armed: m.armTimer <= 0, life: Math.round(m.life) })),
    loot: room.loot.map(l => ({ id: l.id, x: Math.round(l.x), y: Math.round(l.y), type: l.type })),
    zone: { cx: Math.round(z.cx), cy: Math.round(z.cy), radius: Math.round(z.radius), shrinking: z.shrinking, timer: z.shrinking ? 0 : Math.ceil(z.timer), phase: z.phase },
    monsters: room.seaMonsters.map(m => ({ x: Math.round(m.x), y: Math.round(m.y), frame: m.frame, type: m.type })),
    blasts: room.blasts.map(b => ({ x: Math.round(b.x), y: Math.round(b.y), radius: b.radius })),
    time: Math.round(room.gameTime * 10) / 10,
    alive: room.aliveCount,
  };

  const stateData = JSON.stringify(stateMsg);

  // Send state + events + sounds
  for (const p of room.players) {
    if (!p.ws || p.ws.readyState !== 1) continue;
    p.ws.send(stateData);
    // Send personalized events (replace killer/victim name with "You" for the relevant player)
    for (const evt of room.events) {
      const e = { ...evt };
      if (e.killerSlot === p.slot) e.killer = 'You';
      if (e.victimSlot === p.slot) e.victim = 'You';
      p.ws.send(JSON.stringify(e));
    }
    // Send sounds with distance-based volume
    const ship = room.ships.find(s => s.slot === p.slot);
    if (ship) {
      for (const snd of room.sounds) {
        const d = dist(ship.x, ship.y, snd.x, snd.y);
        if (d < 800) {
          const vol = Math.max(0.05, snd.volume * (1 - d / 800));
          p.ws.send(JSON.stringify({ type: 'sound', name: snd.name, x: snd.x, y: snd.y, volume: Math.round(vol * 100) / 100 }));
        }
      }
    }
  }
}

// ========== WEBSOCKET ==========
const http = require('http');
const { WebSocketServer } = require('ws');

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  let playerRoom = null;
  let playerSlot = -1;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'join') {
      let room = findWaitingRoom();
      if (!room) room = createRoom();
      playerRoom = room;

      const usedSlots = new Set(room.players.map(p => p.slot));
      const available = [];
      for (let s = 0; s < MAX_PLAYERS; s++) { if (!usedSlots.has(s)) available.push(s); }
      playerSlot = available[Math.floor(Math.random() * available.length)];

      room.players.push({
        ws, slot: playerSlot,
        name: String(msg.name || 'Anon').slice(0, 20),
        playerId: String(msg.playerId || '').slice(0, 50),
        alive: true, ready: false
      });

      if (!room.countdownInterval) {
        room.countdownInterval = setInterval(() => tickWaiting(room), 1000);
      }

      console.log(`[Room ${room.id}] Player "${msg.name}" joined as slot ${playerSlot} (${room.players.length}/${MAX_PLAYERS})`);
      broadcastRoom(room, { type: 'waiting', players: room.players.length, countdown: room.countdown, names: room.players.map(p => p.name), roomId: room.id });

      if (room.players.length >= MAX_PLAYERS) startGame(room);

    } else if (msg.type === 'skip' && playerRoom && playerRoom.state === 'waiting') {
      const player = playerRoom.players.find(p => p.ws === ws);
      if (player) player.ready = true;
      const allReady = playerRoom.players.every(p => p.ready);
      if (allReady) {
        startGame(playerRoom);
      } else {
        const readyCount = playerRoom.players.filter(p => p.ready).length;
        broadcastRoom(playerRoom, { type: 'waiting', players: playerRoom.players.length, countdown: playerRoom.countdown, names: playerRoom.players.map(p => p.name), roomId: playerRoom.id, ready: readyCount });
      }

    } else if (msg.type === 'waypoint' && playerRoom && playerRoom.state === 'playing') {
      const ship = playerRoom.ships.find(s => s.slot === playerSlot);
      if (!ship || !ship.alive) return;
      let wx = clamp(msg.x, MAP_PAD + 20, MAP_W - MAP_PAD - 20);
      let wy = clamp(msg.y, MAP_PAD + 20, MAP_H - MAP_PAD - 20);
      // Don't place waypoint inside island
      for (const isl of islandCircles) {
        if ((wx - isl.x) * (wx - isl.x) + (wy - isl.y) * (wy - isl.y) < isl.r * isl.r) return;
      }
      // Pathfind from last waypoint or ship pos
      const fx = ship.waypoints.length > 0 ? ship.waypoints[ship.waypoints.length - 1].x : ship.x;
      const fy = ship.waypoints.length > 0 ? ship.waypoints[ship.waypoints.length - 1].y : ship.y;
      let pts = planPath(fx, fy, wx, wy);
      if (pts.length > 8) pts = pts.slice(0, 8);
      for (const pt of pts) {
        if (ship.waypoints.length < 12) { ship.waypoints.push(pt); ship._stuckTimer = 0; ship._hadSpeed = false; }
      }

    } else if (msg.type === 'fireTorpedo' && playerRoom && playerRoom.state === 'playing') {
      const ship = playerRoom.ships.find(s => s.slot === playerSlot);
      if (!ship || !ship.alive || ship.torpedoes <= 0) return;
      const nearest = findNearestTarget(playerRoom.ships, ship.x, ship.y, ship.slot);
      if (!nearest) return;
      const angle = Math.atan2(nearest.y - ship.y, nearest.x - ship.x);
      playerRoom.torpedoes.push({ x: ship.x, y: ship.y, vx: Math.cos(angle) * TORPEDO_SPEED, vy: Math.sin(angle) * TORPEDO_SPEED, rotation: angle, owner: ship.slot, targetSlot: nearest.slot, life: TORPEDO_LIFE });
      addSound(playerRoom, 'sfx_torpedo', ship.x, ship.y, 0.6);
      ship.torpedoes--;
      ship.torpsFired++;

    } else if (msg.type === 'layMine' && playerRoom && playerRoom.state === 'playing') {
      const ship = playerRoom.ships.find(s => s.slot === playerSlot);
      if (!ship || !ship.alive || ship.mines <= 0) return;
      playerRoom.mines.push({ x: ship.x, y: ship.y, owner: ship.slot, life: MINE_LIFETIME, armTimer: 1.0 });
      ship.mines--;
    }
  });

  ws.on('close', () => {
    if (!playerRoom) return;
    if (playerRoom.state === 'waiting') {
      playerRoom.players = playerRoom.players.filter(p => p.ws !== ws);
      if (playerRoom.players.length === 0) {
        clearInterval(playerRoom.countdownInterval);
        rooms = rooms.filter(r => r !== playerRoom);
      }
    } else if (playerRoom.state === 'playing') {
      console.log(`[Room ${playerRoom.id}] Player slot ${playerSlot} disconnected`);
      // Convert to AI
      const ship = playerRoom.ships.find(s => s.slot === playerSlot);
      if (ship && ship.alive) {
        ship.isAI = true;
        ship.aggressive = Math.random() > 0.5;
        ship.wanderTimer = 0;
        room_addEvent(playerRoom, ship.name + ' disconnected');
      }
      playerRoom.players = playerRoom.players.filter(p => p.ws !== ws);
      checkGameOver(playerRoom);
    }
  });
});

function room_addEvent(room, text) {
  room.events.push({ type: 'info', text: text });
}

const PORT = process.env.PORT || 3847;
server.listen(PORT, '127.0.0.1', () => console.log('Warship API (server-authoritative) on port ' + PORT));
