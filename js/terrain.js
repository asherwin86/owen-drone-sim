// Free, key-less, unlimited real-world terrain for the whole planet.
// Source: "Terrain Tiles on AWS" (Mapzen/AWS Open Data) in Terrarium PNG format.
//   height(m) = (R * 256 + G + B / 256) - 32768
// Resolution is ~30 m worldwide (better in some countries).
const Cesium = window.Cesium;

const URL_TEMPLATE = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
const MAX_Z = 13; // deeper map levels reuse this tile (no more real detail exists)
const GRID = 129; // samples per terrain tile side
const MAX_CACHE = 160;

export class OpenTerrain {
  constructor() {
    this.cache = new Map(); // "z/x/y" -> Float32Array(256*256) | null
    this.pending = new Map();
    this.canvas = new OffscreenCanvas(256, 256);
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
  }

  /** Heights (metres) of a 256x256 source tile. Failed/missing tiles become flat sea level. */
  async tile(z, x, y) {
    const key = `${z}/${x}/${y}`;
    if (this.cache.has(key)) {
      const v = this.cache.get(key);
      this.cache.delete(key); // refresh LRU order
      this.cache.set(key, v);
      return v;
    }
    if (this.pending.has(key)) return this.pending.get(key);
    const p = (async () => {
      let heights = null;
      try {
        const res = await fetch(URL_TEMPLATE.replace('{z}', z).replace('{x}', x).replace('{y}', y));
        if (res.ok) {
          const bmp = await createImageBitmap(await res.blob());
          this.ctx.clearRect(0, 0, 256, 256);
          this.ctx.drawImage(bmp, 0, 0);
          const d = this.ctx.getImageData(0, 0, 256, 256).data;
          heights = new Float32Array(256 * 256);
          for (let i = 0, j = 0; i < heights.length; i++, j += 4) {
            const h = d[j] * 256 + d[j + 1] + d[j + 2] / 256 - 32768;
            heights[i] = h < 0 ? 0 : h; // keep the sea flat
          }
        }
      } catch (e) {
        console.warn('Terrain tile failed', key, e);
      }
      this.cache.set(key, heights);
      if (this.cache.size > MAX_CACHE) this.cache.delete(this.cache.keys().next().value);
      this.pending.delete(key);
      return heights;
    })();
    this.pending.set(key, p);
    return p;
  }

  /** Bilinear height from a tile at fractional position (u, v in 0..1). */
  static sample(heights, u, v) {
    if (!heights) return 0;
    const px = Math.min(255, Math.max(0, u * 256 - 0.5));
    const py = Math.min(255, Math.max(0, v * 256 - 0.5));
    const x0 = Math.floor(px), y0 = Math.floor(py);
    const x1 = Math.min(255, x0 + 1), y1 = Math.min(255, y0 + 1);
    const fx = px - x0, fy = py - y0;
    const a = heights[y0 * 256 + x0], b = heights[y0 * 256 + x1];
    const c = heights[y1 * 256 + x0], d = heights[y1 * 256 + x1];
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
  }

  /** Terrain height at lon/lat degrees (loads the tile if needed). */
  async heightAt(lon, lat) {
    const n = 2 ** MAX_Z;
    const wx = ((lon + 180) / 360) * n;
    const s = Math.sin((lat * Math.PI) / 180);
    const wy = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n;
    const tx = Math.min(n - 1, Math.max(0, Math.floor(wx)));
    const ty = Math.min(n - 1, Math.max(0, Math.floor(wy)));
    return OpenTerrain.sample(await this.tile(MAX_Z, tx, ty), wx - tx, wy - ty);
  }

  /** Cached-only version of heightAt (returns undefined if the tile is not loaded yet). */
  heightAtSync(lon, lat) {
    const n = 2 ** MAX_Z;
    const wx = ((lon + 180) / 360) * n;
    const s = Math.sin((lat * Math.PI) / 180);
    const wy = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n;
    const tx = Math.min(n - 1, Math.max(0, Math.floor(wx)));
    const ty = Math.min(n - 1, Math.max(0, Math.floor(wy)));
    const t = this.cache.get(`${MAX_Z}/${tx}/${ty}`);
    return t === undefined ? undefined : OpenTerrain.sample(t, wx - tx, wy - ty);
  }

  /** Height grid for one Cesium terrain tile (Web Mercator tiling, row 0 = north). */
  async grid(x, y, level) {
    const z = Math.min(level, MAX_Z);
    const d = level - z;
    const ax = Math.floor(x / 2 ** d), ay = Math.floor(y / 2 ** d);
    const src = await this.tile(z, ax, ay);
    const out = new Float32Array(GRID * GRID);
    if (!src) return out;
    const n = 2 ** d;
    const ox = x - ax * n, oy = y - ay * n;
    for (let j = 0; j < GRID; j++) {
      const v = (oy + j / (GRID - 1)) / n;
      for (let i = 0; i < GRID; i++) {
        const u = (ox + i / (GRID - 1)) / n;
        out[j * GRID + i] = OpenTerrain.sample(src, u, v);
      }
    }
    return out;
  }

  provider() {
    return new Cesium.CustomHeightmapTerrainProvider({
      callback: (x, y, level) => this.grid(x, y, level),
      width: GRID,
      height: GRID,
      tilingScheme: new Cesium.WebMercatorTilingScheme(),
      credit: new Cesium.Credit('Terrain: Mapzen, SRTM, USGS 3DEP via AWS Open Data', false),
    });
  }
}
