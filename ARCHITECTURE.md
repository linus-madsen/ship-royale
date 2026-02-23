# Ship Royale — Architecture & Design Notes

## Navigation System

### How it works
- **Player taps** → waypoint placed at exact tap location (rejected if inside an island)
- **Ship moves** toward waypoints sequentially, popping each one when reached (`WAYPOINT_REACH = 20px`)
- **Island avoidance** is handled in real-time by `moveShip()` → `getAvoidanceSteer()` — a force-based steering system that pushes the ship away from nearby islands
- **`enforceOutsideIslands()`** is a hard safety clamp after each position update (prevents clipping into islands)
- No waypoint limit — players can queue as many as they want

### Key constants
- `AVOIDANCE_RANGE = 100` — distance at which islands start repelling the ship
- `AVOIDANCE_FORCE = 3.0` — strength of the repulsion
- `WAYPOINT_REACH = 20` — how close the ship needs to be to consume a waypoint

### ⚠️ Known pitfall: waypoint marker sync race condition
The client creates a yellow dot immediately on tap for instant feedback. The server syncs waypoint count back each tick. When the ship is **stopped**, the server can consume the waypoint in the same tick it receives it (ship is already at or near the destination), causing `serverCount = 0` before the client sees the dot.

**Fix (do not remove):** `lastWaypointAddedAt` timestamp + 500ms grace period in the sync logic. During this window, the client won't clear markers even if the server says 0 waypoints. This gives the server time to process the waypoint before the client syncs.

**If you ever refactor waypoint sync, preserve this grace period or you'll get invisible first-waypoints when the ship is stationary.**

### What we removed (and why)
Previously there was a recursive pathfinding system (`planPath` → `resolveSegment` → `getBypassPoints`) that generated intermediate waypoints around islands. This fought with the real-time avoidance steering, causing unpredictable behavior. The stuck timer (8s watchdog that skipped waypoints) was a band-aid on top.

Now the ship just goes where you tap and steers around islands dynamically — same system the AI uses.

## Combat
- **Broadside cannons** — auto-fire when enemy is in range and angle (forward cone or broadside arcs)
- **Torpedoes** — heat-seeking (`TORPEDO_TURN_RATE = 0.8 rad/s`), 3 HP damage, 120px blast radius, pickup-based
- **Mines** — placed at ship position, 1s arming delay (blink animation), pickup-based

## AI Behavior
- 11 AI pirates, ~1/3 aggressive (engage from further away)
- Priority: seek loot (if low HP/ammo) → fight nearby enemies → flee zone → wander
- Uses same `moveShip()` + avoidance steering as players
- Strafes during combat (sinusoidal angle offset)

## Zone ("The Abyss")
- Shrinks over time toward a random center point
- Sea monsters (kraken/serpent) patrol outside the ring, instant kill on contact
- Ships outside the zone take tick damage

## Stack
- **Client:** Single `index.html`, Phaser 3 via CDN, NES.css + Press Start 2P font
- **Server:** `api/server.js` — Express + WebSocket + SQLite (XP/leaderboard)
- **Hosting:** nginx at `aidia.games/ship-royale/`, API proxied via `/ship-royale/api/` and `/warship/api/`
