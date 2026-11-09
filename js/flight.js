// Flight: input, arcade drone physics, cameras.
import { wrapPi, clamp } from './geo.js';
const Cesium = window.Cesium;
const R_EARTH = 6378137;

// ---------------------------------------------------------------- input
export class Input {
  constructor() {
    this.keys = new Set();
    this.pressed = new Set();
    this.capture = false;
    this.prevPad = [];
    this.padPressed = new Set();
    this.pad = null;
    this.rumbleOn = true;
    const block = new Set(['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab']);
    window.addEventListener('keydown', (e) => {
      if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
      if (this.capture && block.has(e.code)) e.preventDefault();
      if (!e.repeat) this.pressed.add(e.code);
      this.keys.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
  }

  down(...codes) { return codes.some((c) => this.keys.has(c)); }

  /** True once per key press. */
  consume(code) {
    if (this.pressed.has(code)) { this.pressed.delete(code); return true; }
    return false;
  }

  clearPresses() { this.pressed.clear(); this.padPressed.clear(); }

  pollPad() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const pad = Array.from(pads).find((p) => p && p.connected);
    this.pad = pad || null;
    if (pad) {
      pad.buttons.forEach((b, i) => {
        if (b.pressed && !this.prevPad[i]) this.padPressed.add(i);
        this.prevPad[i] = b.pressed;
      });
    }
  }

  consumePad(i) {
    if (this.padPressed.has(i)) { this.padPressed.delete(i); return true; }
    return false;
  }

  /** Vibrate the controller (if it supports it and vibration is on). */
  rumble(strong = 0.6, weak = 0.3, ms = 150) {
    if (!this.rumbleOn || !this.pad) return;
    const act = this.pad.vibrationActuator;
    if (act && act.playEffect) {
      try {
        const p = act.playEffect('dual-rumble', { startDelay: 0, duration: ms, weakMagnitude: weak, strongMagnitude: strong });
        if (p && p.catch) p.catch(() => {});
      } catch { /* rumble is optional */ }
    }
  }

  /** Returns { fwd, right, up, yaw } each in -1..1 */
  axes() {
    const k = (a, b) => (this.down(a) ? 1 : 0) - (this.down(b) ? 1 : 0);
    let fwd = k('KeyW', 'KeyS');
    let right = k('KeyD', 'KeyA');
    let up = k('Space', 'ShiftLeft') + k('ArrowUp', 'ArrowDown') + k('KeyR', 'KeyF');
    let yaw = k('KeyE', 'KeyQ') + k('ArrowRight', 'ArrowLeft');
    if (this.down('ShiftRight', 'ControlLeft', 'KeyC')) up -= 1;
    // Controller: dead zone + gentle curve so small stick movements are precise.
    const DZ = 0.14;
    const curve = (v) => {
      const a = Math.abs(v);
      if (a < DZ) return 0;
      return Math.sign(v) * Math.pow((a - DZ) / (1 - DZ), 1.4);
    };
    if (this.pad) {
      const a = this.pad.axes;
      const btn = (i) => (this.pad.buttons[i] ? this.pad.buttons[i].value || (this.pad.buttons[i].pressed ? 1 : 0) : 0);
      yaw += curve(a[0] || 0);          // left stick X: turn
      up += -curve(a[1] || 0);          // left stick Y: up / down
      right += curve(a[2] || 0);        // right stick X: slide left / right
      fwd += -curve(a[3] || 0);         // right stick Y: forward / back
      up += btn(7) - btn(6);            // RT up, LT down
      yaw += btn(5) - btn(4);           // RB / LB turn
    }
    const len = Math.hypot(fwd, right);
    if (len > 1) { fwd /= len; right /= len; }
    return { fwd: clamp(fwd, -1, 1), right: clamp(right, -1, 1), up: clamp(up, -1, 1), yaw: clamp(yaw, -1, 1) };
  }
}

// -------------------------------------------------------------- flight
export class Flight {
  constructor(world) {
    this.world = world;
    this.active = false;
    this.camMode = 'chase';
    this.spec = null;
    this.droneModel = null;
    this._enu = new Cesium.Matrix4();
    this._rot3 = new Cesium.Matrix3();
    this._tmpA = new Cesium.Matrix3();
    this._tmpB = new Cesium.Matrix3();
    this._m4 = new Cesium.Matrix4();
    this.probeScale = 1;
  }

  /** Place the drone on the ground and get ready. */
  reset(spec, droneModel, lat, lon, groundH, yawRad, startAgl = 0.36) {
    this.spec = spec;
    this.droneModel = droneModel;
    this.lat = Cesium.Math.toRadians(lat);
    this.lon = Cesium.Math.toRadians(lon);
    this.groundH = groundH;
    this.h = groundH + Math.max(0.36, startAgl);
    this.vE = 0; this.vN = 0; this.vU = 0;
    this.yaw = yawRad;
    this.pitchVis = 0; this.rollVis = 0;
    this.battery = 1;
    this.infiniteBattery = false;
    this.onGround = startAgl < 1;
    this.armed = startAgl >= 1;
    this.idleTimer = 0;
    this.spinAngle = 0;
    this.odometer = 0;
    this.bumps = 0;
    this.bumpCooldown = 0;
    this.bumpedFlag = false;
    this.camYaw = yawRad;
    this.camSnap = true;
    this.t = 0;
    this.probeTimerF = 0;
    this.probeTimerD = 0;
    this.dead = false;
    this.cargoKg = 0;
    this.collisions = true;
    this.active = true;
  }

  get position() { return Cesium.Cartesian3.fromRadians(this.lon, this.lat, this.h); }
  get latDeg() { return Cesium.Math.toDegrees(this.lat); }
  get lonDeg() { return Cesium.Math.toDegrees(this.lon); }
  get speed() { return Math.hypot(this.vE, this.vN); }
  get speed3() { return Math.hypot(this.vE, this.vN, this.vU); }
  get agl() { return Math.max(0, this.h - this.groundH); }
  get headingDeg() { return ((Cesium.Math.toDegrees(this.yaw) % 360) + 360) % 360; }

  /** Take-off/landing recharge etc. */
  addBattery(frac) { this.battery = clamp(this.battery + frac, 0, 1); }

  update(dt, input) {
    if (!this.active) return;
    dt = Math.min(dt, 0.1);
    this.t += dt;
    const s = this.spec;
    this.bumpCooldown = Math.max(0, this.bumpCooldown - dt);

    let inp = input;
    if (this.battery <= 0) {
      this.dead = true;
      inp = { fwd: 0, right: 0, up: -0.6, yaw: 0 };
    }
    if (inp.up > 0.05 && this.battery > 0) this.armed = true;

    // yaw
    this.yaw = wrapPi(this.yaw + inp.yaw * 1.9 * dt);

    // target velocity (body frame -> east/north)
    const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
    const maxV = s.maxSpeed;
    let tgtE = 0, tgtN = 0, tgtU = inp.up * s.vSpeed;
    const canMove = !this.onGround || inp.up > 0.05;
    if (canMove) {
      const f = inp.fwd * maxV, r = inp.right * maxV;
      tgtE = f * sy + r * cy;
      tgtN = f * cy - r * sy;
    }
    const k = 1.4 + s.accel / 5;
    const a = 1 - Math.exp(-k * dt);
    this.vE += (tgtE - this.vE) * a;
    this.vN += (tgtN - this.vN) * a;
    this.vU += (tgtU - this.vU) * (1 - Math.exp(-(k + 1) * dt));

    // move
    const rad = R_EARTH + this.h;
    this.lat += (this.vN * dt) / rad;
    this.lon += (this.vE * dt) / (rad * Math.max(Math.cos(this.lat), 0.01));
    this.h += this.vU * dt;
    this.odometer += this.speed * dt;

    // ground
    const floor = this.groundH + 0.36;
    if (this.h <= floor) {
      this.h = floor;
      if (this.vU < 0) this.vU = 0;
      this.onGround = true;
    } else {
      this.onGround = this.h < floor + 0.15 && this.vU <= 0.05;
    }
    if (this.h > this.groundH + 350 && inp.up > 0) this.vU = Math.min(this.vU, 0); // ceiling

    // probes (ground height + walls)
    this.runProbes(dt);

    // battery
    const speedFrac = this.speed / maxV;
    const cargoFrac = this.cargoKg / Math.max(1, s.cargo);
    const flying = !this.onGround || inp.up > 0.05;
    let drain = flying ? 0.5 + 0.9 * speedFrac + 0.25 * cargoFrac + Math.abs(this.vU) / s.vSpeed * 0.2 : 0.04;
    if (this.battery > 0 && !this.infiniteBattery) this.battery = Math.max(0, this.battery - (drain / s.battery) * dt);

    // visual tilt
    const fwdV = this.vE * sy + this.vN * cy;
    const rightV = this.vE * cy - this.vN * sy;
    const tp = clamp(fwdV / maxV, -1, 1) * 0.42;
    const tr = clamp(rightV / maxV, -1, 1) * 0.38;
    const b = 1 - Math.exp(-6 * dt);
    this.pitchVis += (tp - this.pitchVis) * b;
    this.rollVis += (tr - this.rollVis) * b;

    // rotors
    if (this.onGround && inp.up <= 0.05) {
      this.idleTimer += dt;
      if (this.idleTimer > 1.5) this.armed = false;
    } else this.idleTimer = 0;
    this.rotorOn = this.armed && this.battery > 0 || !this.onGround;
    const load = clamp(0.25 + speedFrac * 0.5 + Math.abs(this.vU) / s.vSpeed * 0.25, 0, 1);
    this.load = this.rotorOn ? load : 0;
    this.spinAngle += dt * (this.rotorOn ? 45 + 70 * load : 6);
  }

  runProbes(dt) {
    const world = this.world;
    if (!world.probeOk) return;
    this.probeTimerD -= dt;
    this.probeTimerF -= dt;
    const pos = this.position;
    const enu = Cesium.Transforms.eastNorthUpToFixedFrame(pos, Cesium.Ellipsoid.WGS84, this._enu);
    const t0 = performance.now();

    // ground height straight down
    if (this.probeTimerD <= 0) {
      this.probeTimerD = 0.3 * this.probeScale;
      const up = new Cesium.Cartesian3(enu[8], enu[9], enu[10]);
      const origin = Cesium.Cartesian3.add(pos, Cesium.Cartesian3.multiplyByScalar(up, 1.0, new Cesium.Cartesian3()), new Cesium.Cartesian3());
      const down = Cesium.Cartesian3.negate(up, new Cesium.Cartesian3());
      const d = world.rayDistance(origin, down);
      // Never let a probe teleport us upward: if a surface is at/above our level
      // we are touching it, so treat it as the floor right under us.
      if (d !== undefined) this.groundH = Math.min(this.h + 1.0 - d, this.h - 0.36);
    }

    // obstacle ahead along our motion
    if (this.collisions && this.probeTimerF <= 0 && this.speed3 > 1.5) {
      this.probeTimerF = 0.1 * this.probeScale;
      const east = new Cesium.Cartesian3(enu[0], enu[1], enu[2]);
      const north = new Cesium.Cartesian3(enu[4], enu[5], enu[6]);
      const up = new Cesium.Cartesian3(enu[8], enu[9], enu[10]);
      const sp = this.speed3;
      const dir = new Cesium.Cartesian3();
      const tmp = new Cesium.Cartesian3();
      Cesium.Cartesian3.multiplyByScalar(east, this.vE / sp, tmp); Cesium.Cartesian3.add(dir, tmp, dir);
      Cesium.Cartesian3.multiplyByScalar(north, this.vN / sp, tmp); Cesium.Cartesian3.add(dir, tmp, dir);
      Cesium.Cartesian3.multiplyByScalar(up, this.vU / sp, tmp); Cesium.Cartesian3.add(dir, tmp, dir);
      Cesium.Cartesian3.normalize(dir, dir);
      const d = world.rayDistance(pos, dir);
      const limit = 1.6 + sp * 0.12;
      if (d !== undefined && d < limit && this.bumpCooldown <= 0) {
        // cancel motion toward the obstacle and bounce back a little
        const vn = this.vE * (dir.x * east.x + dir.y * east.y + dir.z * east.z) +
                   this.vN * (dir.x * north.x + dir.y * north.y + dir.z * north.z) +
                   this.vU * (dir.x * up.x + dir.y * up.y + dir.z * up.z);
        const de = dir.x * east.x + dir.y * east.y + dir.z * east.z;
        const dn = dir.x * north.x + dir.y * north.y + dir.z * north.z;
        const du = dir.x * up.x + dir.y * up.y + dir.z * up.z;
        this.vE -= de * (vn + 2.5);
        this.vN -= dn * (vn + 2.5);
        this.vU -= du * (vn + 2.5);
        this.bumps++;
        this.bumpCooldown = 0.7;
        this.bumpedFlag = true;
      }
    }

    const took = performance.now() - t0;
    if (took > 8) this.probeScale = Math.min(4, this.probeScale * 1.3);
    else if (took < 3) this.probeScale = Math.max(1, this.probeScale * 0.98);
  }

  // ----- rendering (call every frame just before the scene renders)
  render(dt) {
    if (!this.active || !this.droneModel) return;
    const pos = this.position;
    const enu = Cesium.Transforms.eastNorthUpToFixedFrame(pos, Cesium.Ellipsoid.WGS84, this._enu);

    const rot = this.rotation(this.pitchVis, this.rollVis, this._rot3);
    const local = Cesium.Matrix4.fromRotationTranslation(rot, Cesium.Cartesian3.ZERO, this._m4);
    this.droneModel.model.modelMatrix = Cesium.Matrix4.multiply(enu, local, new Cesium.Matrix4());
    this.droneModel.spin(this.spinAngle);

    this.updateCamera(dt, pos, enu, rot);
  }

  /** Rotation of the drone body in the local East-North-Up frame. */
  rotation(pitch, roll, out) {
    const theta = Math.PI / 2 - this.yaw;
    const rz = Cesium.Matrix3.fromRotationZ(theta, this._tmpA);
    const ry = Cesium.Matrix3.fromRotationY(pitch, this._tmpB);
    const rzy = Cesium.Matrix3.multiply(rz, ry, new Cesium.Matrix3());
    const rx = Cesium.Matrix3.fromRotationX(roll, this._tmpA);
    return Cesium.Matrix3.multiply(rzy, rx, out);
  }

  updateCamera(dt, pos, enu, rot) {
    const cam = this.world.viewer.camera;
    const spec = this.spec;
    let camPos, dir, up;

    if (this.camMode === 'fpv') {
      const rot2 = this.rotation(this.pitchVis * 0.35 + 0.1, this.rollVis * 0.4, new Cesium.Matrix3());
      const fwdLocal = Cesium.Matrix3.multiplyByVector(rot2, new Cesium.Cartesian3(1, 0, 0), new Cesium.Cartesian3());
      const upLocal = Cesium.Matrix3.multiplyByVector(rot2, new Cesium.Cartesian3(0, 0, 1), new Cesium.Cartesian3());
      dir = Cesium.Matrix4.multiplyByPointAsVector(enu, fwdLocal, new Cesium.Cartesian3());
      up = Cesium.Matrix4.multiplyByPointAsVector(enu, upLocal, new Cesium.Cartesian3());
      const off = new Cesium.Cartesian3(0.45 * spec.scale * 0.5 + 0.2, 0, 0.04);
      const offRot = Cesium.Matrix3.multiplyByVector(rot, off, new Cesium.Cartesian3());
      camPos = Cesium.Matrix4.multiplyByPoint(enu, offRot, new Cesium.Cartesian3());
    } else {
      const k = this.camSnap ? 1 : 1 - Math.exp(-4.5 * dt);
      this.camYaw = wrapPi(this.camYaw + wrapPi(this.yaw - this.camYaw) * k);
      this.camSnap = false;
      const D = 2.4 * spec.scale + 2.2 + (this.speed / spec.maxSpeed) * 3.5;
      const H = D * 0.34 + Math.max(0, this.pitchVis) * 2;
      const offset = new Cesium.Cartesian3(-Math.sin(this.camYaw) * D, -Math.cos(this.camYaw) * D, H);
      camPos = Cesium.Matrix4.multiplyByPoint(enu, offset, new Cesium.Cartesian3());
      const target = Cesium.Matrix4.multiplyByPoint(enu, new Cesium.Cartesian3(0, 0, 0.9), new Cesium.Cartesian3());
      dir = Cesium.Cartesian3.normalize(Cesium.Cartesian3.subtract(target, camPos, new Cesium.Cartesian3()), new Cesium.Cartesian3());
      up = Cesium.Ellipsoid.WGS84.geodeticSurfaceNormal(camPos, new Cesium.Cartesian3());
    }
    // orthonormalise
    const right = Cesium.Cartesian3.normalize(Cesium.Cartesian3.cross(dir, up, new Cesium.Cartesian3()), new Cesium.Cartesian3());
    const upFixed = Cesium.Cartesian3.cross(right, dir, new Cesium.Cartesian3());
    cam.setView({ destination: camPos, orientation: { direction: dir, up: upFixed } });
  }
}
