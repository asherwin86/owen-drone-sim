// Real places from OpenStreetMap (via the free Overpass API).
// Pickups are real shops/restaurants/pharmacies etc.; drop-offs are real street
// addresses (or hospitals/clinics/depots), so jobs never land in the ocean.
import { distanceM } from './geo.js';

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://z.overpass-api.de/api/interpreter',
  'https://lz4.overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.openstreetmap.fr/api/interpreter',
];

const FOOD_AMENITY = /^(restaurant|fast_food|cafe|ice_cream|food_court|pub|bar)$/;
const HEALTH_AMENITY = /^(pharmacy|clinic|doctors|hospital|dentist)$/;
const FOOD_SHOP = /^(bakery|pastry|deli|butcher|greengrocer|confectionery|convenience|supermarket)$/;
const TRADE_SHOP = /^(trade|doityourself|hardware|building_materials|agrarian|wholesale|electrical|tyres|car_parts)$/;

const cache = new Map(); // "lat,lon,radius" -> { time, places }
const CACHE_MS = 10 * 60 * 1000;

function query(lat, lon, r) {
  const a = `(around:${Math.round(r)},${lat.toFixed(5)},${lon.toFixed(5)})`;
  return `[out:json][timeout:25];(
nwr${a}["name"]["amenity"~"^(restaurant|fast_food|cafe|ice_cream|food_court|pub|bar|pharmacy|clinic|doctors|hospital|dentist|post_office)$"];
nwr${a}["name"]["shop"];
nwr${a}["name"]["office"];
nwr${a}["name"]["man_made"~"^(works|storage_tank)$"];
nwr${a}["name"]["landuse"~"^(industrial|construction|depot)$"];
nwr${a}["name"]["building"~"^(warehouse|industrial|retail|commercial)$"];
nwr${a}["addr:housenumber"]["addr:street"];
);out center tags 6000;`;
}

function addrOf(t) {
  const street = t['addr:street'];
  const num = t['addr:housenumber'];
  if (!street && !num) return '';
  const line = [num, street].filter(Boolean).join(' ');
  const place = t['addr:suburb'] || t['addr:city'] || t['addr:town'] || t['addr:village'] || '';
  return place ? `${line}, ${place}` : line;
}

function classify(t) {
  const kinds = new Set();
  const am = t.amenity || '', shop = t.shop || '', b = t.building || '';
  if (FOOD_AMENITY.test(am) || FOOD_SHOP.test(shop)) kinds.add('food');
  if (HEALTH_AMENITY.test(am)) kinds.add('health');
  if (am === 'post_office') kinds.add('post');
  if (shop && !FOOD_SHOP.test(shop)) kinds.add('shop');
  if (TRADE_SHOP.test(shop) || /^(warehouse|industrial)$/.test(b) || /^(works|storage_tank)$/.test(t.man_made || '') ||
      /^(industrial|construction|depot)$/.test(t.landuse || '')) kinds.add('industrial');
  if (t.office || /^(retail|commercial)$/.test(b)) kinds.add('commercial');
  return kinds;
}

function parse(json) {
  const out = [];
  const seen = new Set();
  for (const e of json.elements || []) {
    const t = e.tags || {};
    const lat = e.lat ?? e.center?.lat;
    const lon = e.lon ?? e.center?.lon;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const addr = addrOf(t);
    const name = (t.name || '').trim();
    const kinds = name ? classify(t) : new Set();
    const isHome = !name && !!addr;           // an addressed building with no business name
    if (!kinds.size && !isHome && !(name && addr)) continue;
    const key = (name || addr) + '|' + lat.toFixed(4) + lon.toFixed(4);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, addr, lat, lon, kinds, isHome });
  }
  return out;
}

// Ask every mirror at once and take the first good answer (public servers are often busy).
async function overpass(lat, lon, r) {
  const body = 'data=' + encodeURIComponent(query(lat, lon, r));
  const ctls = [];
  const tries = ENDPOINTS.map(async (url) => {
    const ctl = new AbortController();
    ctls.push(ctl);
    const timer = setTimeout(() => ctl.abort(), 25000);
    try {
      const res = await fetch(url, {
        method: 'POST', signal: ctl.signal,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body,
      });
      if (!res.ok) throw new Error('Overpass HTTP ' + res.status);
      return parse(await res.json());
    } finally {
      clearTimeout(timer);
    }
  });
  try {
    return await Promise.any(tries);
  } catch {
    throw new Error('Overpass unavailable');
  } finally {
    for (const c of ctls) c.abort();
  }
}

/** All usable real places within `radius` metres of (lat, lon). Cached (memory + disk) for a while. */
export async function loadPlaces(lat, lon, radius) {
  const key = `${lat.toFixed(3)},${lon.toFixed(3)},${Math.round(radius / 250)}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.time < CACHE_MS) return hit.places;
  const disk = readDisk(key);
  if (disk) { cache.set(key, disk); return disk.places; }
  const places = await overpass(lat, lon, radius);
  const rec = { time: Date.now(), places };
  cache.set(key, rec);
  writeDisk(key, places);
  return places;
}

// Places don't change quickly: keep answers for a day so we ask the public servers less.
const DISK_PREFIX = 'dronesim.places.';
const DISK_MS = 24 * 60 * 60 * 1000;
function readDisk(key) {
  try {
    const raw = localStorage.getItem(DISK_PREFIX + key);
    if (!raw) return null;
    const rec = JSON.parse(raw);
    if (Date.now() - rec.time > DISK_MS) return null;
    rec.places.forEach((p) => { p.kinds = new Set(p.kinds); });
    return rec;
  } catch { return null; }
}
function writeDisk(key, places) {
  try {
    // Drop old entries first so we never fill the storage.
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && k.startsWith(DISK_PREFIX) && k !== DISK_PREFIX + key) {
        try { if (Date.now() - JSON.parse(localStorage.getItem(k)).time > DISK_MS) localStorage.removeItem(k); } catch { localStorage.removeItem(k); }
      }
    }
    localStorage.setItem(DISK_PREFIX + key, JSON.stringify({ time: Date.now(), places: places.map((p) => ({ ...p, kinds: [...p.kinds] })) }));
  } catch { /* storage full or unavailable: fine */ }
}

// Which real places suit each job type.
const SPEC = {
  food:    { pickup: (p) => p.kinds.has('food'), drop: (p) => p.isHome, homeLabel: true },
  parcel:  { pickup: (p) => p.kinds.has('post') || p.kinds.has('shop'), drop: (p) => p.isHome, homeLabel: true },
  medical: { pickup: (p) => p.kinds.has('health'), drop: (p) => p.kinds.has('health') || p.isHome, homeLabel: true },
  freight: { pickup: (p) => p.kinds.has('industrial'), drop: (p) => p.kinds.has('industrial') || p.kinds.has('commercial'), homeLabel: false },
};

/** How a place is shown in the UI. */
export function placeLabel(p, homeLabel) {
  if (p.name) return p.name;
  return homeLabel ? `Home at ${p.addr}` : p.addr;
}

/**
 * Pick a real pickup and drop-off for a job.
 * opts: { minDist, maxDist, maxPick, maxRoute } in metres. Returns null when nothing fits.
 */
export function pickJobPlaces(places, type, from, opts, used = new Set()) {
  const spec = SPEC[type];
  if (!spec) return null;
  const rnd = (n) => Math.floor(Math.random() * n);
  const near = places
    .map((p) => ({ p, d: distanceM(from.lat, from.lon, p.lat, p.lon) }))
    .filter((x) => !used.has(x.p));
  let pickups = near.filter((x) => spec.pickup(x.p) && x.d >= 60 && x.d <= opts.maxPick);
  if (!pickups.length) pickups = near.filter((x) => spec.pickup(x.p) && x.d >= 60).sort((a, b) => a.d - b.d).slice(0, 5);
  if (!pickups.length) return null;

  for (let tries = 0; tries < 30; tries++) {
    const pk = pickups[rnd(pickups.length)];
    const drops = places
      .filter((q) => q !== pk.p && !used.has(q) && spec.drop(q))
      .map((q) => ({ p: q, d: distanceM(pk.p.lat, pk.p.lon, q.lat, q.lon) }))
      .filter((x) => x.d >= opts.minDist && x.d <= opts.maxDist && pk.d + x.d <= opts.maxRoute);
    if (!drops.length) continue;
    const dr = drops[rnd(drops.length)];
    return { pickup: pk.p, drop: dr.p, dPick: pk.d, dDel: dr.d, homeLabel: spec.homeLabel };
  }
  // Relax: shorter deliveries than the type's usual minimum are fine in sparse areas.
  for (const pk of pickups) {
    const drops = places
      .filter((q) => q !== pk.p && !used.has(q) && spec.drop(q))
      .map((q) => ({ p: q, d: distanceM(pk.p.lat, pk.p.lon, q.lat, q.lon) }))
      .filter((x) => x.d >= 150 && x.d <= opts.maxDist && pk.d + x.d <= opts.maxRoute);
    if (drops.length) {
      const dr = drops[rnd(drops.length)];
      return { pickup: pk.p, drop: dr.p, dPick: pk.d, dDel: dr.d, homeLabel: spec.homeLabel };
    }
  }
  return null;
}
