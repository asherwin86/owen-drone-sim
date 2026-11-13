// Drone Sim multiplayer relay.
// A tiny WebSocket server: it tells every player where the other drones are,
// what delivery they are on, and carries the chat. It does not run the game
// (each player's game still runs on their own computer), so it needs very little CPU.
//
// Run:  node server.js        (PORT env var, default 47832)
// Docker: see Dockerfile / README.
const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 47832;
const MAX_PLAYERS = Number(process.env.MAX_PLAYERS) || 100;
const TICK_MS = 200;           // position broadcast rate (5 per second)
const MIN_POS_GAP_MS = 60;     // ignore position spam faster than this
const CHAT_GAP_MS = 800;       // one chat message per player per this long
const MAX_CHAT = 200;
const HISTORY = 40;
const PROTOCOL = 1;

let nextId = 1;
const players = new Map(); // id -> player
const history = [];

const num = (v, lo, hi) => (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : null);
const clean = (s, max) =>
  String(s ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);

function cleanPoint(p) {
  if (!Array.isArray(p)) return null;
  const lat = num(p[0], -90, 90), lon = num(p[1], -180, 180);
  if (lat === null || lon === null) return null;
  return [lat, lon, clean(p[2], 60), clean(p[3], 80)];
}

function cleanJob(j) {
  if (!j || typeof j !== 'object') return null;
  const pk = cleanPoint(j.pk), dr = cleanPoint(j.dr);
  if (!pk || !dr) return null;
  return { ty: clean(j.ty, 16), st: j.st === 'deliver' ? 'deliver' : 'pickup', pk, dr };
}

const info = (p) => ({ id: p.id, name: p.name, drone: p.drone, fly: p.fly, job: p.job });

function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function broadcast(obj, except) {
  const data = JSON.stringify(obj);
  for (const p of players.values()) if (p.ws !== except && p.ws.readyState === 1) p.ws.send(data);
}

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, players: players.size }));
  }
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Drone Sim relay is running. Players online: ' + players.size + '\n');
});

const wss = new WebSocketServer({ server, maxPayload: 4096 });

wss.on('connection', (ws) => {
  if (players.size >= MAX_PLAYERS) {
    send(ws, { t: 'full' });
    return ws.close(1013, 'full');
  }
  const p = {
    id: nextId++, ws, name: '', drone: 'sparrow', fly: 0, job: null,
    pos: null, dirty: false, lastPos: 0, lastChat: 0, alive: true, joined: false,
  };
  ws.on('pong', () => { p.alive = true; });

  ws.on('message', (raw, isBinary) => {
    if (isBinary) return;
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    if (!m || typeof m !== 'object') return;
    const now = Date.now();

    if (m.t === 'hello') {
      if (p.joined) return;
      if (m.v !== PROTOCOL) { send(ws, { t: 'bad-version', need: PROTOCOL }); return ws.close(1008, 'version'); }
      p.name = clean(m.name, 20) || 'Pilot' + p.id;
      p.drone = clean(m.drone, 16) || 'sparrow';
      p.joined = true;
      players.set(p.id, p);
      send(ws, {
        t: 'welcome', id: p.id, online: players.size,
        players: [...players.values()].filter((q) => q !== p).map(info),
        history,
      });
      broadcast({ t: 'join', ...info(p), online: players.size }, ws);
      return;
    }
    if (!p.joined) return;

    if (m.t === 'p') { // position (only while flying)
      if (now - p.lastPos < MIN_POS_GAP_MS) return;
      const lat = num(m.a, -90, 90), lon = num(m.o, -180, 180), h = num(m.h, -1000, 100000);
      const yaw = num(m.y, -10, 10), pit = num(m.pi, -3.2, 3.2), rol = num(m.r, -3.2, 3.2);
      if ([lat, lon, h, yaw, pit, rol].includes(null)) return;
      p.lastPos = now;
      p.pos = [p.id, lat, lon, Math.round(h * 10) / 10, Math.round(yaw * 100) / 100, Math.round(pit * 100) / 100, Math.round(rol * 100) / 100];
      p.dirty = true;
    } else if (m.t === 'i') { // info change: drone, flying flag, current job
      const drone = clean(m.drone, 16);
      if (drone) p.drone = drone;
      p.fly = m.fly ? 1 : 0;
      p.job = p.fly ? cleanJob(m.job) : null;
      if (!p.fly) { p.pos = null; p.dirty = false; }
      broadcast({ t: 'i', ...info(p) }, ws);
    } else if (m.t === 'chat') {
      const text = clean(m.text, MAX_CHAT);
      if (!text || now - p.lastChat < CHAT_GAP_MS) return;
      p.lastChat = now;
      const msg = { t: 'chat', id: p.id, name: p.name, text, at: now };
      history.push(msg);
      if (history.length > HISTORY) history.shift();
      broadcast(msg);
    } else if (m.t === 'name') {
      const name = clean(m.name, 20);
      if (name) { p.name = name; broadcast({ t: 'i', ...info(p) }); }
    }
  });

  ws.on('close', () => {
    if (!p.joined) return;
    players.delete(p.id);
    broadcast({ t: 'leave', id: p.id, online: players.size });
  });
  ws.on('error', () => {});
});

// Position broadcast: one batched message per tick with everyone who moved.
setInterval(() => {
  const moved = [];
  for (const p of players.values()) if (p.dirty && p.pos) { moved.push(p.pos); p.dirty = false; }
  if (moved.length) broadcast({ t: 'p', a: moved });
}, TICK_MS);

// Drop connections that stopped answering.
setInterval(() => {
  for (const p of players.values()) {
    if (!p.alive) { p.ws.terminate(); continue; }
    p.alive = false;
    try { p.ws.ping(); } catch { /* closing */ }
  }
}, 30000);

server.listen(PORT, () => console.log(`Drone Sim relay listening on port ${PORT}`));

process.on('SIGTERM', () => { wss.close(); server.close(() => process.exit(0)); });
process.on('SIGINT', () => process.exit(0));
