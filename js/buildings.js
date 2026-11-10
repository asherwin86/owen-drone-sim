// Free, key-less, unlimited 3D buildings for the whole planet.
// Source: OpenFreeMap vector tiles (OpenStreetMap data, "building" layer with real heights).
// Each building gets walls with a procedural window texture and a coloured roof.
import earcut from '/node_modules/earcut/src/earcut.js';
import { decodeTile, groupPolygons } from './mvt.js';

const Cesium = window.Cesium;
const R = 6378137;
const Z = 14; // OpenFreeMap's most detailed zoom
const FACADE_W = 14; // metres of wall covered by one texture repeat (4 window bays)
const FACADE_H = 12.8; // metres of height covered by one texture repeat (4 floors)
const EIFFEL = { lon: 2.2945, lat: 48.8584 }; // drawn separately as a lattice tower

const PALETTES = [
  { name: 'cream', wall: '#dccfb8', glass: '#4f6b87', roof: '#8d857a' },
  { name: 'brick', wall: '#b5694f', glass: '#3f5368', roof: '#6c4b41' },
  { name: 'concrete', wall: '#b6b9bf', glass: '#46586d', roof: '#70747a' },
  { name: 'glass', wall: '#6f93b5', glass: '#2f4a66', roof: '#59616b' },
];

const CELL = 48; // metres per cell in the building lookup grid
const EMPTY = [];
const yieldNow = () => new Promise((r) => setTimeout(r, 0));
const rad = Math.PI / 180;

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 256x256 texture = 4 window bays x 4 floors. */
function makeFacadeCanvas(p, idx) {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  const r = rng(idx * 977 + 13);
  g.fillStyle = p.wall;
  g.fillRect(0, 0, 256, 256);
  for (let k = 0; k < 500; k++) {
    g.fillStyle = `rgba(${r() > 0.5 ? '0,0,0' : '255,255,255'},${r() * 0.05})`;
    g.fillRect(r() * 256, r() * 256, r() * 20 + 2, r() * 20 + 2);
  }
  const isGlass = p.name === 'glass';
  for (let fy = 0; fy < 4; fy++) {
    for (let bx = 0; bx < 4; bx++) {
      const x0 = bx * 64, y0 = fy * 64;
      const w = isGlass ? 60 : 30, h = isGlass ? 52 : 38;
      const x = x0 + (64 - w) / 2, y = y0 + (isGlass ? 4 : 11);
      // floor slab line
      g.fillStyle = 'rgba(0,0,0,0.13)';
      g.fillRect(x0, y0 + 60, 64, 4);
      // window glass with a sky-like gradient
      const grad = g.createLinearGradient(x, y, x, y + h);
      const roll = r();
      if (roll < 0.13) { grad.addColorStop(0, '#e9dfc9'); grad.addColorStop(1, '#cfc2a6'); } // curtains
      else if (roll < 0.22) { grad.addColorStop(0, '#1f2a36'); grad.addColorStop(1, '#141b24'); } // dark room
      else { grad.addColorStop(0, '#9fc2e0'); grad.addColorStop(0.45, p.glass); grad.addColorStop(1, '#1d2d3f'); }
      g.fillStyle = grad;
      g.fillRect(x, y, w, h);
      // frame + sill
      g.strokeStyle = 'rgba(20,20,25,0.55)';
      g.lineWidth = isGlass ? 2 : 3;
      g.strokeRect(x, y, w, h);
      if (!isGlass) {
        g.fillStyle = 'rgba(255,255,255,0.35)';
        g.fillRect(x - 3, y + h, w + 6, 3);
        g.fillStyle = 'rgba(20,20,25,0.4)';
        g.fillRect(x + w / 2 - 1, y, 2, h);
      }
    }
  }
  return c;
}

function paletteIndex(props, height, hashSeed) {
  const col = (props.colour || '').toString().toLowerCase();
  const m = /^#?([0-9a-f]{6})$/.exec(col);
  let r = -1, g = 0, b = 0;
  if (m) { const n = parseInt(m[1], 16); r = (n >> 16) & 255; g = (n >> 8) & 255; b = n & 255; }
  else if (/red|brick|brown|maroon|orange/.test(col)) return 1;
  else if (/blue|glass|teal|cyan/.test(col)) return 3;
  else if (/grey|gray|silver|concrete/.test(col)) return 2;
  else if (/white|cream|beige|yellow|tan|sand/.test(col)) return 0;
  if (r >= 0) {
    if (r > g + 22 && r > b + 35) return 1;
    if (b > r + 18) return 3;
    const lum = (r + g + b) / 3;
    return lum > 190 && r >= b ? 0 : 2;
  }
  const h = hashSeed % 10;
  if (height > 45) return h < 4 ? 3 : h < 7 ? 2 : 0;
  return h < 4 ? 0 : h < 6 ? 1 : h < 9 ? 2 : 0;
}

function makeGeometry(pos, nor, st, idx) {
  const posA = new Float64Array(pos);
  return new Cesium.Geometry({
    attributes: {
      position: new Cesium.GeometryAttribute({ componentDatatype: Cesium.ComponentDatatype.DOUBLE, componentsPerAttribute: 3, values: posA }),
      normal: new Cesium.GeometryAttribute({ componentDatatype: Cesium.ComponentDatatype.FLOAT, componentsPerAttribute: 3, values: new Float32Array(nor) }),
      st: new Cesium.GeometryAttribute({ componentDatatype: Cesium.ComponentDatatype.FLOAT, componentsPerAttribute: 2, values: new Float32Array(st) }),
    },
    indices: new Uint32Array(idx),
    primitiveType: Cesium.PrimitiveType.TRIANGLES,
    boundingSphere: Cesium.BoundingSphere.fromVertices(posA),
  });
}

function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
    const xi = ring[i], yi = ring[i + 1], xj = ring[j], yj = ring[j + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export class OpenBuildings {
  constructor(world, terrain) {
    this.world = world;
    this.terrain = terrain;
    this.scene = world.scene;
    this.tiles = new Map(); // "X/Y" -> record
    this.tileUrl = null;
    this.active = 0;
    this.lastUpdate = 0;
    this.radius = 1; // load a (2r+1) x (2r+1) block of tiles around the player
    this.stats = { buildings: 0, tiles: 0 };
  }

  async init() {
    const tj = await fetch('https://tiles.openfreemap.org/planet').then((r) => {
      if (!r.ok) throw new Error('OpenFreeMap HTTP ' + r.status);
      return r.json();
    });
    this.tileUrl = tj.tiles[0];
    this.makeMaterials();
  }

  makeMaterials() {
    this.mipmapped = false;
    this.wallMaterials = PALETTES.map((p, i) => {
      return new Cesium.Material({
        fabric: {
          type: 'DroneFacade' + i,
          uniforms: { image: makeFacadeCanvas(p, i) },
          source: `czm_material czm_getMaterial(czm_materialInput materialInput)
{
  czm_material material = czm_getDefaultMaterial(materialInput);
  vec2 st = materialInput.st;
  vec4 c = textureGrad(image, fract(st), dFdx(st), dFdy(st));
  material.diffuse = c.rgb;
  material.alpha = 1.0;
  material.specular = 0.08;
  material.shininess = 8.0;
  return material;
}`,
        },
        translucent: false,
      });
    });
    this.roofMaterials = PALETTES.map((p) => Cesium.Material.fromType('Color', { color: Cesium.Color.fromCssColorString(p.roof) }));
  }

  static tileOf(lat, lon) {
    const n = 2 ** Z;
    const s = Math.sin(lat * rad);
    return {
      X: Math.min(n - 1, Math.max(0, Math.floor(((lon + 180) / 360) * n))),
      Y: Math.min(n - 1, Math.max(0, Math.floor((0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n))),
    };
  }

  /** Once Cesium has created the wall textures, switch on mipmaps so far-away windows stay smooth. */
  enableMipmaps() {
    if (this.mipmapped) return;
    const ctx = this.scene.context;
    let ready = 0;
    for (const m of this.wallMaterials) {
      const tex = m._textures && m._textures.image;
      if (!tex) continue;
      ready++;
      try {
        tex.sampler = new Cesium.Sampler({
          minificationFilter: Cesium.TextureMinificationFilter.LINEAR_MIPMAP_LINEAR,
          magnificationFilter: Cesium.TextureMagnificationFilter.LINEAR,
          maximumAnisotropy: Math.min(8, ctx.maximumTextureFilterAnisotropy || 1),
        });
        tex.generateMipmap();
      } catch (e) {
        console.warn('Mipmaps unavailable', e);
      }
    }
    if (ready === this.wallMaterials.length) this.mipmapped = true;
  }

  /** Call often with the player's position; loads nearby tiles, drops far ones. */
  update(lat, lon) {
    this.enableMipmaps();
    const now = performance.now();
    if (now - this.lastUpdate < 350) return;
    this.lastUpdate = now;
    const { X, Y } = OpenBuildings.tileOf(lat, lon);
    const want = [];
    for (let dy = -this.radius; dy <= this.radius; dy++) {
      for (let dx = -this.radius; dx <= this.radius; dx++) want.push({ X: X + dx, Y: Y + dy, d: Math.abs(dx) + Math.abs(dy) });
    }
    want.sort((a, b) => a.d - b.d);
    for (const t of want) {
      const key = `${t.X}/${t.Y}`;
      if (!this.tiles.has(key) && this.active < 2) this.loadTile(t.X, t.Y);
    }
    for (const [key, rec] of this.tiles) {
      if (Math.max(Math.abs(rec.X - X), Math.abs(rec.Y - Y)) > this.radius + 1) this.unloadTile(key, rec);
    }
  }

  /** Resolves when the tile under (lat, lon) and its neighbours are built (or failed). */
  async ensureAround(lat, lon, timeoutMs = 15000) {
    const t0 = performance.now();
    this.lastUpdate = 0;
    this.update(lat, lon);
    const { X, Y } = OpenBuildings.tileOf(lat, lon);
    for (;;) {
      this.update(lat, lon);
      let busy = false;
      for (let dy = -this.radius; dy <= this.radius; dy++) {
        for (let dx = -this.radius; dx <= this.radius; dx++) {
          const rec = this.tiles.get(`${X + dx}/${Y + dy}`);
          if (!rec || rec.state === 'loading') busy = true;
        }
      }
      if (!busy || performance.now() - t0 > timeoutMs) return;
      await new Promise((r) => setTimeout(r, 120));
    }
  }

  unloadTile(key, rec) {
    if (rec.collection) this.scene.primitives.remove(rec.collection);
    this.stats.buildings -= rec.footprints.length;
    this.stats.tiles--;
    this.tiles.delete(key);
  }

  async loadTile(X, Y) {
    const key = `${X}/${Y}`;
    const rec = { key, X, Y, state: 'loading', collection: null, footprints: [], lonC: 0, latC: 0, W: 0 };
    this.tiles.set(key, rec);
    this.active++;
    try {
      const url = this.tileUrl.replace('{z}', Z).replace('{x}', X).replace('{y}', Y);
      const [buf] = await Promise.all([
        fetch(url).then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error('tile HTTP ' + r.status)))),
        this.terrain.tile(13, X >> 1, Y >> 1),
      ]);
      if (!this.tiles.has(key)) return;
      const layer = decodeTile(buf, ['building']).building;
      if (layer) await this.build(rec, layer);
      rec.state = 'ready';
    } catch (e) {
      console.warn('Building tile failed', key, e);
      rec.state = 'error';
    } finally {
      this.active--;
    }
  }

  async build(rec, layer) {
    const { X, Y } = rec;
    const n = 2 ** Z;
    const lonC = ((X + 0.5) / n) * 360 - 180;
    const latC = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (Y + 0.5)) / n))) * 180) / Math.PI;
    const cosLat = Math.cos(latC * rad);
    const W = (2 * Math.PI * R * cosLat) / n;
    const ext = layer.extent || 4096;
    Object.assign(rec, { lonC, latC, W });

    const toLonLat = (x, y) => [lonC + ((x / (R * cosLat)) * 180) / Math.PI, latC + ((y / R) * 180) / Math.PI];
    const acc = PALETTES.map(() => ({ wp: [], wn: [], ws: [], wi: [], rp: [], rn: [], rs: [], ri: [] }));
    let counter = 0;

    for (const feature of layer.features) {
      const props = feature.props;
      if (props.hide_3d) continue;
      const H = Math.min(600, Math.max(3, Number(props.render_height) || 8));
      const minH = Math.max(0, Number(props.render_min_height) || 0);
      if (minH >= H) continue;

      for (const poly of groupPolygons(feature.rings)) {
        // keep each building in exactly one tile: the one holding its centre
        let cx = 0, cy = 0;
        for (const p of poly.outer) { cx += p[0]; cy += p[1]; }
        cx /= poly.outer.length; cy /= poly.outer.length;
        if (cx < 0 || cx >= ext || cy < 0 || cy >= ext) continue;

        const rings = [poly.outer, ...poly.holes].map((ring) => {
          const out = new Float64Array(ring.length * 2);
          ring.forEach((p, i) => {
            out[i * 2] = (p[0] / ext - 0.5) * W;
            out[i * 2 + 1] = (0.5 - p[1] / ext) * W;
          });
          return out;
        });

        const [clon, clat] = toLonLat((cx / ext - 0.5) * W, (0.5 - cy / ext) * W);
        if (Math.abs(clon - EIFFEL.lon) < 0.0013 && Math.abs(clat - EIFFEL.lat) < 0.0009) continue; // custom tower

        // sit the building on the lowest ground under its footprint
        let base = Infinity;
        const outer = rings[0];
        for (let i = 0; i < outer.length; i += 2) {
          const [lo, la] = toLonLat(outer[i], outer[i + 1]);
          const h = this.terrain.heightAtSync(lo, la);
          if (h !== undefined && h < base) base = h;
        }
        if (!Number.isFinite(base)) base = 0;
        const zTop = base + H;
        const zBot = base + minH - (minH > 0 ? 0 : 3);
        const pi = paletteIndex(props, H, Math.abs(Math.round(cx * 31 + cy * 17)));
        const a = acc[pi];
        const drop = (x, y) => (x * x + y * y) / (2 * R);

        // ---- walls
        for (const ring of rings) {
          const cnt = ring.length / 2;
          let area = 0;
          for (let i = 0, j = cnt - 1; i < cnt; j = i++) area += ring[j * 2] * ring[i * 2 + 1] - ring[i * 2] * ring[j * 2 + 1];
          const sign = area >= 0 ? 1 : -1;
          let cum = 0;
          for (let i = 0; i < cnt; i++) {
            const j = (i + 1) % cnt;
            const ax = ring[i * 2], ay = ring[i * 2 + 1], bx = ring[j * 2], by = ring[j * 2 + 1];
            const dx = bx - ax, dy = by - ay;
            const L = Math.hypot(dx, dy);
            if (L < 0.2) continue;
            const nx = (sign * dy) / L, ny = (-sign * dx) / L;
            const u0 = cum / FACADE_W, u1 = (cum + L) / FACADE_W;
            cum += L;
            const v1 = (zTop - zBot) / FACADE_H;
            const dA = drop(ax, ay), dB = drop(bx, by);
            const o = a.wp.length / 3;
            a.wp.push(ax, ay, zBot - dA, bx, by, zBot - dB, bx, by, zTop - dB, ax, ay, zTop - dA);
            for (let k = 0; k < 4; k++) a.wn.push(nx, ny, 0);
            a.ws.push(u0, 0, u1, 0, u1, v1, u0, v1);
            a.wi.push(o, o + 1, o + 2, o, o + 2, o + 3);
          }
        }

        // ---- roof
        const flat = [];
        const holeIdx = [];
        rings.forEach((ring, ri) => {
          if (ri > 0) holeIdx.push(flat.length / 2);
          for (let i = 0; i < ring.length; i++) flat.push(ring[i]);
        });
        const tris = earcut(flat, holeIdx, 2);
        if (tris.length) {
          const o = a.rp.length / 3;
          for (let i = 0; i < flat.length; i += 2) {
            a.rp.push(flat[i], flat[i + 1], zTop - drop(flat[i], flat[i + 1]));
            a.rn.push(0, 0, 1);
            a.rs.push(0, 0);
          }
          for (let i = 0; i < tris.length; i++) a.ri.push(o + tris[i]);
        }

        // ---- remember the footprint so we can tell where roofs are
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (let i = 0; i < outer.length; i += 2) {
          if (outer[i] < minX) minX = outer[i];
          if (outer[i] > maxX) maxX = outer[i];
          if (outer[i + 1] < minY) minY = outer[i + 1];
          if (outer[i + 1] > maxY) maxY = outer[i + 1];
        }
        const fp = { minX, maxX, minY, maxY, rings, top: zTop, bottom: zBot };
        rec.footprints.push(fp);
        this.indexFootprint(rec, fp);

        if (++counter % 250 === 0) {
          await yieldNow();
          if (!this.tiles.has(rec.key)) return;
        }
      }
    }

    if (!this.tiles.has(rec.key)) return;
    const origin = Cesium.Cartesian3.fromDegrees(lonC, latC, 0);
    const enu = Cesium.Transforms.eastNorthUpToFixedFrame(origin);
    const collection = new Cesium.PrimitiveCollection();
    const make = (g, material, support) =>
      new Cesium.Primitive({
        geometryInstances: new Cesium.GeometryInstance({ geometry: g }),
        appearance: new Cesium.MaterialAppearance({ material, materialSupport: support, closed: false, translucent: false }),
        modelMatrix: enu,
        asynchronous: false,
        compressVertices: false,
        releaseGeometryInstances: true,
        allowPicking: false,
      });
    acc.forEach((a, i) => {
      if (a.wp.length) collection.add(make(makeGeometry(a.wp, a.wn, a.ws, a.wi), this.wallMaterials[i], Cesium.MaterialAppearance.MaterialSupport.TEXTURED));
      if (a.rp.length) collection.add(make(makeGeometry(a.rp, a.rn, a.rs, a.ri), this.roofMaterials[i], Cesium.MaterialAppearance.MaterialSupport.TEXTURED));
    });
    rec.collection = collection;
    this.scene.primitives.add(collection);
    this.stats.buildings += rec.footprints.length;
    this.stats.tiles++;
  }

  // ---- spatial index so lookups stay fast even with thousands of buildings per tile
  indexFootprint(rec, f) {
    if (!rec.grid) rec.grid = new Map();
    const c0x = Math.floor(f.minX / CELL), c1x = Math.floor(f.maxX / CELL);
    const c0y = Math.floor(f.minY / CELL), c1y = Math.floor(f.maxY / CELL);
    for (let cx = c0x; cx <= c1x; cx++) {
      for (let cy = c0y; cy <= c1y; cy++) {
        const k = cx * 100000 + cy;
        let list = rec.grid.get(k);
        if (!list) rec.grid.set(k, (list = []));
        list.push(f);
      }
    }
  }

  /** Footprints near lat/lon: { list, x, y } (x, y = metres from the tile centre), or null. */
  nearby(lat, lon) {
    const { X, Y } = OpenBuildings.tileOf(lat, lon);
    const rec = this.tiles.get(`${X}/${Y}`);
    if (!rec || rec.state !== 'ready' || !rec.grid) return null;
    const x = (lon - rec.lonC) * rad * R * Math.cos(rec.latC * rad);
    const y = (lat - rec.latC) * rad * R;
    return { list: rec.grid.get(Math.floor(x / CELL) * 100000 + Math.floor(y / CELL)) || EMPTY, x, y };
  }

  static contains(f, x, y) {
    if (x < f.minX || x > f.maxX || y < f.minY || y > f.maxY) return false;
    if (!pointInRing(x, y, f.rings[0])) return false;
    for (let h = 1; h < f.rings.length; h++) if (pointInRing(x, y, f.rings[h])) return false;
    return true;
  }

  /** Height (above the ellipsoid) of the roof at lat/lon, or undefined if no building there. */
  roofHeightAt(lat, lon) {
    const q = this.nearby(lat, lon);
    if (!q) return undefined;
    let best;
    for (const f of q.list) if (OpenBuildings.contains(f, q.x, q.y) && (best === undefined || f.top > best)) best = f.top;
    return best;
  }

  /** Highest roof under a flying point (a roof counts if it is at or below height h), or undefined. */
  roofBelow(lat, lon, h) {
    const q = this.nearby(lat, lon);
    if (!q) return undefined;
    let best;
    for (const f of q.list) {
      if (f.top <= h + 0.4 && (best === undefined || f.top > best) && OpenBuildings.contains(f, q.x, q.y)) best = f.top;
    }
    return best;
  }

  /** True if the point (lat, lon, h) is inside a building. */
  solidAt(lat, lon, h) {
    const q = this.nearby(lat, lon);
    if (!q) return false;
    for (const f of q.list) if (h >= f.bottom && h <= f.top && OpenBuildings.contains(f, q.x, q.y)) return true;
    return false;
  }
}
