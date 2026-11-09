// Builds a quadcopter / hexacopter / octocopter 3D model in code (a glTF object),
// so no model files are needed. Rotors can spin and a cargo box can show/hide.
const Cesium = window.Cesium;

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

// ---- geometry helpers (unit shapes, scaled by nodes) ----
function unitBox() {
  const pos = [], nor = [], idx = [];
  const faces = [
    [[1, 0, 0], [[0.5, -0.5, -0.5], [0.5, 0.5, -0.5], [0.5, 0.5, 0.5], [0.5, -0.5, 0.5]]],
    [[-1, 0, 0], [[-0.5, -0.5, 0.5], [-0.5, 0.5, 0.5], [-0.5, 0.5, -0.5], [-0.5, -0.5, -0.5]]],
    [[0, 1, 0], [[-0.5, 0.5, -0.5], [-0.5, 0.5, 0.5], [0.5, 0.5, 0.5], [0.5, 0.5, -0.5]]],
    [[0, -1, 0], [[-0.5, -0.5, 0.5], [-0.5, -0.5, -0.5], [0.5, -0.5, -0.5], [0.5, -0.5, 0.5]]],
    [[0, 0, 1], [[-0.5, -0.5, 0.5], [0.5, -0.5, 0.5], [0.5, 0.5, 0.5], [-0.5, 0.5, 0.5]]],
    [[0, 0, -1], [[0.5, -0.5, -0.5], [-0.5, -0.5, -0.5], [-0.5, 0.5, -0.5], [0.5, 0.5, -0.5]]],
  ];
  for (const [n, vs] of faces) {
    const base = pos.length / 3;
    for (const v of vs) { pos.push(...v); nor.push(...n); }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return { pos, nor, idx };
}

function unitCylinder(seg = 16) {
  const pos = [], nor = [], idx = [];
  for (let i = 0; i <= seg; i++) {
    const a = (i / seg) * Math.PI * 2;
    const c = Math.cos(a), s = Math.sin(a);
    pos.push(c * 0.5, -0.5, s * 0.5, c * 0.5, 0.5, s * 0.5);
    nor.push(c, 0, s, c, 0, s);
  }
  for (let i = 0; i < seg; i++) {
    const a = i * 2;
    idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }
  // caps
  const topC = pos.length / 3;
  pos.push(0, 0.5, 0); nor.push(0, 1, 0);
  const botC = topC + 1;
  pos.push(0, -0.5, 0); nor.push(0, -1, 0);
  const capStart = pos.length / 3;
  for (let i = 0; i <= seg; i++) {
    const a = (i / seg) * Math.PI * 2;
    const c = Math.cos(a) * 0.5, s = Math.sin(a) * 0.5;
    pos.push(c, 0.5, s); nor.push(0, 1, 0);
    pos.push(c, -0.5, s); nor.push(0, -1, 0);
  }
  for (let i = 0; i < seg; i++) {
    const t0 = capStart + i * 2, t1 = capStart + (i + 1) * 2;
    idx.push(topC, t1, t0);
    idx.push(botC, t0 + 1, t1 + 1);
  }
  return { pos, nor, idx };
}

function toBase64(bytes) {
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(s);
}

function quatY(a) {
  return [0, Math.sin(a / 2), 0, Math.cos(a / 2)];
}

/**
 * Returns { gltf, rotorNames, rotorHubs, spinDirs }
 * Model space (glTF): +Y up, +Z forward (nose).
 */
export function buildDroneGltf(spec) {
  const shapes = { box: unitBox(), cyl: unitCylinder(14) };
  const bufParts = [];
  const bufferViews = [];
  const accessors = [];
  let byteOffset = 0;

  function addAccessor(typedArray, target, type, componentType, count, minMax) {
    const bytes = new Uint8Array(typedArray.buffer, typedArray.byteOffset, typedArray.byteLength);
    const pad = (4 - (bytes.length % 4)) % 4;
    bufferViews.push({ buffer: 0, byteOffset, byteLength: bytes.length, target });
    bufParts.push(bytes);
    if (pad) bufParts.push(new Uint8Array(pad));
    byteOffset += bytes.length + pad;
    const acc = { bufferView: bufferViews.length - 1, componentType, count, type };
    if (minMax) { acc.min = minMax[0]; acc.max = minMax[1]; }
    accessors.push(acc);
    return accessors.length - 1;
  }

  const shapeAcc = {};
  for (const [name, s] of Object.entries(shapes)) {
    const p = new Float32Array(s.pos);
    const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < p.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        mn[k] = Math.min(mn[k], p[i + k]);
        mx[k] = Math.max(mx[k], p[i + k]);
      }
    }
    shapeAcc[name] = {
      pos: addAccessor(p, 34962, 'VEC3', 5126, p.length / 3, [mn, mx]),
      nor: addAccessor(new Float32Array(s.nor), 34962, 'VEC3', 5126, s.nor.length / 3),
      idx: addAccessor(new Uint16Array(s.idx), 34963, 'SCALAR', 5123, s.idx.length),
    };
  }

  // ---- materials ----
  const materials = [];
  const matIndex = {};
  function mat(key, hex, opts = {}) {
    if (matIndex[key] !== undefined) return matIndex[key];
    const [r, g, b] = hexToRgb(hex);
    const m = {
      name: key,
      pbrMetallicRoughness: {
        baseColorFactor: [r, g, b, 1],
        metallicFactor: opts.metal ?? 0.15,
        roughnessFactor: opts.rough ?? 0.55,
      },
    };
    if (opts.emissive) m.emissiveFactor = [r, g, b];
    materials.push(m);
    matIndex[key] = materials.length - 1;
    return matIndex[key];
  }
  const M = {
    body: mat('body', spec.color),
    accent: mat('accent', spec.accent),
    dark: mat('dark', '#1c1f26', { rough: 0.7 }),
    blade: mat('blade', '#2a2d35', { rough: 0.5 }),
    front: mat('front', '#34ff7a', { emissive: true }),
    back: mat('back', '#ff2b2b', { emissive: true }),
    cargo: mat('cargo', '#ff8a3d', { rough: 0.8 }),
    cargoTrim: mat('cargoTrim', '#ffffff', { rough: 0.8 }),
  };

  const meshes = [];
  const meshIndex = {};
  function mesh(shape, matId) {
    const key = shape + ':' + matId;
    if (meshIndex[key] !== undefined) return meshIndex[key];
    const a = shapeAcc[shape];
    meshes.push({
      primitives: [{ attributes: { POSITION: a.pos, NORMAL: a.nor }, indices: a.idx, material: matId }],
    });
    meshIndex[key] = meshes.length - 1;
    return meshIndex[key];
  }

  // ---- nodes ----
  const nodes = [];
  function node(def) {
    nodes.push(def);
    return nodes.length - 1;
  }
  const rootChildren = [];
  const add = (def) => { const i = node(def); rootChildren.push(i); return i; };

  // body + canopy
  add({ name: 'body', mesh: mesh('box', M.body), scale: [0.34, 0.11, 0.5] });
  add({ name: 'canopy', mesh: mesh('box', M.accent), translation: [0, 0.075, -0.02], scale: [0.22, 0.06, 0.28] });
  add({ name: 'battery', mesh: mesh('box', M.dark), translation: [0, 0.04, -0.12], scale: [0.18, 0.1, 0.2] });
  // nose + tail lights (so you can tell front from back)
  add({ name: 'nose', mesh: mesh('box', M.front), translation: [0, 0.0, 0.26], scale: [0.18, 0.05, 0.04] });
  add({ name: 'tail', mesh: mesh('box', M.back), translation: [0, 0.0, -0.26], scale: [0.18, 0.05, 0.04] });
  // camera gimbal
  add({ name: 'cam', mesh: mesh('box', M.dark), translation: [0, -0.085, 0.2], scale: [0.09, 0.07, 0.09] });
  // landing skids
  for (const sx of [-1, 1]) {
    add({ name: 'skid' + sx, mesh: mesh('box', M.dark), translation: [sx * 0.15, -0.16, 0], scale: [0.025, 0.025, 0.42] });
    for (const sz of [-1, 1]) {
      add({ name: `leg${sx}${sz}`, mesh: mesh('box', M.dark), translation: [sx * 0.15, -0.1, sz * 0.14], scale: [0.02, 0.12, 0.02] });
    }
  }

  // arms, motors, rotors
  const N = spec.arms;
  const armLen = 0.42 + (N > 4 ? 0.05 : 0);
  const rotorR = N === 4 ? 0.21 : N === 6 ? 0.18 : 0.15;
  const rotorNames = [];
  const rotorHubs = [];
  const spinDirs = [];
  for (let i = 0; i < N; i++) {
    const a = ((i + 0.5) / N) * Math.PI * 2;
    const sx = Math.sin(a), cz = Math.cos(a);
    add({
      name: 'arm' + i, mesh: mesh('box', i % 2 ? M.dark : M.accent),
      translation: [sx * armLen / 2, 0.0, cz * armLen / 2], rotation: quatY(a),
      scale: [0.045, 0.035, armLen],
    });
    add({ name: 'motor' + i, mesh: mesh('cyl', M.dark), translation: [sx * armLen, 0.03, cz * armLen], scale: [0.09, 0.07, 0.09] });
    // spinning rotor node with two blades
    const hub = [sx * armLen, 0.075, cz * armLen];
    const b1 = node({ name: 'blade1_' + i, mesh: mesh('box', M.blade), scale: [rotorR * 2, 0.008, 0.035] });
    const b2 = node({ name: 'blade2_' + i, mesh: mesh('box', M.blade), scale: [0.035, 0.008, rotorR * 2] });
    const rot = node({ name: 'rotor' + i, translation: hub, children: [b1, b2] });
    rootChildren.push(rot);
    rotorNames.push('rotor' + i);
    rotorHubs.push(hub);
    spinDirs.push(i % 2 ? 1 : -1);
  }

  // cargo box hanging underneath (toggle visibility)
  const cb = node({ name: 'cargoBox', mesh: mesh('box', M.cargo), scale: [0.3, 0.22, 0.3] });
  const ct = node({ name: 'cargoLid', mesh: mesh('box', M.cargoTrim), translation: [0, 0.12, 0], scale: [0.32, 0.03, 0.32] });
  const cargo = node({ name: 'cargo', translation: [0, -0.34, 0], children: [cb, ct] });
  rootChildren.push(cargo);

  const root = node({ name: 'drone', children: rootChildren });

  // ---- pack buffer ----
  let total = 0;
  for (const p of bufParts) total += p.length;
  const all = new Uint8Array(total);
  let off = 0;
  for (const p of bufParts) { all.set(p, off); off += p.length; }

  const gltf = {
    asset: { version: '2.0', generator: 'drone-sim' },
    scene: 0,
    scenes: [{ nodes: [root] }],
    nodes, meshes, materials, accessors, bufferViews,
    buffers: [{ byteLength: total, uri: 'data:application/octet-stream;base64,' + toBase64(all) }],
  };
  return { gltf, rotorNames, rotorHubs, spinDirs };
}

/** Creates the live Cesium Model for a drone spec. Resolves to a controller object. */
export async function createDroneModel(spec, scene) {
  const built = buildDroneGltf(spec);
  const model = await Cesium.Model.fromGltfAsync({
    gltf: built.gltf,
    scale: spec.scale,
    modelMatrix: Cesium.Matrix4.IDENTITY,
    incrementallyLoadTextures: false,
    shadows: Cesium.ShadowMode.DISABLED,
    backFaceCulling: false,
  });
  scene.primitives.add(model);

  // Nodes only exist once the model has rendered once, so look them up lazily.
  let rotors = null;
  let cargoNode = null;
  let wantCargo = false;
  const scratchR = new Cesium.Matrix3();
  const scratchM = new Cesium.Matrix4();
  const resolve = () => {
    if (rotors || !model.ready) return;
    rotors = built.rotorNames.map((n) => model.getNode(n));
    cargoNode = model.getNode('cargo');
  };

  return {
    model,
    // angle in radians
    spin(angle) {
      resolve();
      if (!rotors) return;
      if (cargoNode) cargoNode.show = wantCargo;
      for (let i = 0; i < rotors.length; i++) {
        const n = rotors[i];
        if (!n) continue;
        Cesium.Matrix3.fromRotationY(angle * built.spinDirs[i], scratchR);
        Cesium.Matrix4.fromRotationTranslation(scratchR, new Cesium.Cartesian3(...built.rotorHubs[i]), scratchM);
        n.matrix = Cesium.Matrix4.clone(scratchM);
      }
    },
    showCargo(show) {
      wantCargo = !!show;
      resolve();
      if (cargoNode) cargoNode.show = wantCargo;
    },
    destroy() {
      scene.primitives.remove(model);
    },
  };
}
