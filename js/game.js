// Drone Sim - main game controller.
import { DRONES, JOB_TYPES, LANDMARKS, DEFAULT_SAVE, droneRange } from './data.js';
import { World } from './world.js';
import { Flight, Input } from './flight.js';
import { createDroneModel } from './droneModel.js';
import { Sfx } from './audio.js';
import { PadNav } from './gamepad.js';
import { loadPlaces, pickJobPlaces, placeLabel } from './places.js';
import { Multiplayer } from './multiplayer.js';
import { destination, distanceM, bearingRad, clamp, formatDist, formatMoney, formatTime } from './geo.js';

const Cesium = window.Cesium;
const $ = (s) => document.querySelector(s);
const CAPTURE_R = 18; // metres: how close you must get to a beacon

const state = {
  cfg: {},
  save: null,
  world: null,
  flight: null,
  input: new Input(),
  sfx: new Sfx(),
  mode: 'menu', // menu | hub | settings | loading | flying | paused | result
  tab: 'jobs',
  cat: 'food',
  jobs: [],
  jobsStatus: 'loading', // loading | ready | empty | error
  mp: null,
  chat: [],
  models: {},
  focus: { lat: 48.8584, lon: 2.2945, h: 40 },
  orbitHeading: 0.6,
  run: null,
  last: performance.now(),
};

// ------------------------------------------------------------ helpers
function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k === 'html') e.innerHTML = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) e.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return e;
}
const rnd = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const round5 = (n) => Math.max(5, Math.round(n / 5) * 5);
const currentDrone = () => DRONES.find((d) => d.id === state.save.drone) || DRONES[0];

function toast(text, kind = '') {
  const t = el('div', { class: 'toast ' + kind }, text);
  $('#toasts').append(t);
  setTimeout(() => t.remove(), 3300);
}

let persistTimer = null;
function persist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    fetch('/api/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(state.save) }).catch(() => {});
  }, 150);
}

// Landmarks are teleport targets: start 160 m beside them (not inside the building).
function landmarkSpawn(l) {
  return destination(l.lat, l.lon, (200 * Math.PI) / 180, 160);
}

function mergeSave(s) {
  const base = JSON.parse(JSON.stringify(DEFAULT_SAVE));
  const lm = LANDMARKS[0];
  const sp = landmarkSpawn(lm);
  base.lat = sp.lat;
  base.lon = sp.lon;
  if (!s || typeof s !== 'object') return base;
  const m = { ...base, ...s, stats: { ...base.stats, ...(s.stats || {}) }, settings: { ...base.settings, ...(s.settings || {}) } };
  if (!Array.isArray(m.owned) || !m.owned.includes('sparrow')) m.owned = ['sparrow', ...(m.owned || [])];
  if (!DRONES.find((d) => d.id === m.drone)) m.drone = 'sparrow';
  if (!Number.isFinite(m.lat) || !Number.isFinite(m.lon)) { m.lat = base.lat; m.lon = base.lon; }
  // Older saves may sit exactly on a landmark's centre (inside it): move them beside it.
  for (const l of LANDMARKS) {
    if (Math.abs(m.lat - l.lat) < 1e-5 && Math.abs(m.lon - l.lon) < 1e-5) {
      const p = landmarkSpawn(l);
      m.lat = p.lat;
      m.lon = p.lon;
    }
  }
  return m;
}

// ------------------------------------------------------------ screens
const SCREENS = ['menu', 'hub', 'settings', 'loading', 'pause', 'result'];
function showScreen(name) {
  for (const s of SCREENS) $('#screen-' + s).classList.toggle('hidden', s !== name);
  $('#hud').classList.toggle('hidden', !(state.mode === 'flying' || state.mode === 'paused'));
  document.body.classList.toggle('flying', state.mode === 'flying');
}

function setMode(mode, screen) {
  state.mode = mode;
  state.input.clearPresses(); // don't carry old button presses into the next screen
  state.input.capture = mode === 'flying';
  showScreen(screen || (mode === 'flying' ? '' : mode));
  if (state.mp) updateChatVisibility();
}

function updateWorldStatus() {
  const w = state.world;
  const chip = $('#world-status');
  chip.textContent = '🌍 ' + w.statusText;
  chip.classList.toggle('good', w.mode !== 'basic');
}

// ------------------------------------------------------------ focus / orbit camera
function setFocus(lat, lon) {
  state.focus = { lat, lon, h: state.focus.h };
  state.world.setDaylight(lon, lat);
  state.world.sampleGround([{ lat, lon }]).then(([h]) => {
    if (state.focus.lat === lat && state.focus.lon === lon) state.focus.h = h + 25;
  });
}

function orbit(dt) {
  const cam = state.world.viewer.camera;
  const f = state.focus;
  state.world.updateOpen(f.lat, f.lon);
  state.orbitHeading += dt * (state.mode === 'menu' ? 0.07 : 0.04);
  const center = Cesium.Cartesian3.fromDegrees(f.lon, f.lat, f.h);
  const range = state.mode === 'menu' ? 520 : 700;
  cam.lookAt(center, new Cesium.HeadingPitchRange(state.orbitHeading, -0.36, range));
  cam.lookAtTransform(Cesium.Matrix4.IDENTITY);
}

// ------------------------------------------------------------ jobs
// Jobs use REAL places from OpenStreetMap: shops/restaurants/clinics to pick up from,
// and real street addresses (or hospitals, depots) to deliver to.
function makeJob(type, drone, range, places, used) {
  const maxRoute = 0.68 * range;
  const found = pickJobPlaces(places, type.id, state.save, {
    minDist: type.minDist, maxDist: Math.min(type.maxDist, maxRoute), maxPick: clamp(0.3 * range, 600, 2500), maxRoute,
  }, used);
  if (!found) return null;
  used.add(found.pickup); used.add(found.drop);
  const cargo = Math.round(rnd(type.cargo[0], type.cargo[1]) * 10) / 10;
  const { dPick, dDel } = found;
  const route = dPick + dDel;
  const avg = drone.maxSpeed * type.speedMul;
  const timeLimit = Math.round((route / avg + 30) / 5) * 5;
  const pk = found.pickup, dr = found.drop;
  return {
    id: Math.random().toString(36).slice(2),
    type: type.id,
    cargo, dPick, dDel, timeLimit,
    pay: round5(type.base + type.rate * dDel),
    pickup: { lat: pk.lat, lon: pk.lon, name: placeLabel(pk, false), addr: pk.addr },
    drop: { lat: dr.lat, lon: dr.lon, name: placeLabel(dr, found.homeLabel), addr: dr.addr },
    locked: cargo > drone.cargo,
  };
}

let jobsToken = 0;
async function genJobs() {
  const token = ++jobsToken;
  const drone = currentDrone();
  const range = droneRange(drone);
  const { lat, lon } = state.save;
  state.jobs = [];
  state.jobsStatus = 'loading';
  refreshJobsView();
  try {
    const places = await loadPlaces(lat, lon, clamp(0.68 * range, 1500, 5000));
    if (token !== jobsToken) return;
    const used = new Set();
    const jobs = [];
    for (const type of JOB_TYPES) {
      for (let i = 0; i < 3; i++) {
        const j = makeJob(type, drone, range, places, used);
        if (j) jobs.push(j);
      }
    }
    state.jobs = jobs;
    state.jobsStatus = jobs.length ? 'ready' : 'empty';
  } catch (e) {
    if (token !== jobsToken) return;
    console.warn('Could not load real places', e);
    state.jobsStatus = 'error';
  }
  refreshJobsView();
}

function refreshJobsView() {
  if (state.mode === 'hub' && state.tab === 'jobs') renderJobs();
}

// ------------------------------------------------------------ hub UI
function droneIcon(spec) {
  const N = spec.arms;
  let s = '<svg class="drone-icon" viewBox="-50 -50 100 100">';
  for (let i = 0; i < N; i++) {
    const a = ((i + 0.5) / N) * Math.PI * 2;
    const x = Math.sin(a) * 33, y = -Math.cos(a) * 33;
    s += `<line x1="0" y1="0" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" stroke="#aab4c8" stroke-width="4"/>`;
    s += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${N === 4 ? 14 : 11}" fill="${spec.accent}" fill-opacity="0.45" stroke="#cfd8ea" stroke-width="1.5"/>`;
  }
  s += `<rect x="-11" y="-18" width="22" height="36" rx="8" fill="${spec.color}"/><rect x="-6" y="-24" width="12" height="5" rx="2" fill="#34ff7a"/></svg>`;
  return s;
}

function refreshHubHeader() {
  $('#hub-money').textContent = formatMoney(state.save.money);
  $('#hub-drone').textContent = '🚁 ' + currentDrone().name;
  $('#hub-place').textContent = '📍 ' + state.save.placeName;
}

function showTab(tab) {
  state.tab = tab;
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  for (const t of ['jobs', 'drones', 'world', 'online']) $('#tab-' + t).classList.toggle('hidden', t !== tab);
  renderTab();
}

function renderTab() {
  refreshHubHeader();
  if (state.tab === 'jobs') renderJobs();
  else if (state.tab === 'drones') renderDrones();
  else if (state.tab === 'online') renderOnlineTab();
  else renderWorldTab();
}

function renderJobs() {
  const root = $('#tab-jobs');
  const drone = currentDrone();
  root.replaceChildren();
  const chips = el('div', { class: 'chips' });
  for (const t of JOB_TYPES) {
    const lockedAll = t.cargo[0] > drone.cargo;
    chips.append(el('button', {
      class: 'cat' + (state.cat === t.id ? ' active' : ''),
      onclick: () => { state.sfx.click(); state.cat = t.id; renderJobs(); },
    }, `${t.icon} ${t.name}`, lockedAll ? el('span', { class: 'lock' }, ' 🔒') : null));
  }
  chips.append(el('button', { class: 'btn small', onclick: () => { state.sfx.click(); genJobs(); } }, '↻ New jobs'));
  root.append(chips);

  const type = JOB_TYPES.find((t) => t.id === state.cat);
  if (state.jobsStatus === 'loading') {
    root.append(el('div', { class: 'muted note' }, '🗺 Finding real shops and addresses near ' + state.save.placeName + '…'));
    return;
  }
  if (state.jobsStatus === 'error') {
    root.append(el('div', { class: 'muted note' }, '⚠ Could not reach OpenStreetMap to find real addresses. Check your internet, then try again. ',
      el('button', { class: 'btn small', onclick: () => genJobs() }, 'Try again')));
    return;
  }
  if (state.jobsStatus === 'empty') {
    root.append(el('div', { class: 'muted note' }, 'No mapped shops or addresses found here (open sea or wilderness?). Pick a town or city in the World tab.'));
    return;
  }
  const typeJobs = state.jobs.filter((j) => j.type === type.id);
  if (!typeJobs.length) {
    root.append(el('div', { class: 'muted note' }, `No ${type.name.toLowerCase()} places mapped near here. Try another category or move in the World tab.`));
    return;
  }
  for (const job of typeJobs) {
    const btn = el('button', {
      class: 'btn primary', disabled: job.locked,
      onclick: () => { state.sfx.click(); startFlight(job); },
    }, job.locked ? '🔒 Locked' : 'Start');
    root.append(el('div', { class: 'card' + (job.locked ? ' locked' : '') },
      el('div', { class: 'icon' }, type.icon),
      el('div', { class: 'info' },
        el('div', { class: 'name' }, `${job.pickup.name} → ${job.drop.name}`),
        el('div', { class: 'sub' }, job.locked ? `Needs a drone that can carry ${job.cargo} kg` : `Carry ${job.cargo} kg across ${formatDist(job.dDel)}`),
        el('div', { class: 'addr' }, [job.pickup.addr && '📍 ' + job.pickup.addr, job.drop.addr && '🏠 ' + job.drop.addr].filter(Boolean).join('   →   ')),
        el('div', { class: 'meta' },
          el('span', {}, `📏 ${formatDist(job.dPick + job.dDel)} total`),
          el('span', {}, `⏱ ${formatTime(job.timeLimit)}`),
          el('span', {}, `⚖ ${job.cargo} kg`))),
      el('div', { class: 'right' }, el('div', { class: 'price' }, formatMoney(job.pay), el('small', {}, '+ speed bonus')), btn)));
  }
}

function statBar(label, frac) {
  return [el('span', {}, label), el('div', { class: 'bar' }, el('i', { style: `width:${Math.round(clamp(frac, 0.04, 1) * 100)}%` }))];
}

function renderDrones() {
  const root = $('#tab-drones');
  root.replaceChildren();
  const maxes = { speed: 70, batt: 1300, cargo: 28 };
  for (const d of DRONES) {
    const owned = state.save.owned.includes(d.id);
    const equipped = state.save.drone === d.id;
    let action;
    if (equipped) action = el('button', { class: 'btn', disabled: true }, '✔ Equipped');
    else if (owned) action = el('button', { class: 'btn primary', onclick: () => equipDrone(d.id) }, 'Equip');
    else action = el('button', {
      class: 'btn primary', disabled: state.save.money < d.price,
      onclick: () => buyDrone(d.id),
    }, state.save.money < d.price ? `Need ${formatMoney(d.price - state.save.money)} more` : 'Buy');
    root.append(el('div', { class: 'card' },
      el('div', { class: 'icon', html: droneIcon(d) }),
      el('div', { class: 'info' },
        el('div', { class: 'name' }, d.name),
        el('div', { class: 'sub' }, d.blurb),
        el('div', { class: 'statbars' },
          ...statBar('Speed', d.maxSpeed / maxes.speed),
          ...statBar('Battery', d.battery / maxes.batt),
          ...statBar('Cargo', d.cargo / maxes.cargo))),
      el('div', { class: 'right' },
        el('div', { class: 'price' }, owned ? 'Owned' : formatMoney(d.price), el('small', {}, `${d.maxSpeed} m/s · ${d.cargo} kg`)),
        action)));
  }
}

function buyDrone(id) {
  const d = DRONES.find((x) => x.id === id);
  if (!d || state.save.owned.includes(id) || state.save.money < d.price) return;
  state.save.money -= d.price;
  state.save.owned.push(id);
  state.save.drone = id;
  state.sfx.buy();
  toast(`You bought the ${d.name}!`, 'good');
  genJobs();
  persist();
  renderTab();
}

function equipDrone(id) {
  state.save.drone = id;
  state.sfx.click();
  genJobs();
  persist();
  renderTab();
}

function goTo(lat, lon, name) {
  state.save.lat = lat;
  state.save.lon = lon;
  state.save.placeName = name;
  setFocus(lat, lon);
  genJobs();
  persist();
  state.sfx.click();
  toast('📍 Moved to ' + name, 'good');
  refreshHubHeader();
}

function renderWorldTab() {
  const root = $('#tab-world');
  root.replaceChildren();
  const input = el('input', { type: 'text', placeholder: 'Search any place on Earth (e.g. Mount Fuji, my school, Sydney)…' });
  const results = el('div', { class: 'worldgrid' });
  const doSearch = async () => {
    const q = input.value.trim();
    if (!q) return;
    results.replaceChildren(el('span', { class: 'muted' }, 'Searching…'));
    try {
      const data = await state.world.searchPlaces(q);
      results.replaceChildren();
      if (!data.length) results.append(el('span', { class: 'muted' }, 'No places found. Try another name.'));
      for (const p of data) {
        results.append(el('button', { class: 'worldcard', onclick: () => goTo(p.lat, p.lon, p.name) },
          el('b', {}, p.name), el('span', {}, p.detail)));
      }
    } catch {
      results.replaceChildren(el('span', { class: 'muted' }, 'Could not search (no internet?). Pick a landmark below.'));
    }
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });
  if (state.world.searchMode === 'none') {
    // Google's rules: with Google 3D tiles we may only search with Google's geocoder.
    input.disabled = true;
    input.placeholder = 'Search needs a free Cesium token (Settings). Pick a place below.';
  }
  root.append(el('div', { class: 'searchrow' }, input, el('button', { class: 'btn', disabled: state.world.searchMode === 'none', onclick: doSearch }, '🔎 Search')), results);
  if (state.world.searchMode === 'google') root.append(el('div', { class: 'muted', style: 'font-size:12px;margin-top:-6px' }, 'Place search by Google'));
  root.append(el('h3', {}, 'Famous places'));
  const grid = el('div', { class: 'worldgrid' });
  for (const l of LANDMARKS) {
    grid.append(el('button', { class: 'worldcard', onclick: () => { const p = landmarkSpawn(l); goTo(p.lat, p.lon, l.name); } }, el('b', {}, l.name), el('span', {}, l.place)));
  }
  root.append(grid);
}

// ------------------------------------------------------------ settings
function openSettings(from) {
  state.settingsFrom = from;
  const s = state.save.settings;
  $('#set-google').value = state.cfg.googleMapsApiKey || '';
  $('#set-ion').value = state.cfg.cesiumIonToken || '';
  $('#set-quality').value = s.quality;
  $('#set-units').value = s.units;
  $('#set-volume').value = s.volume;
  $('#set-collide').value = s.collisions ? 'on' : 'off';
  $('#set-rumble').value = s.rumble === false ? 'off' : 'on';
  $('#set-map').value = s.mapSource === 'free' ? 'free' : 'auto';
  $('#set-name').value = s.playerName || '';
  $('#set-server').value = s.mpUrl || '';
  $('#settings-note').replaceChildren();
  setMode('settings');
}

async function saveSettings() {
  const s = state.save.settings;
  const newCfg = fixSwappedKeys({ googleMapsApiKey: $('#set-google').value.trim(), cesiumIonToken: $('#set-ion').value.trim() });
  $('#set-google').value = newCfg.googleMapsApiKey;
  $('#set-ion').value = newCfg.cesiumIonToken;
  const keyChanged = newCfg.googleMapsApiKey !== (state.cfg.googleMapsApiKey || '') || newCfg.cesiumIonToken !== (state.cfg.cesiumIonToken || '');
  s.quality = $('#set-quality').value;
  s.units = $('#set-units').value;
  s.volume = parseFloat($('#set-volume').value);
  s.collisions = $('#set-collide').value === 'on';
  const newMap = $('#set-map').value;
  const mapChanged = newMap !== (s.mapSource === 'free' ? 'free' : 'auto');
  s.mapSource = newMap;
  s.rumble = $('#set-rumble').value === 'on';
  const oldMp = (s.mpUrl || '') + '|' + (s.playerName || '');
  s.playerName = $('#set-name').value.trim().slice(0, 20);
  s.mpUrl = $('#set-server').value.trim();
  state.input.rumbleOn = s.rumble;
  state.sfx.setVolume(s.volume);
  state.world.applyQuality(s.quality);
  persist();
  if (oldMp !== (s.mpUrl || '') + '|' + (s.playerName || '')) { const m = mpSettings(); state.mp.start(m.url, m.name); }
  const note = $('#settings-note');
  note.replaceChildren();
  note.style.color = '';
  if (keyChanged) {
    try {
      const r = await fetch('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(newCfg) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.ok === false) throw new Error(j.error || 'HTTP ' + r.status);
      state.cfg = { ...state.cfg, ...newCfg };
      note.append('Saved! Restart the game to load the new map. ', el('button', { class: 'btn small', onclick: () => location.reload() }, 'Restart now'));
    } catch (e) {
      note.style.color = 'var(--red)';
      const offline = e instanceof TypeError;
      note.append(offline
        ? '⚠ Could not save: the game server is not running. Start the game again (start-game.bat, or "npm run web"), then reload this page and try again.'
        : '⚠ Could not save the keys: ' + e.message);
    }
  } else if (mapChanged) {
    note.append('Saved! Restart the game to switch the map. ', el('button', { class: 'btn small', onclick: () => location.reload() }, 'Restart now'));
  } else {
    note.append('Saved!');
  }
  state.sfx.click();
}

async function testGoogleKey(key) {
  if (key.startsWith('eyJ')) return { ok: false, msg: 'Google: that looks like a Cesium ion token. Paste it in the Cesium ion box instead.' };
  try {
    const r = await fetch('https://tile.googleapis.com/v1/3dtiles/root.json?key=' + encodeURIComponent(key));
    if (r.ok) return { ok: true, msg: 'Google: key works! ✔' };
    let detail = '';
    try { detail = (await r.json()).error?.message || ''; } catch { /* ignore */ }
    return { ok: false, msg: `Google said no (HTTP ${r.status}). ${detail}`.trim() };
  } catch {
    return { ok: false, msg: 'Google: could not connect. Check your internet, firewall or ad-blocker.' };
  }
}

async function testIonToken(token) {
  if (token.startsWith('AIza')) return { ok: false, msg: 'Cesium: that looks like a Google key. Paste it in the Google box instead.' };
  try {
    const r = await fetch('https://api.cesium.com/v1/assets/96188/endpoint?access_token=' + encodeURIComponent(token));
    if (r.ok) return { ok: true, msg: 'Cesium: token works! ✔' };
    return { ok: false, msg: `Cesium said no (HTTP ${r.status}). Copy the whole token from ion.cesium.com/tokens.` };
  } catch {
    return { ok: false, msg: 'Cesium: could not connect. Check your internet, firewall or ad-blocker.' };
  }
}

async function testKeys() {
  const note = $('#settings-note');
  note.style.color = '';
  note.replaceChildren('Testing…');
  const g = $('#set-google').value.trim();
  const ion = $('#set-ion').value.trim();
  if (!g && !ion) { note.replaceChildren('Paste a key first.'); return; }
  const results = [];
  if (g) results.push(await testGoogleKey(g));
  if (ion) results.push(await testIonToken(ion));
  note.replaceChildren(...results.map((r) => el('div', { style: `color:${r.ok ? 'var(--green)' : 'var(--red)'}` }, r.msg)));
}

// If the two keys got pasted in the wrong boxes, swap them back.
function fixSwappedKeys(cfg) {
  const g = cfg.googleMapsApiKey || '';
  const ion = cfg.cesiumIonToken || '';
  if (g.startsWith('eyJ') && !ion) return { ...cfg, googleMapsApiKey: '', cesiumIonToken: g };
  if (ion.startsWith('AIza') && !g) return { ...cfg, googleMapsApiKey: ion, cesiumIonToken: '' };
  return cfg;
}

// ------------------------------------------------------------ flight session
async function getModel(spec) {
  if (!state.models[spec.id]) state.models[spec.id] = await createDroneModel(spec, state.world.scene);
  return state.models[spec.id];
}

function makeBeacon(lat, lon, groundH, cssColor) {
  const viewer = state.world.viewer;
  const color = Cesium.Color.fromCssColorString(cssColor);
  const b = { lat, lon, groundH, entities: [] };
  const zone = viewer.entities.add({
    position: new Cesium.CallbackPositionProperty(() => Cesium.Cartesian3.fromDegrees(b.lon, b.lat, b.groundH + 40), false),
    cylinder: {
      length: 80, topRadius: CAPTURE_R, bottomRadius: CAPTURE_R,
      material: color.withAlpha(0.2), outline: true, outlineColor: color.withAlpha(0.9), numberOfVerticalLines: 20,
    },
  });
  const beam = viewer.entities.add({
    position: new Cesium.CallbackPositionProperty(() => Cesium.Cartesian3.fromDegrees(b.lon, b.lat, b.groundH + 400), false),
    cylinder: { length: 800, topRadius: 3, bottomRadius: 3, material: color.withAlpha(0.55) },
  });
  b.entities.push(zone, beam);
  state.world.excluded.push(zone, beam);
  return b;
}

function clearBeacons() {
  const run = state.run;
  if (!run) return;
  for (const b of run.beacons || []) {
    for (const e of b.entities) {
      state.world.viewer.entities.remove(e);
      const i = state.world.excluded.indexOf(e);
      if (i >= 0) state.world.excluded.splice(i, 1);
    }
  }
  run.beacons = [];
}

async function startFlight(job) {
  if (state.mode === 'loading') return;
  state.sfx.init();
  setMode('loading');
  $('#loading-text').textContent = 'Loading the world…';
  const drone = currentDrone();
  const { lat, lon } = state.save;
  const spawn = destination(lat, lon, 0, 0);
  state.focus = { lat: spawn.lat, lon: spawn.lon, h: state.focus.h };
  state.world.setDaylight(lon, lat);

  await state.world.ensureOpen(lat, lon);
  await state.world.waitForTiles(job ? 9000 : 7000);
  $('#loading-text').textContent = 'Getting your drone ready…';
  // Sample the spawn spot plus a small ring around it, and start above the highest
  // point, so we never begin inside a building or on top of a tower.
  const pts = [{ lat, lon }, ...[0, 1, 2, 3].map((i) => destination(lat, lon, (i * Math.PI) / 2, 14))];
  if (job) pts.push(job.pickup, job.drop);
  const hs = await state.world.sampleGround(pts);
  const spawnGround = Math.max(...hs.slice(0, 5));
  const model = await getModel(drone);
  for (const m of Object.values(state.models)) m.model.show = m === model;
  state.world.excluded = [model.model, ...state.mp.excludedObjects()];

  const yaw = job ? bearingRad(lat, lon, job.pickup.lat, job.pickup.lon) : state.orbitHeading;
  const f = state.flight;
  f.reset(drone, model, lat, lon, spawnGround, yaw, 15);
  f.collisions = state.save.settings.collisions;
  f.infiniteBattery = !job;
  f.cargoKg = 0;
  model.showCargo(false);

  state.run = {
    job, stage: job ? 'pickup' : 'free',
    timeLeft: job ? job.timeLimit : 0,
    beacons: [], legStart: { lat, lon }, legLen: 1,
    sampleTimer: 0, startOdo: 0, late: false,
  };
  if (job) {
    const type = JOB_TYPES.find((t) => t.id === job.type);
    state.run.type = type;
    state.run.pickupB = makeBeacon(job.pickup.lat, job.pickup.lon, hs[5], '#ffb347');
    state.run.dropB = makeBeacon(job.drop.lat, job.drop.lon, hs[6], '#3ddc97');
    state.run.dropB.entities.forEach((e) => (e.show = false));
    state.run.beacons = [state.run.pickupB, state.run.dropB];
    state.run.legLen = Math.max(50, distanceM(lat, lon, job.pickup.lat, job.pickup.lon));
  }
  setupHudForRun();
  syncMp(true);
  setMode('flying', '');
  $('#hud').classList.remove('hidden');
  $('#hud-help').style.opacity = 1;
  setTimeout(() => { if ($('#hud-help')) $('#hud-help').style.opacity = 0.25; }, 12000);
  state.input.clearPresses();
  toast(job ? `Job started! Fly to ${job.pickup.name}.` : 'Free fly: go anywhere!', 'good');
}

function setupHudForRun() {
  const run = state.run;
  const job = run.job;
  $('#hud-job').classList.remove('hidden');
  if (!job) {
    $('#hud-job-title').textContent = 'Free Fly';
    $('#hud-job-goal').textContent = 'No battery limit. Explore!';
    $('#route-a-label').textContent = '';
    $('#route-b-label').textContent = '';
    $('#route-fill').style.width = '0';
    $('#route-drone').style.left = '0';
    $('#hud-timer').classList.add('hidden');
    $('#marker').classList.add('hidden');
    return;
  }
  $('#hud-timer').classList.remove('hidden');
  updateJobHud(true);
}

function updateJobHud() {
  const run = state.run;
  const job = run.job;
  if (!job) return;
  const type = run.type;
  const pickingUp = run.stage === 'pickup';
  $('#hud-job-title').textContent = `${type.icon} ${type.name} · ${job.cargo} kg`;
  $('#hud-job-goal').textContent = pickingUp ? `Fly into the glowing beam at ${job.pickup.name}` : `Deliver to ${job.drop.name}`;
  $('#route-a-label').textContent = pickingUp ? 'Start' : job.pickup.name;
  $('#route-b-label').textContent = pickingUp ? job.pickup.name : job.drop.name;
  $('#route-b').textContent = pickingUp ? type.icon : '🏠';
  $('#route-a').classList.toggle('done', !pickingUp);
  $('#marker-icon').textContent = pickingUp ? type.icon : '🏠';
  syncMp(true);
}

function currentTarget() {
  const run = state.run;
  if (!run || !run.job) return null;
  return run.stage === 'pickup' ? { ...run.job.pickup, b: run.pickupB } : { ...run.job.drop, b: run.dropB };
}

function endFlightCleanup() {
  const f = state.flight;
  syncMp(false);
  state.sfx.rotor(false, 0);
  clearBeacons();
  if (f.active) {
    state.save.lat = f.latDeg;
    state.save.lon = f.lonDeg;
    state.save.stats.km += f.odometer / 1000;
    state.save.placeName = state.save.placeName;
  }
  f.active = false;
  for (const m of Object.values(state.models)) m.model.show = false;
  state.run = null;
  setFocus(state.save.lat, state.save.lon);
  state.world.viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
}

function backToHub() {
  endFlightCleanup();
  genJobs();
  persist();
  setMode('hub');
  showTab('jobs');
}

function completeJob() {
  const run = state.run;
  const f = state.flight;
  const job = run.job;
  const onTime = run.timeLeft >= 0;
  const timeBonus = onTime ? Math.round(job.pay * 0.5 * (run.timeLeft / job.timeLimit)) : 0;
  const late = onTime ? 0 : Math.round(job.pay * 0.3);
  const smooth = f.bumps === 0 ? Math.round(job.pay * 0.15) : 0;
  const damage = Math.round(job.pay * 0.05 * Math.min(f.bumps, 6));
  const total = Math.max(5, job.pay + timeBonus - late + smooth - damage);
  state.save.money += total;
  state.save.stats.jobs += 1;
  state.save.stats.earned += total;
  state.sfx.deliver();
  state.input.rumble(0.5, 1, 400);
  persist();

  const rows = [['Delivery pay', formatMoney(job.pay)]];
  if (timeBonus) rows.push(['⚡ Speed bonus', '+' + formatMoney(timeBonus)]);
  if (late) rows.push(['🐢 Late', '−' + formatMoney(late)]);
  if (smooth) rows.push(['✨ Smooth flying', '+' + formatMoney(smooth)]);
  if (damage) rows.push([`💥 Bumps (${f.bumps})`, '−' + formatMoney(damage)]);
  showResult({
    title: 'Delivered! 🎉',
    sub: `${job.cargo} kg of ${run.type.name.toLowerCase()} delivered to ${job.drop.name}.`,
    rows, total: formatMoney(total),
  });
}

function failJob(reason) {
  state.sfx.fail();
  showResult({ title: 'Job failed', sub: reason, rows: [], total: null });
}

function showResult({ title, sub, rows, total }) {
  state.sfx.rotor(false, 0);
  const panel = $('#result-panel');
  panel.className = 'panel result';
  panel.replaceChildren(
    el('h2', {}, title),
    el('div', { class: 'sub' }, sub),
    el('table', {}, ...rows.map(([a, b]) => el('tr', {}, el('td', {}, a), el('td', {}, b))),
      total ? el('tr', { class: 'total' }, el('td', {}, 'Total'), el('td', {}, total)) : null),
    el('div', { class: 'btn-row' },
      el('button', { class: 'btn primary', onclick: () => { state.sfx.click(); backToHub(); } }, 'Continue'))
  );
  state.mode = 'result';
  state.input.capture = false;
  showScreen('result');
  $('#hud').classList.add('hidden');
}

function pauseGame() {
  if (state.mode !== 'flying') return;
  state.sfx.rotor(false, 0);
  state.mode = 'paused';
  state.input.capture = false;
  showScreen('pause');
  $('#hud').classList.remove('hidden');
}

function resumeGame() {
  if (state.mode !== 'paused') return;
  state.mode = 'flying';
  state.input.capture = true;
  showScreen('');
  $('#hud').classList.remove('hidden');
  state.input.clearPresses();
}

// ------------------------------------------------------------ multiplayer + chat
function syncMp(flying) {
  const run = state.run;
  const job = flying && run && run.job ? { type: run.job.type, stage: run.stage, pickup: run.job.pickup, drop: run.job.drop } : null;
  state.mp.setMyState({ fly: flying, drone: state.save.drone, job });
}

function mpSettings() {
  const s = state.save.settings;
  const name = (s.playerName || '').trim() || 'Pilot' + Math.floor(1000 + Math.random() * 9000);
  if (!s.playerName) { s.playerName = name; persist(); }
  return { url: s.mpUrl || '', name };
}

function updateChatVisibility() {
  const online = state.mp && state.mp.status === 'online';
  const show = online && ['hub', 'flying', 'paused'].includes(state.mode);
  $('#chat').classList.toggle('hidden', !show);
}

function addChat(msg, quiet) {
  state.chat.push(msg);
  if (state.chat.length > 60) state.chat.shift();
  const log = $('#chat-log');
  const line = el('div', { class: 'chat-line' + (msg.system ? ' sys' : '') });
  if (msg.system) line.append(msg.text);
  else line.append(el('b', {}, msg.name + ': '), msg.text);
  log.append(line);
  while (log.children.length > 60) log.firstChild.remove();
  log.scrollTop = log.scrollHeight;
  if (!quiet) {
    line.classList.add('fresh');
    setTimeout(() => line.classList.remove('fresh'), 9000);
  }
}

function openChat() {
  if (!state.mp || state.mp.status !== 'online') return;
  $('#chat').classList.add('typing');
  const input = $('#chat-input');
  input.value = '';
  input.focus();
}

function closeChat() {
  $('#chat').classList.remove('typing');
  $('#chat-input').blur();
}

function bindChat() {
  const input = $('#chat-input');
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      const text = input.value.trim();
      if (text) state.mp.sendChat(text);
      input.value = '';
      if (state.mode === 'flying') closeChat();
    } else if (e.key === 'Escape') {
      closeChat();
    }
  });
  input.addEventListener('focus', () => { if (state.mode === 'flying') state.input.keys.clear(); });
}

function renderOnlineTab() {
  const root = $('#tab-online');
  root.replaceChildren();
  const mp = state.mp;
  if (!mp || mp.status === 'off') {
    root.append(el('div', { class: 'muted note' }, 'Multiplayer is off. Open Settings, type the multiplayer server address and your pilot name, then press Save.'));
    return;
  }
  if (mp.status !== 'online') {
    root.append(el('div', { class: 'muted note' }, mp.status === 'connecting' ? 'Connecting…' : '⚠ Could not reach the multiplayer server. Retrying…'));
    return;
  }
  root.append(el('div', { class: 'muted note' }, `🌐 ${mp.online} pilot${mp.online === 1 ? '' : 's'} online (including you). Press Enter while flying to chat.`));
  const list = mp.roster();
  if (!list.length) root.append(el('div', { class: 'muted note' }, 'Nobody else is here yet.'));
  for (const p of list) {
    const j = p.job;
    const type = j && JOB_TYPES.find((t) => t.id === j.ty);
    const doing = !p.fly ? 'In the hub' : j ? `${type ? type.icon : '📦'} ${j.st === 'pickup' ? 'Heading to ' + (j.pk[2] || 'a pickup') : 'Delivering to ' + (j.dr[3] || j.dr[2] || 'an address')}` : '🕊 Free flying';
    const drone = DRONES.find((d) => d.id === p.drone);
    root.append(el('div', { class: 'card' },
      el('div', { class: 'icon' }, '🚁'),
      el('div', { class: 'info' }, el('div', { class: 'name' }, p.name), el('div', { class: 'sub' }, doing), el('div', { class: 'meta' }, el('span', {}, drone ? drone.name : ''))),
      p.fly && p.cur ? el('div', { class: 'right' }, el('button', { class: 'btn small', onclick: () => { goTo(p.cur.lat, p.cur.lon, p.name + "'s area"); } }, 'Go there')) : null));
  }
}

// ------------------------------------------------------------ per-frame
const DIRS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

function stepFlying(dt) {
  const input = state.input;
  const f = state.flight;
  if (input.consume('KeyV') || input.consumePad(3)) {
    f.camMode = f.camMode === 'chase' ? 'fpv' : 'chase';
    f.camSnap = true;
    if (state.models[f.spec.id]) state.models[f.spec.id].model.show = f.camMode === 'chase';
  }
  if (input.consume('Escape') || input.consumePad(9)) { pauseGame(); return; }

  f.update(dt, input.axes());
  f.render(dt);
  state.mp.sendPosition(f, dt);
  if (input.consume('Enter')) openChat();
  state.world.updateOpen(f.latDeg, f.lonDeg);
  state.sfx.rotor(f.rotorOn, f.load || 0);

  if (f.bumpedFlag) {
    f.bumpedFlag = false;
    state.sfx.bump();
    state.input.rumble(1, 0.6, 220);
    const fl = $('#flash');
    fl.classList.add('on');
    setTimeout(() => fl.classList.remove('on'), 120);
    toast('💥 Bump! Careful!', 'bad');
  }

  updateRun(dt);
  updateHud();
}

function updateRun(dt) {
  const run = state.run;
  const f = state.flight;
  if (!run) return;
  const job = run.job;

  if (job) {
    run.timeLeft -= dt;
    if (run.timeLeft < 0 && !run.late) { run.late = true; toast('⏱ Time is up! Pay goes down, hurry!', 'bad'); }
  }

  // Out of battery: land and fail
  if (f.dead && f.onGround && state.mode === 'flying') {
    failJob('The battery ran out. A rescue crew picked up your drone. No money lost.');
    return;
  }

  const t = currentTarget();
  if (!t) return;

  // refine ground height under the target when we get close
  run.sampleTimer -= dt;
  if (run.sampleTimer <= 0) {
    run.sampleTimer = 2;
    const d = distanceM(f.latDeg, f.lonDeg, t.lat, t.lon);
    if (d < 500 && !run.sampling) {
      run.sampling = true;
      state.world.sampleGround([{ lat: t.lat, lon: t.lon }]).then(([h]) => {
        run.sampling = false;
        if (Number.isFinite(h) && t.b) t.b.groundH = h;
      });
    }
  }

  const dist2d = distanceM(f.latDeg, f.lonDeg, t.lat, t.lon);
  const inside = dist2d < CAPTURE_R && f.h > t.b.groundH - 4 && f.h < t.b.groundH + 85;
  if (!inside) return;

  if (run.stage === 'pickup') {
    state.sfx.pickup();
    state.input.rumble(0.3, 0.8, 160);
    f.cargoKg = job.cargo;
    f.addBattery(0.2);
    state.models[f.spec.id].showCargo(true);
    toast(`${run.type.icon} Picked up at ${job.pickup.name}! Battery +20%`, 'good');
    run.stage = 'deliver';
    run.pickupB.entities.forEach((e) => (e.show = false));
    run.dropB.entities.forEach((e) => (e.show = true));
    run.legStart = { lat: job.pickup.lat, lon: job.pickup.lon };
    run.legLen = Math.max(50, job.dDel);
    updateJobHud();
  } else if (run.stage === 'deliver') {
    state.models[f.spec.id].showCargo(false);
    f.cargoKg = 0;
    completeJob();
  }
}

function updateHud() {
  const f = state.flight;
  const run = state.run;
  const s = state.save.settings;
  $('#hud-money').textContent = formatMoney(state.save.money);
  const speed = s.units === 'kmh' ? f.speed3 * 3.6 : f.speed3;
  $('#g-speed').textContent = Math.round(speed);
  $('#g-speed-unit').textContent = s.units === 'kmh' ? 'km/h' : 'm/s';
  $('#g-alt').textContent = Math.round(f.agl);
  const deg = f.headingDeg;
  $('#g-head').textContent = DIRS[Math.round(deg / 45) % 8];
  $('#g-head-deg').textContent = Math.round(deg) + '°';
  const pct = Math.round(f.battery * 100);
  const bf = $('#g-batt');
  bf.style.width = pct + '%';
  bf.style.background = pct > 40 ? 'var(--green)' : pct > 20 ? 'var(--yellow)' : 'var(--red)';
  $('#g-batt-text').textContent = f.infiniteBattery ? '∞' : pct + '%';

  if (!run || !run.job) return;
  const tm = $('#hud-timer');
  tm.textContent = run.timeLeft >= 0 ? '⏱ ' + formatTime(run.timeLeft) : '⏱ LATE';
  tm.style.color = run.timeLeft < 0 ? 'var(--red)' : run.timeLeft < 20 ? 'var(--yellow)' : '';

  const t = currentTarget();
  if (!t) return;
  const dist = distanceM(f.latDeg, f.lonDeg, t.lat, t.lon);
  const prog = clamp(1 - dist / run.legLen, 0, 1);
  $('#route-fill').style.width = prog * 100 + '%';
  $('#route-drone').style.left = prog * 100 + '%';
  updateMarker(t, dist);
}

function updateMarker(t, dist2d) {
  const scene = state.world.scene;
  const cam = state.world.viewer.camera;
  const marker = $('#marker');
  const worldPos = Cesium.Cartesian3.fromDegrees(t.lon, t.lat, t.b.groundH + 30);
  const d = Cesium.Cartesian3.subtract(worldPos, cam.positionWC, new Cesium.Cartesian3());
  const fx = Cesium.Cartesian3.dot(d, cam.directionWC);
  const rx = Cesium.Cartesian3.dot(d, cam.rightWC);
  const ux = Cesium.Cartesian3.dot(d, cam.upWC);
  const w = window.innerWidth, h = window.innerHeight, m = 70;
  let x, y;
  const win = fx > 0 ? Cesium.SceneTransforms.worldToWindowCoordinates(scene, worldPos) : undefined;
  if (win && win.x > m && win.x < w - m && win.y > m + 110 && win.y < h - m) {
    x = win.x; y = win.y;
  } else {
    let vx = rx, vy = -ux;
    const len = Math.hypot(vx, vy) || 1;
    vx /= len; vy /= len;
    const tx = Math.abs(vx) > 1e-4 ? (w / 2 - m) / Math.abs(vx) : Infinity;
    const ty = Math.abs(vy) > 1e-4 ? (h / 2 - m - 60) / Math.abs(vy) : Infinity;
    const tt = Math.min(tx, ty);
    x = w / 2 + vx * tt;
    y = h / 2 + 30 + vy * tt;
  }
  marker.classList.remove('hidden');
  marker.style.left = x + 'px';
  marker.style.top = y + 'px';
  $('#marker-dist').textContent = formatDist(dist2d);
}

// What the controller can do on the current menu screen.
function cycleTab(d) {
  const tabs = ['jobs', 'drones', 'world', 'online'];
  const i = (tabs.indexOf(state.tab) + d + tabs.length) % tabs.length;
  state.sfx.click();
  showTab(tabs[i]);
}

function navContext() {
  switch (state.mode) {
    case 'menu': return { root: $('#screen-menu') };
    case 'hub': return { root: $('#screen-hub'), onBack: () => $('[data-action=menu]').click(), onTab: cycleTab };
    case 'settings': return { root: $('#screen-settings'), onBack: () => $('[data-action=close-settings]').click() };
    case 'paused': return { root: $('#screen-pause'), onBack: resumeGame };
    case 'result': return { root: $('#screen-result'), onBack: () => { const b = $('#result-panel .btn.primary'); if (b) b.click(); } };
    default: return null;
  }
}

function onPreRender() {
  const now = performance.now();
  const dt = Math.min(0.1, (now - state.last) / 1000);
  state.last = now;
  state.input.pollPad();
  const hasPad = !!state.input.pad;
  if (hasPad !== state.hasPad) {
    state.hasPad = hasPad;
    document.body.classList.toggle('has-pad', hasPad);
  }
  try {
    if (state.mode === 'flying') stepFlying(dt);
    else if (state.mode === 'paused') {
      if (state.input.consume('Escape') || state.input.consumePad(9)) resumeGame();
      else state.padNav.update(dt, navContext());
    } else {
      if (['menu', 'hub', 'settings', 'loading'].includes(state.mode)) orbit(dt);
      const nav = navContext();
      if (nav) state.padNav.update(dt, nav);
    }
  } catch (e) {
    console.error('Frame error', e);
  }
  if (state.mp) {
    const here = state.mode === 'flying' && state.flight.active ? { lat: state.flight.latDeg, lon: state.flight.lonDeg } : state.focus;
    try { state.mp.update(dt, here.lat, here.lon, now / 40); } catch (e) { console.error('mp', e); }
  }
  if (state.input.consume('F11') && window.droneApp) window.droneApp.toggleFullscreen();
  if (state.mode !== 'flying') state.input.pressed.delete('Escape');
}

// ------------------------------------------------------------ boot
function quit() {
  if (window.droneApp) window.droneApp.quit();
  else fetch('/api/quit', { method: 'POST' }).finally(() => window.close());
}

function bindUi() {
  window.addEventListener('gamepadconnected', () => toast('🎮 Controller connected', 'good'));
  window.addEventListener('gamepaddisconnected', () => {
    toast('🎮 Controller disconnected', 'bad');
    if (state.mode === 'flying') pauseGame();
  });
  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-action]');
    if (t) {
      state.sfx.init();
      const a = t.dataset.action;
      if (a === 'play') { state.sfx.click(); setMode('hub'); showTab(state.tab); }
      else if (a === 'settings') openSettings('menu');
      else if (a === 'quit') quit();
      else if (a === 'menu') { state.sfx.click(); setMode('menu'); }
      else if (a === 'freefly') { state.sfx.click(); startFlight(null); }
      else if (a === 'save-settings') saveSettings();
      else if (a === 'test-keys') testKeys();
      else if (a === 'close-settings') { state.sfx.click(); setMode(state.settingsFrom === 'hub' ? 'hub' : 'menu'); }
      else if (a === 'reset-save') {
        if (confirm('Erase all progress and start again?')) {
          state.save = mergeSave(null);
          persist();
          setFocus(state.save.lat, state.save.lon);
          genJobs();
          $('#settings-note').textContent = 'Progress reset.';
        }
      }
      else if (a === 'resume') { state.sfx.click(); resumeGame(); }
      else if (a === 'abort') { state.sfx.click(); backToHub(); }
      return;
    }
    const tab = e.target.closest('.tab');
    if (tab) { state.sfx.click(); showTab(tab.dataset.tab); }
  });
}

async function boot() {
  bindUi();
  const [cfg, save] = await Promise.all([
    fetch('/api/config').then((r) => r.json()).catch(() => ({})),
    fetch('/api/save').then((r) => r.json()).catch(() => null),
  ]);
  state.cfg = fixSwappedKeys(cfg);
  state.save = mergeSave(save);
  state.sfx.setVolume(state.save.settings.volume);
  state.input.rumbleOn = state.save.settings.rumble !== false;
  state.padNav = new PadNav(state.input);
  try {
    state.world = new World();
    // "Free 3D world only" (or ?free in the address) ignores any saved keys for this run.
    const freeOnly = state.save.settings.mapSource === 'free' || new URLSearchParams(location.search).has('free');
    await state.world.init('cesiumContainer', freeOnly ? {} : state.cfg, state.save.settings.quality);
  } catch (e) {
    console.error(e);
    $('#world-status').textContent = '⚠ Could not start the 3D world: ' + (e.message || e);
    return;
  }
  state.flight = new Flight(state.world);
  state.mp = new Multiplayer({
    world: state.world,
    specOf: (id) => DRONES.find((d) => d.id === id) || DRONES[0],
    onChat: addChat,
    onStatus: (text, ok) => {
      $('#mp-status').textContent = text;
      $('#mp-status').classList.toggle('good', ok);
      updateChatVisibility();
      if (state.mode === 'hub' && state.tab === 'online') renderOnlineTab();
    },
    onRoster: () => { if (state.mode === 'hub' && state.tab === 'online') renderOnlineTab(); },
  });
  bindChat();
  { const m = mpSettings(); state.mp.myDrone = state.save.drone; state.mp.start(m.url, m.name); }
  state.focus = { lat: state.save.lat, lon: state.save.lon, h: 40 };
  setFocus(state.save.lat, state.save.lon);
  genJobs();
  updateWorldStatus();
  setMode('menu');
  state.world.scene.preRender.addEventListener(onPreRender);
  window.__drone = state; // handy for debugging
}

boot();
