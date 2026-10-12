/* Minimal Mapbox Vector Tile decoder (protobuf wire format, no dependencies).
 *
 *   MP.mvt.decode(arrayBuffer, wanted?) → { layerName: { extent, features: [{ type, props, rings }] } }
 *
 *   type   1 point · 2 line · 3 polygon
 *   rings  array of rings; each ring is a flat [x0,y0,x1,y1,…] in tile units (0..extent, y grows south).
 *          For polygons the rings are grouped into [{ outer, holes }] under `polys` instead.
 *
 * `wanted` (array of layer names) skips layers the caller does not need — a z14 tile has ~16 layers and
 * we only use five of them, so this keeps decoding to a few milliseconds on a phone.
 */
(function (root) {
  'use strict';
  const MP = root.MP || (root.MP = {});

  function Reader(buf) { this.b = buf; this.i = 0; this.n = buf.length; }
  Reader.prototype.varint = function () {
    let r = 0, m = 1, c;
    do { c = this.b[this.i++]; r += (c & 0x7f) * m; m *= 128; } while (c & 0x80 && this.i < this.n);
    return r;
  };
  Reader.prototype.skip = function (wt) {
    if (wt === 0) this.varint(); else if (wt === 2) { const l = this.varint(); this.i += l; } else if (wt === 1) this.i += 8; else if (wt === 5) this.i += 4; else throw new Error('bad wire type ' + wt);
  };
  Reader.prototype.str = function (len) {
    let s = '', e = this.i + len;
    // names are ASCII/UTF-8; decode via TextDecoder when present, else a tolerant manual path
    if (typeof TextDecoder !== 'undefined') s = new TextDecoder().decode(this.b.subarray(this.i, e));
    else for (let k = this.i; k < e; k++) s += String.fromCharCode(this.b[k]);
    this.i = e; return s;
  };

  function readValue(rd, end) {
    let v = null;
    while (rd.i < end) {
      const k = rd.varint(), f = k >> 3, wt = k & 7;
      if (f === 1 && wt === 2) v = rd.str(rd.varint());
      else if (f === 2 && wt === 5) { v = new DataView(rd.b.buffer, rd.b.byteOffset + rd.i, 4).getFloat32(0, true); rd.i += 4; }
      else if (f === 3 && wt === 1) { v = new DataView(rd.b.buffer, rd.b.byteOffset + rd.i, 8).getFloat64(0, true); rd.i += 8; }
      else if (f === 4 || f === 5) v = rd.varint();
      else if (f === 6) { const z = rd.varint(); v = z % 2 ? -(z + 1) / 2 : z / 2; }
      else if (f === 7) v = !!rd.varint();
      else rd.skip(wt);
    }
    return v;
  }

  function readFeature(rd, end) {
    const ft = { type: 0, tags: [], geom: null };
    while (rd.i < end) {
      const k = rd.varint(), f = k >> 3, wt = k & 7;
      if (f === 2 && wt === 2) { const l = rd.varint(), e = rd.i + l; while (rd.i < e) ft.tags.push(rd.varint()); }
      else if (f === 3 && wt === 0) ft.type = rd.varint();
      else if (f === 4 && wt === 2) { const l = rd.varint(), e = rd.i + l, g = []; while (rd.i < e) g.push(rd.varint()); ft.geom = g; }
      else rd.skip(wt);
    }
    return ft;
  }

  /** commands → rings (flat coordinate arrays). Polygons are split into outer rings + holes by winding. */
  function geometry(type, g) {
    const rings = []; let cur = null, x = 0, y = 0, i = 0;
    while (i < g.length) {
      const cmd = g[i] & 7, cnt = g[i] >> 3; i++;
      if (cmd === 7) { if (cur && type === 3) { cur.push(cur[0], cur[1]); } if (cur) { rings.push(cur); cur = null; } continue; }
      for (let k = 0; k < cnt; k++) {
        const dx = g[i++], dy = g[i++];
        x += (dx >> 1) ^ -(dx & 1); y += (dy >> 1) ^ -(dy & 1);
        if (cmd === 1) { if (cur) rings.push(cur); cur = [x, y]; } else cur.push(x, y);
      }
      if (cmd === 1 && type === 1) { rings.push(cur); cur = null; }
    }
    if (cur) rings.push(cur);
    return rings;
  }
  const area2 = (r) => { let a = 0; for (let i = 0, n = r.length - 2; i < n; i += 2) a += r[i] * r[i + 3] - r[i + 2] * r[i + 1]; return a; };

  function polygons(rings) {
    const out = []; let cur = null;
    for (const r of rings) {
      if (r.length < 8) continue;
      // MVT: exterior rings have positive area in y-down tile space, holes negative
      if (area2(r) > 0) { cur = { outer: r, holes: [] }; out.push(cur); } else if (cur) cur.holes.push(r);
    }
    return out;
  }

  function decode(buf, wanted) {
    const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    const rd = new Reader(b), out = {};
    while (rd.i < rd.n) {
      const k = rd.varint(), f = k >> 3, wt = k & 7;
      if (f !== 3 || wt !== 2) { rd.skip(wt); continue; }
      const len = rd.varint(), end = rd.i + len;
      // pass 1: find the name (so unwanted layers are skipped without decoding their features)
      const start = rd.i; let name = null;
      while (rd.i < end) { const k2 = rd.varint(), f2 = k2 >> 3, w2 = k2 & 7; if (f2 === 1 && w2 === 2) { name = rd.str(rd.varint()); break; } rd.skip(w2); }
      if (wanted && wanted.indexOf(name) < 0) { rd.i = end; continue; }
      rd.i = start;
      const keys = [], vals = [], feats = []; let extent = 4096;
      while (rd.i < end) {
        const k2 = rd.varint(), f2 = k2 >> 3, w2 = k2 & 7;
        if (f2 === 1 && w2 === 2) rd.str(rd.varint());
        else if (f2 === 2 && w2 === 2) { const l = rd.varint(); feats.push(readFeature(rd, rd.i + l)); }
        else if (f2 === 3 && w2 === 2) keys.push(rd.str(rd.varint()));
        else if (f2 === 4 && w2 === 2) { const l = rd.varint(); vals.push(readValue(rd, rd.i + l)); }
        else if (f2 === 5 && w2 === 0) extent = rd.varint();
        else rd.skip(w2);
      }
      const lay = { extent, features: [] };
      for (const ft of feats) {
        const props = {};
        for (let t = 0; t + 1 < ft.tags.length; t += 2) props[keys[ft.tags[t]]] = vals[ft.tags[t + 1]];
        const rings = ft.geom ? geometry(ft.type, ft.geom) : [];
        const o = { type: ft.type, props, rings };
        if (ft.type === 3) o.polys = polygons(rings);
        lay.features.push(o);
      }
      out[name] = lay;
    }
    return out;
  }

  MP.mvt = { decode };
  if (typeof module !== 'undefined' && module.exports) module.exports = MP.mvt;
})(typeof window !== 'undefined' ? window : globalThis);
