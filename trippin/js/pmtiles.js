/* PMTILES — a tiny reader for PMTiles v3 archives served over plain HTTP range requests (no dependencies).
 *
 *   const a = MP.pmtiles.open(url);
 *   const bytes = await a.tile(z, x, y);     // the tile's (decompressed) bytes, or null when the archive has no such tile
 *
 * A PMTiles file is one huge static file with a small index at the front. Looking a tile up costs two or three range
 * requests (the first 16 kB holds the header and the root directory; then a leaf directory; then the tile itself), and the
 * directories are kept for the next lookup. world.js uses this for Overture Maps' building footprints, which sit in a
 * 180 GB archive on S3 — nothing is downloaded but the few hundred kilobytes of the tiles the drive actually needs.
 *
 * Spec: https://github.com/protomaps/PMTiles/blob/main/spec/v3/spec.md
 */
(function (root) {
  'use strict';
  const MP = root.MP || (root.MP = {});
  const P = (MP.pmtiles = {});
  const HEAD = 16384, LEAVES = 24;

  /** gzip → bytes: DecompressionStream in the WebView (and Node ≥ 18); zlib only as a last resort */
  P.gunzip = async function (u8) {
    if (typeof DecompressionStream !== 'undefined' && typeof Response !== 'undefined' && typeof Blob !== 'undefined') {
      return new Uint8Array(await new Response(new Blob([u8]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
    }
    if (typeof require === 'function') return new Uint8Array(require('zlib').gunzipSync(u8));
    throw new Error('this browser cannot decompress gzip');
  };
  async function unz(kind, u8) {
    if (kind === 1) return u8;                         // none
    if (kind === 2) return P.gunzip(u8);               // gzip
    throw new Error('unsupported PMTiles compression ' + kind);
  }

  /** (zoom, x, y) → the archive's tile id: tiles are ordered along a Hilbert curve, zoom by zoom */
  P.tileId = function (z, x, y) {
    if (z > 26) throw new Error('zoom too high');
    const n = Math.pow(2, z);
    if (x < 0 || y < 0 || x >= n || y >= n) throw new Error('tile out of range');
    let acc = 0; for (let t = 0; t < z; t++) acc += Math.pow(4, t);
    let d = 0, xx = x, yy = y;
    for (let s = n / 2; s >= 1; s /= 2) {
      const rx = (xx & s) > 0 ? 1 : 0, ry = (yy & s) > 0 ? 1 : 0;
      d += s * s * ((3 * rx) ^ ry);
      if (ry === 0) { if (rx === 1) { xx = s - 1 - xx; yy = s - 1 - yy; } const t = xx; xx = yy; yy = t; }
    }
    return acc + d;
  };

  P.parseHeader = function (b) {
    if (b.length < 127 || String.fromCharCode(b[0], b[1], b[2], b[3], b[4], b[5], b[6]) !== 'PMTiles') throw new Error('not a PMTiles archive');
    if (b[7] !== 3) throw new Error('unsupported PMTiles version ' + b[7]);
    const dv = new DataView(b.buffer, b.byteOffset, b.length), u64 = (o) => Number(dv.getBigUint64(o, true));
    return {
      rootOff: u64(8), rootLen: u64(16), metaOff: u64(24), metaLen: u64(32), leafOff: u64(40), leafLen: u64(48), dataOff: u64(56), dataLen: u64(64),
      tiles: u64(72), intComp: b[97], tileComp: b[98], tileType: b[99], minZ: b[100], maxZ: b[101],
      west: dv.getInt32(102, true) / 1e7, south: dv.getInt32(106, true) / 1e7, east: dv.getInt32(110, true) / 1e7, north: dv.getInt32(114, true) / 1e7,
    };
  };

  function varint(b, p) { let v = 0, m = 1, c; do { c = b[p.i++]; v += (c & 127) * m; m *= 128; } while (c & 128 && p.i < b.length); return v; }
  /** a directory (already decompressed) → [{ id, run, len, off }]; run 0 = the entry points at a leaf directory */
  P.parseDir = function (b) {
    const p = { i: 0 }, n = varint(b, p), e = new Array(n); let last = 0;
    for (let i = 0; i < n; i++) { last += varint(b, p); e[i] = { id: last, run: 0, len: 0, off: 0 }; }
    for (let i = 0; i < n; i++) e[i].run = varint(b, p);
    for (let i = 0; i < n; i++) e[i].len = varint(b, p);
    for (let i = 0; i < n; i++) { const v = varint(b, p); e[i].off = v === 0 && i > 0 ? e[i - 1].off + e[i - 1].len : v - 1; }
    return e;
  };
  function find(dir, id) {
    let lo = 0, hi = dir.length - 1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (dir[m].id <= id) lo = m + 1; else hi = m - 1; }
    const c = dir[hi]; if (!c) return null;
    return c.run === 0 || id < c.id + c.run ? c : null;
  }

  P.open = function (url, o) {
    o = o || {};
    const a = { url, h: null, root: null, requests: 0, bytes: 0 };
    const leaves = new Map(), pending = new Map();
    const F = () => o.fetch || P.fetchImpl || root.fetch.bind(root);

    async function range(off, len) {
      a.requests++;
      const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null, timer = ctl ? setTimeout(() => ctl.abort(), o.timeout || 25000) : null;
      try {
        const res = await F()(url, { headers: { Range: 'bytes=' + off + '-' + (off + len - 1) }, signal: ctl ? ctl.signal : undefined });
        if (res.status !== 206) {                      // 200 = the server ignored Range and would send the whole archive: never read that
          const e = new Error(res.status === 200 ? 'pmtiles: server ignores range requests' : 'pmtiles HTTP ' + res.status); e.status = res.status;
          if (res.body && res.body.cancel) try { res.body.cancel(); } catch (x) { /* ignore */ }
          throw e;
        }
        const buf = new Uint8Array(await res.arrayBuffer()); a.bytes += buf.length; return buf;
      } finally { if (timer) clearTimeout(timer); }
    }

    a.ready = function () {
      return a._ready || (a._ready = (async () => {
        const b = await range(0, HEAD), h = P.parseHeader(b);
        const rb = h.rootOff + h.rootLen <= b.length ? b.subarray(h.rootOff, h.rootOff + h.rootLen) : await range(h.rootOff, h.rootLen);
        a.root = P.parseDir(await unz(h.intComp, rb)); a.h = h; return h;
      })().catch((e) => { a._ready = null; throw e; }));
    };

    async function leaf(off, len) {
      const key = off + ':' + len;
      if (leaves.has(key)) { const v = leaves.get(key); leaves.delete(key); leaves.set(key, v); return v; }
      if (pending.has(key)) return pending.get(key);
      const p = (async () => { const d = P.parseDir(await unz(a.h.intComp, await range(a.h.leafOff + off, len))); leaves.set(key, d); while (leaves.size > LEAVES) leaves.delete(leaves.keys().next().value); return d; })();
      pending.set(key, p);
      try { return await p; } finally { pending.delete(key); }
    }

    a.tile = async function (z, x, y) {
      const h = await a.ready();
      if (z < h.minZ || z > h.maxZ) return null;
      const id = P.tileId(z, x, y);
      let dir = a.root;
      for (let depth = 0; depth < 4; depth++) {
        const e = find(dir, id); if (!e) return null;
        if (e.run > 0) return unz(h.tileComp, await range(h.dataOff + e.off, e.len));
        dir = await leaf(e.off, e.len);
      }
      return null;
    };
    return a;
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = P;
})(typeof window !== 'undefined' ? window : globalThis);
