/* RECAP — a shareable poster for a finished drive: your real GPS track coloured by speed, and the numbers that matter.
 * Everything on it comes from what was recorded during the drive; nothing is filled in. */
(function (root) {
  'use strict';
  const MP = root.MP;
  const { units, fmt, ui, util } = MP;
  const { h, icon } = ui;
  const R = (MP.recap = {});
  const M_PER_MI = 1609.344;

  /** numbers for a saved trip record (pure) */
  R.stats = function (t) {
    const elapsed = Math.max(0, ((t.endedAt || Date.now()) - t.startedAt) / 1000);
    const harsh = (t.harsh ? t.harsh.brake + t.harsh.accel : 0);
    const longest = (t.stops || []).reduce((a, s) => Math.max(a, s.sec), 0);
    const l100 = t.fuelDistM > 5 * M_PER_MI && t.fuelL > 0.2 ? units.l100(t.fuelDistM, t.fuelL) : null;
    const st = {
      distM: t.distM || 0, elapsedSec: elapsed, movingSec: t.movingSec || 0, avgMps: t.movingSec > 0 ? t.distM / t.movingSec : 0, maxMps: t.maxMps || 0,
      stops: (t.stops || []).length, longestStopSec: longest, climbM: t.climbM || 0, nightM: t.nightM || 0, harsh, smoothness: MP.driving.score(harsh, t.distM || 0),
      l100, fuelL: t.fuelL || 0,
    };
    st.trophies = MP.trophies({
      nightMiles: st.nightM / M_PER_MI, climbM: st.climbM, smoothness: st.smoothness, miles: st.distM / M_PER_MI, stops: st.stops, longestStopSec: longest,
      mpgBeat: l100 ? Math.max(0, 1 - l100 / (235.215 / MP.S.prefs.mpg)) : 0,
    });
    return st;
  };

  function colorFor(mps) { // slow → blue-teal, cruising → amber, fast → red
    const mph = mps * 2.23694, t = util.clamp((mph - 15) / 60, 0, 1);
    const stops = [[90, 176, 255], [61, 220, 151], [255, 179, 0], [255, 90, 79]], k = t * (stops.length - 1), i = Math.min(stops.length - 2, Math.floor(k)), f = k - i;
    const c = stops[i].map((v, j) => Math.round(v + (stops[i + 1][j] - v) * f));
    return 'rgb(' + c.join(',') + ')';
  }

  /** draw the poster into a canvas (1080×1350) */
  R.draw = function (cv, t) {
    const W = 1080, H = 1350, ctx = cv.getContext('2d');
    cv.width = W; cv.height = H;
    const day = document.documentElement.dataset.theme === 'atlas';
    const C = day ? { bg: '#f1e8d3', panel: '#fffaf0', line: '#d8cba9', ink: '#1d2430', ink2: '#566070', ink3: '#8a8f99', acc: '#0c5bd6', sign: '#0a6b3f' } : { bg: '#07080a', panel: '#12151b', line: '#262c37', ink: '#f6ead4', ink2: '#b3a993', ink3: '#7a7260', acc: '#ffb300', sign: '#0b6e45' };
    const st = R.stats(t);
    ctx.fillStyle = C.bg; ctx.fillRect(0, 0, W, H);
    // faint contour lines
    ctx.strokeStyle = day ? 'rgba(138,109,59,.10)' : 'rgba(255,255,255,.035)'; ctx.lineWidth = 2;
    for (let y = 40; y < H; y += 46) { ctx.beginPath(); for (let x = 0; x <= W; x += 20) ctx.lineTo(x, y + Math.sin(x / 130 + y / 90) * 14); ctx.stroke(); }
    const F = (w, px) => w + ' ' + px + 'px "Barlow Condensed", "Arial Narrow", sans-serif';
    // brand sign
    ctx.fillStyle = C.sign; rr(ctx, 60, 56, 270, 84, 18); ctx.fill(); ctx.strokeStyle = '#fff'; ctx.lineWidth = 4; rr(ctx, 68, 64, 254, 68, 12); ctx.stroke();
    ctx.fillStyle = '#fff'; ctx.font = F('800', 46); ctx.textBaseline = 'middle'; ctx.textAlign = 'center'; ctx.fillText("TRIPPIN'", 195, 99);
    ctx.textAlign = 'right'; ctx.fillStyle = C.ink2; ctx.font = F('700', 34); ctx.fillText(fmt.day(t.startedAt).toUpperCase(), W - 60, 99);
    // title
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'; ctx.fillStyle = C.ink; ctx.font = F('800', 92);
    const title = (t.routeName || 'Free drive').toUpperCase();
    let size = 92; while (ctx.measureText(title).width > W - 120 && size > 44) { size -= 4; ctx.font = F('800', size); }
    ctx.fillText(title, 60, 250);
    ctx.fillStyle = C.ink3; ctx.font = F('600', 30); ctx.fillText(fmt.clock(t.startedAt) + ' → ' + fmt.clock(t.endedAt || Date.now()) + '  ·  ' + fmt.dur(st.elapsedSec) + ' door to door', 60, 296);
    // map panel
    const mx = 60, my = 330, mw = W - 120, mh = 560;
    ctx.fillStyle = C.panel; rr(ctx, mx, my, mw, mh, 28); ctx.fill(); ctx.strokeStyle = C.line; ctx.lineWidth = 2; rr(ctx, mx, my, mw, mh, 28); ctx.stroke();
    const cr = (t.crumbs || []).filter((c) => c[1] != null);
    if (cr.length >= 2) {
      let minX = 1, maxX = 0, minY = 1, maxY = 0;
      const P = cr.map((c) => ({ x: MP.geo.mercX(c[2]), y: MP.geo.mercY(c[1]), v: c[3] || 0 }));
      P.forEach((p) => { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); });
      const pad = 48, sx = (mw - pad * 2) / Math.max(1e-9, maxX - minX), sy = (mh - pad * 2) / Math.max(1e-9, maxY - minY), sc = Math.min(sx, sy);
      const ox = mx + (mw - (maxX - minX) * sc) / 2, oy = my + (mh - (maxY - minY) * sc) / 2;
      const X = (p) => ox + (p.x - minX) * sc, Y = (p) => oy + (p.y - minY) * sc;
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.strokeStyle = day ? '#fff' : '#000'; ctx.lineWidth = 17; ctx.beginPath(); P.forEach((p, i) => (i ? ctx.lineTo(X(p), Y(p)) : ctx.moveTo(X(p), Y(p)))); ctx.stroke();
      ctx.lineWidth = 9;
      for (let i = 1; i < P.length; i++) { ctx.strokeStyle = colorFor((P[i].v + P[i - 1].v) / 2); ctx.beginPath(); ctx.moveTo(X(P[i - 1]), Y(P[i - 1])); ctx.lineTo(X(P[i]), Y(P[i])); ctx.stroke(); }
      dot(ctx, X(P[0]), Y(P[0]), '#3ddc97', C.bg); dot(ctx, X(P[P.length - 1]), Y(P[P.length - 1]), '#ff5a4f', C.bg);
      // speed legend
      const lg = ctx.createLinearGradient(mx + 40, 0, mx + 300, 0); [0, 0.33, 0.66, 1].forEach((k, i) => lg.addColorStop(k, ['#5ab0ff', '#3ddc97', '#ffb300', '#ff5a4f'][i]));
      ctx.fillStyle = lg; rr(ctx, mx + 40, my + mh - 44, 260, 10, 5); ctx.fill();
      ctx.fillStyle = C.ink3; ctx.font = F('600', 22); ctx.textAlign = 'left'; ctx.fillText('SLOW', mx + 40, my + mh - 54); ctx.textAlign = 'right'; ctx.fillText('FAST', mx + 300, my + mh - 54);
    } else {
      ctx.fillStyle = C.ink3; ctx.font = F('700', 40); ctx.textAlign = 'center'; ctx.fillText('NO GPS TRACK RECORDED', mx + mw / 2, my + mh / 2); ctx.textAlign = 'left';
    }
    // stats
    const cells = [
      [units.dist(st.distM), units.distUnit().toUpperCase(), 'Distance'],
      [fmt.dur(st.movingSec).replace(' ', ''), '', 'Moving time'],
      [String(units.speed(st.avgMps)), units.speedUnit().toUpperCase(), 'Avg moving speed'],
      [String(units.speed(st.maxMps)), units.speedUnit().toUpperCase(), 'Top speed'],
      [String(st.stops), st.stops === 1 ? 'STOP' : 'STOPS', 'Stops'],
      [String(Math.round(units.metric ? st.climbM : st.climbM * 3.28084)), units.metric ? 'M' : 'FT', 'Climbed'],
    ];
    const cw = (W - 120) / 3;
    cells.forEach((c, i) => {
      const x = 60 + (i % 3) * cw, y = 940 + Math.floor(i / 3) * 150;
      ctx.fillStyle = C.ink3; ctx.font = F('700', 24); ctx.textAlign = 'left'; ctx.fillText(c[2].toUpperCase(), x, y);
      ctx.fillStyle = C.ink; ctx.font = F('800', 76); ctx.fillText(c[0], x, y + 72);
      if (c[1]) { const w = ctx.measureText(c[0]).width; ctx.fillStyle = C.acc; ctx.font = F('700', 28); ctx.fillText(c[1], x + w + 10, y + 72); }
    });
    // trophies
    ctx.textAlign = 'left'; let tx = 60;
    st.trophies.forEach((tr) => {
      ctx.font = F('700', 28); const w = ctx.measureText(tr.name.toUpperCase()).width + 60;
      if (tx + w > W - 60) return;
      ctx.fillStyle = C.acc; rr(ctx, tx, 1262, w, 52, 26); ctx.fill(); ctx.fillStyle = day ? '#fff' : '#1a1200'; ctx.fillText(tr.name.toUpperCase(), tx + 30, 1298); tx += w + 14;
    });
    if (!st.trophies.length) { ctx.fillStyle = C.ink3; ctx.font = F('600', 28); ctx.fillText('Real data from this drive only. No badges earned yet.', 60, 1298); }
    return st;
  };
  function rr(ctx, x, y, w, h_, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h_, r); ctx.arcTo(x + w, y + h_, x, y + h_, r); ctx.arcTo(x, y + h_, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
  function dot(ctx, x, y, col, ring) { ctx.fillStyle = ring; ctx.beginPath(); ctx.arc(x, y, 20, 0, 6.3); ctx.fill(); ctx.fillStyle = col; ctx.beginPath(); ctx.arc(x, y, 13, 0, 6.3); ctx.fill(); }

  /** open the recap for a saved trip id */
  R.open = async function (id) {
    const t = await MP.kv.get('trip:' + id);
    if (!t) { ui.toast('That drive\'s track is no longer on this phone', 'warn'); return; }
    try { if (document.fonts && document.fonts.load) await Promise.all([document.fonts.load('800 60px "Barlow Condensed"'), document.fonts.load('700 30px "Barlow Condensed"')]); } catch (e) { /* draw with fallback */ }
    const cv = h('canvas.poster');
    R.draw(cv, t);
    const name = 'trippin-recap-' + new Date(t.startedAt).toISOString().slice(0, 10) + '.png';
    const save = () => {
      const b64 = cv.toDataURL('image/png').split(',')[1];
      if (MP.native.available && MP.native.has('saveFile')) { if (!MP.native.call('saveFile', name, 'image/png', b64)) ui.toast('Could not save the image', 'error'); return; }
      const a = document.createElement('a'); a.href = cv.toDataURL('image/png'); a.download = name; document.body.appendChild(a); a.click(); a.remove();
    };
    const share = () => cv.toBlob(async (blob) => {
      try {
        const f = new File([blob], name, { type: 'image/png' });
        if (navigator.canShare && navigator.canShare({ files: [f] })) await navigator.share({ files: [f], title: 'My drive' });
        else if (MP.native.available && MP.native.has('share')) { save(); MP.native.call('share', 'My drive: ' + units.dist(t.distM) + ' ' + units.distUnit() + ' with Trippin\''); }
        else save();
      } catch (e) { if (e.name !== 'AbortError') ui.toast('Sharing failed: ' + e.message, 'warn'); }
    });
    ui.openSheet({
      title: 'Drive recap', body: h('div.recap', cv),
      actions: [
        { label: 'Delete', kind: 'ghost', onClick: async () => { const ok = await ui.confirmSheet('Delete this drive?', 'The track and recap are removed from this phone.', 'Delete', 'danger'); if (!ok) return; MP.kv.del('trip:' + id); MP.store.set('trips', MP.store.get('trips', []).filter((x) => x.id !== id)); MP.bus.emit('trips'); } },
        { label: 'Save', onClick: save, keepOpen: true }, { label: 'Share', kind: 'primary', onClick: share, keepOpen: true }],
    });
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = R;
  void icon;
})(typeof window !== 'undefined' ? window : globalThis);
