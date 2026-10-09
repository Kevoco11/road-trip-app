/* "Pit Window" — one chart that fuses the constraints that decide *when and where to stop*:
 *   sunlight · your alertness (model) · fuel · weather at your arrival time · the stops in the plan
 * and the recommendation that falls out of it: the window in which a stop satisfies every constraint.
 * Borrowed from race strategy: you don't pick "a gas station", you pick a window and the best place in it.
 */
(function (root) {
  'use strict';
  const MP = root.MP;
  const { util, fmt } = MP;

  const PHASE_COL = { day: '#f2c14e', golden: '#f08a24', dusk: '#9a5fd0', twilight: '#4b55b5', night: '#1d2a63' };

  /** -> {need, kind, urgent, opens, closes, best, poi, title, detail} or null */
  function recommend(F, pois) {
    if (!F) return null;
    const now = F.t[0];
    const cons = [];
    if (F.fuelEmptyMs) cons.push({ kind: 'fuel', ms: F.fuelEmptyMs - 12 * 60000, why: 'Fuel reaches your reserve around ' + fmt.clock(F.fuelEmptyMs) });
    if (F.alertBreakMs) cons.push({ kind: 'rest', ms: F.alertBreakMs - 5 * 60000, why: 'Alertness model drops below 45 around ' + fmt.clock(F.alertBreakMs) });
    cons.sort((a, b) => a.ms - b.ms);
    if (!cons.length) {
      return { need: false, F, title: 'Clear run', detail: F.fuelKnown ? 'No stop is forced before arrival at ' + fmt.clock(F.arriveMs) + '.' : 'Set your fuel level to include range in the plan.' };
    }
    const c = cons[0];
    const urgent = c.ms <= now + 3 * 60000;
    const opens = Math.max(now + 3 * 60000, c.ms - 75 * 60000);
    const closes = Math.max(opens + 6 * 60000, c.ms);
    const best = Math.max(opens, closes - 10 * 60000);
    let poi = null;
    if (pois && pois.length) {
      const aOpen = F.at(opens).along, aClose = F.at(closes).along;
      const night = F.at(best).sunAlt < -0.8;
      let list = pois.filter((p) => p.d >= aOpen && p.d <= aClose && (c.kind !== 'fuel' || p.fuel));
      if (!list.length) list = pois.filter((p) => p.d >= aOpen - 20000 && p.d <= aClose + 10000);
      list.sort((a, b) => (night ? (b.open24 ? 1 : 0) - (a.open24 ? 1 : 0) : 0) || b.d - a.d);
      poi = list[0] || null;
    }
    return {
      need: true, kind: c.kind, urgent, opens, closes, best, poi, F,
      title: urgent ? (c.kind === 'fuel' ? 'Fuel up now' : 'Take a break now') : (c.kind === 'fuel' ? 'Fuel stop by ' + fmt.clock(closes) : 'Break by ' + fmt.clock(closes)),
      detail: c.why + '.',
    };
  }

  /** the chart always sits on a dark instrument panel, whatever the app theme */
  function themeColors() {
    return { good: '#3ddc97', warn: '#ffb300', bad: '#ff5a4f', info: '#5ab0ff', accent: '#ffb300', ink: '#f3e9d5', ink3: '#8b8472', line: '#3b414d', surface: '#232730' };
  }

  /**
   * Draw the chart.  o = {from, to, mini, cursor, rec, hasWx}
   * Returns layout so callers can hit-test: {x(ms), ms(x), padL, W}
   */
  function draw(canvas, F, o) {
    const dpr = Math.min(root.devicePixelRatio || 1, 2);
    const W = canvas.clientWidth || 320, H = canvas.clientHeight || (o.mini ? 66 : 200);
    if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) { canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr); }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    if (!F) return null;
    const C = themeColors();
    const mini = !!o.mini;
    const padL = mini ? 0 : 44, padB = mini ? 13 : 20, padT = mini ? 0 : 18;
    const from = o.from != null ? o.from : F.t[0], to = o.to != null ? o.to : F.t[F.n - 1];
    const span = Math.max(60000, to - from);
    const X = (ms) => padL + ((ms - from) / span) * (W - padL);
    const lanes = mini
      ? [{ k: 'sun', h: 7 }, { k: 'alert', h: 21 }, { k: 'fuel', h: 15 }]
      : [{ k: 'sun', h: 14 }, { k: 'alert', h: 52 }, { k: 'fuel', h: 52 }].concat(o.hasWx ? [{ k: 'wx', h: 14 }] : []);
    const gap = mini ? 3 : 8;
    let y = padT;
    const i0 = Math.max(0, F.indexAt(from) - 0), i1 = Math.min(F.n - 1, F.indexAt(to) + 1);
    ctx.font = '600 11px "Barlow Condensed", sans-serif'; ctx.textBaseline = 'middle';

    const hatch = (x, yy, w, h, col) => {
      ctx.save(); ctx.beginPath(); ctx.rect(x, yy, w, h); ctx.clip(); ctx.strokeStyle = col; ctx.globalAlpha = 0.35; ctx.lineWidth = 1.5;
      for (let k = -h; k < w; k += 7) { ctx.beginPath(); ctx.moveTo(x + k, yy + h); ctx.lineTo(x + k + h, yy); ctx.stroke(); }
      ctx.restore();
    };

    for (const L of lanes) {
      const top = y, h = L.h; y += h + gap;
      if (!mini) {
        ctx.fillStyle = C.ink3; ctx.textAlign = 'left';
        ctx.fillText({ sun: 'SUN', alert: 'ALERT', fuel: 'FUEL', wx: 'WX' }[L.k], 0, top + (L.k === 'sun' || L.k === 'wx' ? h / 2 : 9));
        ctx.fillStyle = C.surface; ctx.globalAlpha = 0.5; ctx.fillRect(padL, top, W - padL, h); ctx.globalAlpha = 1;
      }
      if (L.k === 'fuel' && !F.fuelKnown) { hatch(padL, top, W - padL, h, C.ink3); continue; }
      for (let i = i0; i < i1; i++) {
        const xa = Math.max(padL, X(F.t[i])), xb = Math.min(W, X(F.t[i + 1]));
        if (xb <= xa) continue;
        const w = xb - xa + 0.6;
        if (L.k === 'sun') { ctx.fillStyle = PHASE_COL[MP.sun.phase(F.sunAlt[i])]; ctx.fillRect(xa, top, w, h); }
        else if (L.k === 'alert') {
          const v = F.alert[i]; const hh = Math.max(1.5, (v / 100) * h);
          ctx.fillStyle = v >= 70 ? C.good : v >= 45 ? C.warn : C.bad; ctx.globalAlpha = F.moving[i] ? 0.95 : 0.55;
          ctx.fillRect(xa, top + h - hh, w, hh); ctx.globalAlpha = 1;
        } else if (L.k === 'fuel') {
          const g = F.fuel[i]; if (isNaN(g)) continue;
          const hh = Math.max(1.5, (g / F.tank) * h);
          ctx.fillStyle = g <= F.reserve ? C.bad : g <= F.reserve + 2 ? C.warn : C.good; ctx.globalAlpha = 0.9;
          ctx.fillRect(xa, top + h - hh, w, hh); ctx.globalAlpha = 1;
        } else if (L.k === 'wx') {
          const hz = F.hazard[i];
          if (hz > 0) { ctx.fillStyle = hz >= 60 ? C.bad : hz >= 30 ? C.warn : C.info; ctx.fillRect(xa, top, w, h); }
        }
      }
      if (!mini && (L.k === 'alert')) {
        ctx.strokeStyle = C.ink3; ctx.globalAlpha = 0.5; ctx.lineWidth = 1; ctx.setLineDash([3, 4]);
        for (const th of [45, 70]) { const yy = top + h - (th / 100) * h; ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(W, yy); ctx.stroke(); }
        ctx.setLineDash([]); ctx.globalAlpha = 1;
      }
    }
    const bodyH = y - gap, bodyTop = padT;

    // recommended window
    const rec = o.rec;
    if (rec && rec.need) {
      const xa = Math.max(padL, X(rec.opens)), xb = Math.min(W, X(rec.closes));
      if (xb > padL && xa < W) {
        ctx.fillStyle = C.good; ctx.globalAlpha = 0.16; ctx.fillRect(xa, bodyTop - 2, Math.max(4, xb - xa), bodyH - bodyTop + 4); ctx.globalAlpha = 1;
        ctx.strokeStyle = C.good; ctx.lineWidth = 1.5; ctx.setLineDash([4, 3]); ctx.strokeRect(xa, bodyTop - 1, Math.max(4, xb - xa), bodyH - bodyTop + 2); ctx.setLineDash([]);
        const xb2 = X(rec.best);
        ctx.fillStyle = C.good; ctx.fillRect(xb2 - 1, bodyTop - 3, 2.5, bodyH - bodyTop + 6);
        ctx.beginPath(); ctx.arc(xb2, bodyTop - 3, 4, 0, 6.3); ctx.fill();
      }
    }
    // planned stops
    draw._labelEnd = -1;
    for (const m of F.marks) {
      const xa = X(m.t0), xb = Math.max(X(m.t1), xa + 3);
      if (xb < padL || xa > W) continue;
      ctx.fillStyle = C.accent; ctx.globalAlpha = 0.28; ctx.fillRect(xa, bodyTop, xb - xa, bodyH - bodyTop); ctx.globalAlpha = 1;
      ctx.fillStyle = C.accent; ctx.fillRect(xa, bodyTop - (mini ? 0 : 6), 2, bodyH - bodyTop + (mini ? 0 : 6));
      if (!mini) {
        ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'; ctx.fillStyle = C.ink;
        const label = (m.name || '').slice(0, 20) + ' · ' + Math.round(m.minutes) + 'm', lx = Math.max(padL, Math.min(W - 140, xa + 5));
        if (lx >= (draw._labelEnd || -1)) { ctx.fillText(label, lx, 11); draw._labelEnd = lx + ctx.measureText(label).width + 10; }
      }
    }
    // pois (small ticks on top)
    if (o.pois) for (const p of o.pois) {
      const tp = F.timeAtAlong(p.d); if (tp < from || tp > to) continue;
      ctx.fillStyle = p.fuel ? C.warn : C.info; ctx.beginPath(); ctx.arc(X(tp), mini ? 2.5 : 3, mini ? 2 : 3, 0, 6.3); ctx.fill();
    }
    // axis
    ctx.fillStyle = C.ink3; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    const hourMs = 3600000, spanH = span / hourMs, stepH = spanH > 14 ? 3 : spanH > 7 ? 2 : spanH > 3.5 ? 1 : 0.5;
    const first = Math.ceil(from / (stepH * hourMs)) * stepH * hourMs;
    for (let tt = first; tt <= to; tt += stepH * hourMs) {
      const xx = X(tt); if (xx < padL + 12 || xx > W - 14) continue;
      ctx.fillText(fmt.clockShort(tt), xx, bodyH + (mini ? 11 : 15));
      ctx.fillRect(xx - 0.5, bodyH + 1, 1, 3);
    }
    // "now" + cursor
    ctx.fillStyle = C.ink; ctx.fillRect(Math.max(padL, X(o.now != null ? o.now : F.t[0])) - 1, bodyTop - 3, 2, bodyH - bodyTop + 6);
    if (o.cursor != null) {
      const xc = X(o.cursor);
      ctx.fillStyle = C.accent; ctx.fillRect(xc - 1, bodyTop - 4, 2.5, bodyH - bodyTop + 8);
      ctx.beginPath(); ctx.arc(xc, (bodyTop + bodyH) / 2, 6, 0, 6.3); ctx.fill(); ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke();
    }
    return { X, msAt: (x) => from + util.clamp((x - padL) / (W - padL), 0, 1) * span, padL, W, from, to };
  }

  MP.pit = { recommend, draw, PHASE_COL };
})(typeof window !== 'undefined' ? window : globalThis);
