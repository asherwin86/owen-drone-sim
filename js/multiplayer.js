// Multiplayer client: connects to the relay, shows other pilots' drones, chat.
import { createDroneModel } from './droneModel.js';

const Cesium = window.Cesium;
const PROTOCOL = 1;
const SEND_MS = 200;       // our position, 5 per second
const SHOW_RADIUS = 12000; // only draw drones within this many metres
const MAX_MODELS = 12;     // nearest drones get a 3D model; others a marker dot

export class Multiplayer {
  /**
   * opts: { world, specOf(id), onChat(msg), onStatus(text, ok), onRoster() }
   */
  constructor(opts) {
    this.o = opts;
    this.url = '';
    this.name = '';
    this.ws = null;
    this.status = 'off';  // off | connecting | online | error
    this.online = 0;
    this.myId = 0;
    this.players = new Map(); // id -> { id, name, drone, fly, job, cur, tgt, model, label, dot }
    this.retry = 0;
    this.retryTimer = null;
    this.wantOn = false;
    this.sendTimer = 0;
    this.lastInfo = '';
    this.myFly = 0;
    this.myDrone = 'sparrow';
    this.myJob = null;
  }

  // ---- connection
  start(url, name) {
    this.url = String(url || '').trim();
    this.name = String(name || '').trim();
    this.stop(true);
    if (!this.url) { this.setStatus('off', 'Multiplayer off'); return; }
    this.wantOn = true;
    this.retry = 0;
    this.connect();
  }

  stop(keepWant) {
    if (!keepWant) this.wantOn = false;
    clearTimeout(this.retryTimer);
    if (this.ws) { try { this.ws.onclose = null; this.ws.close(); } catch { /* ignore */ } this.ws = null; }
    for (const id of [...this.players.keys()]) this.removePlayer(id);
    this.online = 0;
    if (!this.wantOn) this.setStatus('off', 'Multiplayer off');
  }

  setStatus(s, text) {
    this.status = s;
    this.o.onStatus(text, s === 'online');
  }

  connect() {
    let url = this.url;
    if (!/^wss?:\/\//i.test(url)) url = 'ws://' + url;
    this.setStatus('connecting', 'Connecting to multiplayer…');
    let ws;
    try { ws = new WebSocket(url); } catch { this.setStatus('error', 'Bad server address'); return; }
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      ws.send(JSON.stringify({ t: 'hello', v: PROTOCOL, name: this.name, drone: this.myDrone }));
    };
    ws.onmessage = (ev) => { let m; try { m = JSON.parse(ev.data); } catch { return; } this.handle(m); };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      for (const id of [...this.players.keys()]) this.removePlayer(id);
      this.online = 0;
      if (!this.wantOn) return;
      this.setStatus('error', 'Multiplayer offline, retrying…');
      const wait = Math.min(30000, 1500 * 2 ** Math.min(this.retry++, 5));
      this.retryTimer = setTimeout(() => this.connect(), wait);
    };
    ws.onerror = () => {};
  }

  send(obj) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(obj));
  }

  handle(m) {
    switch (m.t) {
      case 'welcome':
        this.myId = m.id;
        this.online = m.online;
        this.setStatus('online', `🌐 ${this.online} online`);
        for (const p of m.players || []) this.upsert(p);
        for (const c of m.history || []) this.o.onChat(c, true);
        this.lastInfo = '';
        this.pushInfo();
        break;
      case 'join':
        this.online = m.online;
        this.upsert(m);
        this.setStatus('online', `🌐 ${this.online} online`);
        this.o.onChat({ system: true, text: `${m.name} joined` });
        break;
      case 'leave': {
        const p = this.players.get(m.id);
        this.online = m.online;
        if (p) this.o.onChat({ system: true, text: `${p.name} left` });
        this.removePlayer(m.id);
        this.setStatus('online', `🌐 ${this.online} online`);
        break;
      }
      case 'i': this.upsert(m); break;
      case 'p':
        for (const a of m.a || []) {
          const p = this.players.get(a[0]);
          if (!p) continue;
          const t = { lat: a[1], lon: a[2], h: a[3], yaw: a[4], pitch: a[5], roll: a[6] };
          if (!p.cur) p.cur = { ...t };
          p.tgt = t;
        }
        break;
      case 'chat': this.o.onChat(m); break;
      case 'full': this.setStatus('error', 'Multiplayer server is full'); this.wantOn = false; break;
      case 'bad-version': this.setStatus('error', 'Update the game to play online'); this.wantOn = false; break;
      default: break;
    }
    this.o.onRoster();
  }

  upsert(m) {
    if (m.id === this.myId) return;
    let p = this.players.get(m.id);
    if (!p) { p = { id: m.id, cur: null, tgt: null, model: null, modelFor: '', loading: false, label: null }; this.players.set(m.id, p); }
    p.name = m.name; p.drone = m.drone; p.fly = m.fly; p.job = m.job;
    if (!p.fly) { p.cur = null; p.tgt = null; this.hide(p); }
  }

  removePlayer(id) {
    const p = this.players.get(id);
    if (!p) return;
    this.hide(p, true);
    this.players.delete(id);
  }

  // ---- what we tell others
  setMyState({ fly, drone, job }) {
    this.myFly = fly ? 1 : 0;
    this.myDrone = drone || this.myDrone;
    this.myJob = job || null;
    this.pushInfo();
  }

  pushInfo() {
    const j = this.myJob;
    const body = {
      t: 'i', fly: this.myFly, drone: this.myDrone,
      job: this.myFly && j ? {
        ty: j.type, st: j.stage,
        pk: [j.pickup.lat, j.pickup.lon, j.pickup.name, j.pickup.addr || ''],
        dr: [j.drop.lat, j.drop.lon, j.drop.name, j.drop.addr || ''],
      } : null,
    };
    const key = JSON.stringify(body);
    if (key === this.lastInfo) return;
    this.lastInfo = key;
    this.send(body);
  }

  sendChat(text) { this.send({ t: 'chat', text }); }

  /** Call every frame while flying with the local flight object. */
  sendPosition(f, dt) {
    this.sendTimer -= dt * 1000;
    if (this.sendTimer > 0) return;
    this.sendTimer = SEND_MS;
    this.send({ t: 'p', a: f.latDeg, o: f.lonDeg, h: f.h, y: f.yaw, pi: f.pitchVis, r: f.rollVis });
  }

  // ---- drawing other drones
  hide(p, destroy) {
    if (p.model && p.model.model) {
      p.model.model.show = false;
      if (destroy) {
        this.removeExcluded(p.model.model);
        p.model.destroy();
        p.model = null;
      }
    }
    if (p.label) {
      this.o.world.viewer.entities.remove(p.label);
      this.removeExcluded(p.label);
      p.label = null;
    }
  }

  removeExcluded(obj) {
    const ex = this.o.world.excluded;
    const i = ex.indexOf(obj);
    if (i >= 0) ex.splice(i, 1);
  }

  /** Objects the local drone's collision probes must ignore. */
  excludedObjects() {
    const out = [];
    for (const p of this.players.values()) { if (p.model) out.push(p.model.model); if (p.label) out.push(p.label); }
    return out;
  }

  async ensureModel(p) {
    if (p.loading || (p.model && p.modelFor === p.drone)) return;
    const spec = this.o.specOf(p.drone);
    p.loading = true;
    try {
      const m = await createDroneModel(spec, this.o.world.scene);
      if (!this.players.has(p.id)) { m.destroy(); return; }
      if (p.model) { this.removeExcluded(p.model.model); p.model.destroy(); }
      p.model = m;
      p.modelFor = p.drone;
      this.o.world.excluded.push(m.model);
    } catch (e) {
      console.warn('Could not load remote drone', e);
    } finally {
      p.loading = false;
    }
  }

  ensureLabel(p) {
    if (p.label) return;
    const viewer = this.o.world.viewer;
    p.label = viewer.entities.add({
      position: new Cesium.CallbackPositionProperty(() => {
        const c = p.cur;
        return c ? Cesium.Cartesian3.fromDegrees(c.lon, c.lat, c.h + 6) : undefined;
      }, false),
      label: {
        text: new Cesium.CallbackProperty(() => this.labelText(p), false),
        font: '700 15px system-ui, sans-serif',
        fillColor: Cesium.Color.WHITE, outlineColor: Cesium.Color.BLACK, outlineWidth: 4,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        pixelOffset: new Cesium.Cartesian2(0, -8),
        distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 6000),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        showBackground: true, backgroundColor: Cesium.Color.fromCssColorString('rgba(8,12,24,0.6)'),
      },
    });
    this.o.world.excluded.push(p.label);
  }

  labelText(p) {
    const j = p.job;
    let t = p.name;
    if (j) t += `\n→ ${j.st === 'pickup' ? 'to pickup: ' + (j.pk[2] || 'store') : 'delivering to ' + (j.dr[3] || j.dr[2] || 'address')}`;
    return t;
  }

  /** Call every frame (any mode where the 3D world shows): smooths and draws remote drones. */
  update(dt, myLat, myLon, spin) {
    if (this.status !== 'online') return;
    const flying = [];
    for (const p of this.players.values()) {
      if (!p.fly || !p.tgt) continue;
      const k = 1 - Math.exp(-dt * 8);
      if (!p.cur) p.cur = { ...p.tgt };
      const c = p.cur, t = p.tgt;
      c.lat += (t.lat - c.lat) * k; c.lon += (t.lon - c.lon) * k; c.h += (t.h - c.h) * k;
      c.pitch += (t.pitch - c.pitch) * k; c.roll += (t.roll - c.roll) * k;
      let dy = t.yaw - c.yaw; dy = Math.atan2(Math.sin(dy), Math.cos(dy)); c.yaw += dy * k;
      const dLat = (c.lat - myLat) * 111320, dLon = (c.lon - myLon) * 111320 * Math.cos(myLat * Math.PI / 180);
      p.dist = Math.hypot(dLat, dLon);
      flying.push(p);
    }
    flying.sort((a, b) => a.dist - b.dist);
    flying.forEach((p, i) => {
      const show = p.dist < SHOW_RADIUS;
      if (!show) { this.hide(p); return; }
      this.ensureLabel(p);
      if (i < MAX_MODELS) {
        this.ensureModel(p);
        const m = p.model;
        if (m && m.model) {
          m.model.show = true;
          const c = p.cur;
          const enu = Cesium.Transforms.eastNorthUpToFixedFrame(Cesium.Cartesian3.fromDegrees(c.lon, c.lat, c.h), Cesium.Ellipsoid.WGS84, new Cesium.Matrix4());
          const rz = Cesium.Matrix3.fromRotationZ(Math.PI / 2 - c.yaw, new Cesium.Matrix3());
          const ry = Cesium.Matrix3.fromRotationY(c.pitch, new Cesium.Matrix3());
          const rx = Cesium.Matrix3.fromRotationX(c.roll, new Cesium.Matrix3());
          const rot = Cesium.Matrix3.multiply(Cesium.Matrix3.multiply(rz, ry, new Cesium.Matrix3()), rx, new Cesium.Matrix3());
          const local = Cesium.Matrix4.fromRotationTranslation(rot, Cesium.Cartesian3.ZERO, new Cesium.Matrix4());
          m.model.modelMatrix = Cesium.Matrix4.multiply(enu, local, new Cesium.Matrix4());
          m.spin(spin);
        }
      } else if (p.model) {
        p.model.model.show = false;
      }
    });
    // Drones whose owner is not flying (or has no position yet) must not stay on screen.
    for (const p of this.players.values()) if ((!p.fly || !p.tgt) && (p.model || p.label)) this.hide(p);
  }

  roster() {
    return [...this.players.values()].filter((p) => p.name);
  }
}
