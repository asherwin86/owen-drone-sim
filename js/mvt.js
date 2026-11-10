// Minimal Mapbox Vector Tile (.pbf) decoder with no dependencies.
// Only what the game needs: read named layers, their feature properties and polygon rings.

class Reader {
  constructor(buf, pos = 0, end = buf.length) {
    this.buf = buf;
    this.pos = pos;
    this.end = end;
  }

  varint() {
    let result = 0, shift = 0, b;
    do {
      b = this.buf[this.pos++];
      result += (b & 0x7f) * 2 ** shift;
      shift += 7;
    } while (b & 0x80 && this.pos < this.end);
    return result;
  }

  skip(wire) {
    if (wire === 0) this.varint();
    else if (wire === 1) this.pos += 8;
    else if (wire === 2) { const len = this.varint(); this.pos += len; }
    else if (wire === 5) this.pos += 4;
    else throw new Error(`bad wire type ${wire} at byte ${this.pos}, bytes: ${Array.from(this.buf.subarray(Math.max(0, this.pos - 8), this.pos + 4)).map((b) => b.toString(16)).join(' ')}`);
  }

  /** Reads a length-delimited field and returns a sub-reader over it. */
  sub() {
    const len = this.varint();
    const r = new Reader(this.buf, this.pos, this.pos + len);
    this.pos += len;
    return r;
  }

  string() {
    const len = this.varint();
    const s = new TextDecoder().decode(this.buf.subarray(this.pos, this.pos + len));
    this.pos += len;
    return s;
  }

  packedVarints() {
    const r = this.sub();
    const out = [];
    while (r.pos < r.end) out.push(r.varint());
    return out;
  }
}

const zigzag = (n) => (n % 2 === 0 ? n / 2 : -(n + 1) / 2);

function readValue(r) {
  let v = null;
  while (r.pos < r.end) {
    const tag = r.varint();
    const field = Math.floor(tag / 8), wire = tag & 7;
    if (field === 1) v = r.string();
    else if (field === 2) { v = new DataView(r.buf.buffer, r.buf.byteOffset + r.pos, 4).getFloat32(0, true); r.pos += 4; }
    else if (field === 3) { v = new DataView(r.buf.buffer, r.buf.byteOffset + r.pos, 8).getFloat64(0, true); r.pos += 8; }
    else if (field === 4 || field === 5) v = r.varint();
    else if (field === 6) v = zigzag(r.varint());
    else if (field === 7) v = r.varint() !== 0;
    else r.skip(wire);
  }
  return v;
}

/** Turns an MVT geometry command list into rings of [x, y] points. */
function decodeRings(cmds) {
  const rings = [];
  let ring = null, x = 0, y = 0, i = 0;
  while (i < cmds.length) {
    const c = cmds[i++];
    const cmd = c & 7, count = Math.floor(c / 8);
    if (cmd === 1 || cmd === 2) {
      for (let k = 0; k < count; k++) {
        x += zigzag(cmds[i++]);
        y += zigzag(cmds[i++]);
        if (cmd === 1) { ring = [[x, y]]; rings.push(ring); }
        else ring.push([x, y]);
      }
    } else if (cmd === 7 && ring) {
      // closed; nothing to add
    }
  }
  return rings;
}

/** Vector tiles are usually gzip-compressed; unpack them if so. */
export async function inflateIfNeeded(arrayBuffer) {
  const b = new Uint8Array(arrayBuffer);
  if (b.length > 2 && b[0] === 0x1f && b[1] === 0x8b) {
    const stream = new Blob([arrayBuffer]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Response(stream).arrayBuffer();
  }
  return arrayBuffer;
}

/**
 * Decode only the layers in `wanted` (array of names).
 * Returns { layerName: { extent, features: [{ type, props, rings }] } }
 */
export function decodeTile(arrayBuffer, wanted) {
  const buf = new Uint8Array(arrayBuffer);
  const tile = new Reader(buf);
  const out = {};
  while (tile.pos < tile.end) {
    const tag = tile.varint();
    const field = Math.floor(tag / 8), wire = tag & 7;
    if (field !== 3) { tile.skip(wire); continue; }
    const layerReader = tile.sub();
    // First pass: find the name cheaply.
    const startPos = layerReader.pos;
    let name = null;
    while (layerReader.pos < layerReader.end) {
      const t = layerReader.varint();
      const f = Math.floor(t / 8), w = t & 7;
      if (f === 1) { name = layerReader.string(); break; }
      layerReader.skip(w);
    }
    if (!wanted.includes(name)) continue;
    layerReader.pos = startPos;
    const keys = [], values = [], rawFeatures = [];
    let extent = 4096;
    while (layerReader.pos < layerReader.end) {
      const t = layerReader.varint();
      const f = Math.floor(t / 8), w = t & 7;
      if (f === 2) rawFeatures.push(layerReader.sub());
      else if (f === 3) keys.push(layerReader.string());
      else if (f === 4) values.push(readValue(layerReader.sub()));
      else if (f === 5) extent = layerReader.varint();
      else layerReader.skip(w);
    }
    const features = [];
    for (const fr of rawFeatures) {
      let type = 0, tags = [], geom = [];
      while (fr.pos < fr.end) {
        const t = fr.varint();
        const f = Math.floor(t / 8), w = t & 7;
        if (f === 2) tags = fr.packedVarints();
        else if (f === 3) type = fr.varint();
        else if (f === 4) geom = fr.packedVarints();
        else fr.skip(w);
      }
      const props = {};
      for (let i = 0; i + 1 < tags.length; i += 2) props[keys[tags[i]]] = values[tags[i + 1]];
      features.push({ type, props, rings: decodeRings(geom) });
    }
    out[name] = { extent, features };
  }
  return out;
}

/** Signed area of a ring (positive/negative tells exterior vs hole). */
export function ringArea(ring) {
  let a = 0;
  for (let i = 0, n = ring.length, j = n - 1; i < n; j = i++) {
    a += (ring[j][0] + ring[i][0]) * (ring[i][1] - ring[j][1]);
  }
  return a / 2;
}

/** Group rings into polygons: [{ outer: ring, holes: [ring...] }]. */
export function groupPolygons(rings) {
  const polys = [];
  let outerSign = 0;
  for (const ring of rings) {
    if (ring.length < 3) continue;
    const area = ringArea(ring);
    if (area === 0) continue;
    if (outerSign === 0) outerSign = Math.sign(area);
    if (Math.sign(area) === outerSign) polys.push({ outer: ring, holes: [] });
    else if (polys.length) polys[polys.length - 1].holes.push(ring);
  }
  return polys;
}
