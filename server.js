// Tiny local web server for Drone Sim.
// - Serves the game files (only the folders the game needs).
// - Saves/loads the player's save file and the Google Maps key config.
// Used by main.js (Electron) and can also be run alone: `node server.js`
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = __dirname;
const SAVE_DIR = path.join(os.homedir(), 'DroneSim');
const SAVE_FILE = path.join(SAVE_DIR, 'save.json');
// Keys live in the user's own folder (not the game folder) so they survive
// updates/re-downloads, never end up in git, and the folder is always writable.
const CONFIG_FILE = path.join(SAVE_DIR, 'config.json');
const LEGACY_CONFIG_FILE = path.join(ROOT, 'config.json');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.xml': 'application/xml',
  '.txt': 'text/plain; charset=utf-8',
};

// Only these paths are ever served as files.
const ALLOWED_PREFIXES = [
  '/index.html',
  '/css/',
  '/js/',
  '/assets/',
  '/concept/',
  '/node_modules/cesium/Build/Cesium/',
  '/node_modules/earcut/src/',
];

const DEFAULT_CONFIG = { googleMapsApiKey: '', cesiumIonToken: '' };

let quitHandler = null;
let standalone = true;

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function loadConfig() {
  // Prefer the user-folder config; fall back to an older config.json next to the game.
  const legacy = readJson(LEGACY_CONFIG_FILE, {});
  return { ...DEFAULT_CONFIG, ...legacy, ...readJson(CONFIG_FILE, {}) };
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 1024 * 1024) {
        reject(new Error('Body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function hostIsLocal(req) {
  const host = (req.headers.host || '').split(':')[0];
  return host === '127.0.0.1' || host === 'localhost';
}

async function handleApi(req, res, pathname) {
  if (pathname === '/api/config') {
    if (req.method === 'GET') {
      return send(res, 200, JSON.stringify(loadConfig()));
    }
    if (req.method === 'POST') {
      const incoming = JSON.parse((await readBody(req)) || '{}');
      const current = loadConfig();
      for (const k of Object.keys(DEFAULT_CONFIG)) {
        if (typeof incoming[k] === 'string') current[k] = incoming[k].trim();
      }
      try {
        writeJson(CONFIG_FILE, current);
      } catch (e) {
        return send(res, 500, JSON.stringify({ ok: false, error: `Could not write ${CONFIG_FILE}: ${e.message}` }));
      }
      return send(res, 200, JSON.stringify({ ok: true, file: CONFIG_FILE }));
    }
  }
  if (pathname === '/api/save') {
    if (req.method === 'GET') {
      return send(res, 200, JSON.stringify(readJson(SAVE_FILE, null)));
    }
    if (req.method === 'POST') {
      const data = JSON.parse((await readBody(req)) || 'null');
      if (data && typeof data === 'object') writeJson(SAVE_FILE, data);
      return send(res, 200, JSON.stringify({ ok: true }));
    }
  }
  if (pathname === '/api/quit' && req.method === 'POST') {
    send(res, 200, JSON.stringify({ ok: true, standalone }));
    if (quitHandler) setTimeout(quitHandler, 100);
    return;
  }
  return send(res, 404, JSON.stringify({ error: 'not found' }));
}

function handleStatic(req, res, pathname) {
  if (pathname === '/') pathname = '/index.html';
  if (!ALLOWED_PREFIXES.some((p) => pathname === p || pathname.startsWith(p))) {
    return send(res, 404, 'Not found', 'text/plain');
  }
  const filePath = path.normalize(path.join(ROOT, pathname));
  if (!filePath.startsWith(ROOT + path.sep)) {
    return send(res, 403, 'Forbidden', 'text/plain');
  }
  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'Not found', 'text/plain');
    const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
    fs.createReadStream(filePath).pipe(res);
  });
}

async function handler(req, res) {
  try {
    if (!hostIsLocal(req)) return send(res, 403, 'Forbidden', 'text/plain');
    const url = new URL(req.url, 'http://127.0.0.1');
    const pathname = decodeURIComponent(url.pathname);
    if (pathname.startsWith('/api/')) return await handleApi(req, res, pathname);
    return handleStatic(req, res, pathname);
  } catch (e) {
    console.error(e);
    send(res, 500, JSON.stringify({ error: String(e.message || e) }));
  }
}

function startServer(port = 0, opts = {}) {
  quitHandler = opts.onQuit || null;
  standalone = !opts.onQuit;
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

module.exports = { startServer };

if (require.main === module) {
  const port = Number(process.env.PORT) || 47831;
  startServer(port).then(({ port: p }) => {
    console.log(`Drone Sim server running at http://127.0.0.1:${p}/`);
  });
}
