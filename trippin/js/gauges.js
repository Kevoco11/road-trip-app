/* GAUGES — every reading the Car deck can show: where it comes from, how it is scaled, and its recent history.
 *
 * A channel is one reading: either a value the engine computer sends (one OBD PID) or something worked out from a few
 * of them (boost from manifold and barometric pressure, power from the ECU's own torque figure and engine speed…).
 * Real data only: a channel has a value only while its sources are fresh, and a derived one says how it was derived.
 *
 *   G.list / G.ch(key)      the catalogue (grouped: Motion · Engine · Air & fuel · Temperatures · Electrical · Emissions)
 *   G.read(key)             → { c, raw, v, text, unit, frac, color, note }   (raw === null when the car is not sending it)
 *   G.state(key)            'live' | 'no' (this car does not report it) | 'unknown' (not connected, never seen)
 *   G.hist(key)             the real samples of the last two minutes: [{ t, r }] — recorded only when a reading arrives
 *   G.peak[key]             { hi, lo } since the connection started (or since G.resetSession())
 *   G.watchKeys(deckKeys)   the OBD keys those channels need (handed to MP.obd.watch so they are polled fast)
 */
(function (root) {
  'use strict';
  const MP = root.MP;
  const { util, units } = MP;
  const S = MP.S, E = MP.engine;
  const G = (MP.gauges = { list: [], peak: {}, session: { since: 0, idleMs: 0, runMs: 0 } });

  const COLD = '#58b7ff', OK = '#35e0a1', WARN = '#ffb224', BAD = '#ff5a4f';
  const HUE = { Motion: '#5ee7ff', Engine: '#ffb224', 'Air & fuel': '#b79bff', Temperatures: '#35e0a1', Electrical: '#d7f25a', Emissions: '#ff8fb1' };
  G.HUE = HUE; G.GROUPS = Object.keys(HUE);
  const PSI = 0.1450377, HP = 1.34102, LBFT = 0.737562, GAL = 3.785411784;
  const temp = (c) => (units.metric ? c : (c * 9) / 5 + 32);
  const car = (k) => E.car(k);
  const pidOf = (k) => (MP.obd ? MP.obd.PID_KEY[k] : null);

  const BY = {};
  /** o: { src:[keys all needed], opt:[keys that refine it], any:[alternatives — one is enough], raw(), conv(raw), range():[lo,hi] (display units),
   *       unit(), dec, band:[lo,hi] (raw, the normal range), zone(raw)→colour, note(), how: 'one line on where it comes from' } */
  function add(key, label, group, o) {
    const c = Object.assign({ key, label, short: label, group, hue: HUE[group], src: [], opt: [], any: null, dec: 0, conv: null, band: null, zone: null, note: null, how: '' }, o);
    if (!c.raw) c.raw = () => car(c.src[0]);
    if (!c.unit) c.unit = () => '';
    if (typeof c.unit === 'string') { const u = c.unit; c.unit = () => u; }
    if (Array.isArray(c.range)) { const r = c.range; c.range = () => r; }
    BY[key] = c; G.list.push(c);
  }
  const pctRange = [0, 100], trimRange = [-25, 25];
  const tempRange = (lo, hi) => () => [temp(lo), temp(hi)];
  const trimZone = (v) => (Math.abs(v) < 10 ? OK : Math.abs(v) < 20 ? WARN : BAD);

  /* ---- Motion */
  add('speed', 'Speed', 'Motion', { src: ['speedKmh'], conv: (k) => (units.metric ? k : k * 0.6213712), range: () => (units.metric ? [0, 220] : [0, 140]), unit: () => units.speedUnit(), how: 'The car\'s own speed sensor.' });
  add('gpsSpeed', 'GPS speed', 'Motion', { raw: () => (S.gps.lock && !S.d.stale && S.trip ? S.gps.speed * 3.6 : null), conv: (k) => (units.metric ? k : k * 0.6213712), range: () => (units.metric ? [0, 220] : [0, 140]), unit: () => units.speedUnit(), how: 'From the phone\'s GPS, while a drive is running. Needs no adapter.', gps: true });

  /* ---- Engine */
  add('rpm', 'Engine speed', 'Engine', { short: 'Engine', src: ['rpm'], range: [0, 8000], unit: 'rpm', how: 'Crankshaft speed from the engine computer.' });
  add('load', 'Engine load', 'Engine', { short: 'Load', src: ['load'], range: pctRange, unit: '%', zone: (v) => (v < 85 ? OK : WARN), how: 'How much of its available torque the engine is making right now.' });
  add('throttle', 'Throttle', 'Engine', { src: ['throttle'], range: pctRange, unit: '%', how: 'Throttle plate opening.' });
  add('pedal', 'Accelerator pedal', 'Engine', { short: 'Pedal', any: ['pedalD', 'pedal'], raw: () => { const d = car('pedalD'); return d != null ? d : car('pedal'); }, range: pctRange, unit: '%', how: 'Where your right foot is, as the car reads it.' });
  add('timing', 'Ignition timing', 'Engine', { short: 'Timing', src: ['timing'], range: [-20, 50], unit: '° BTDC', dec: 1, how: 'Spark advance before top dead centre (cylinder 1).' });
  add('torque', 'Engine torque', 'Engine', { short: 'Torque', src: ['torquePct', 'refTorqueNm'], raw: () => { const p = car('torquePct'), r = car('refTorqueNm', 9e9); return p != null && r ? (p / 100) * r : null; },
    conv: (n) => (units.metric ? n : n * LBFT), range: () => { const r = car('refTorqueNm', 9e9) || 400; return [0, units.metric ? r : r * LBFT]; }, unit: () => (units.metric ? 'N·m' : 'lb·ft'), how: 'The engine computer\'s own torque figure (percent of its reference torque).' });
  add('power', 'Engine power', 'Engine', { short: 'Power', src: ['torquePct', 'refTorqueNm', 'rpm'], raw: () => { const p = car('torquePct'), r = car('refTorqueNm', 9e9), n = car('rpm'); return p != null && r && n != null ? ((p / 100) * r * n * 2 * Math.PI) / 60000 : null; },
    conv: (kw) => (units.metric ? kw : kw * HP), range: () => { const r = car('refTorqueNm', 9e9) || 400, kw = (r * 6500 * 2 * Math.PI) / 60000; return [0, Math.ceil((units.metric ? kw : kw * HP) / 10) * 10]; }, unit: () => (units.metric ? 'kW' : 'hp'), how: 'Torque × engine speed, from the engine computer\'s own torque figure.' });
  add('absLoad', 'Absolute load', 'Engine', { src: ['absLoad'], range: [0, 150], unit: '%', how: 'Air per intake stroke compared with a full cylinder at sea level; above 100 % means boost.' });
  add('friction', 'Engine friction', 'Engine', { short: 'Friction', src: ['frictionPct'], range: [0, 50], unit: '%', how: 'Torque the engine spends turning itself, as a percent of reference torque.' });
  add('throttleCmd', 'Commanded throttle', 'Engine', { short: 'Throttle cmd', src: ['throttleCmd'], range: pctRange, unit: '%', how: 'What the engine computer is asking the throttle motor for.' });

  /* ---- Air & fuel */
  add('boost', 'Boost / vacuum', 'Air & fuel', { short: 'Boost', src: ['mapKpa'], opt: ['baroKpa'], raw: () => { const b = MP.obdBoost({ mapKpa: car('mapKpa'), baroKpa: car('baroKpa') }); return b ? b.kpa : null; },
    conv: (k) => (units.metric ? k : k * PSI), range: () => (units.metric ? [-100, 170] : [-14.7, 25]), unit: () => (units.metric ? 'kPa' : 'psi'), dec: 1, zone: (v) => (v < 0 ? COLD : v < 105 ? WARN : BAD),
    note: () => (car('baroKpa') == null && car('mapKpa') != null ? 'sea-level air assumed' : ''), how: 'Manifold pressure minus outside air pressure. Below zero is vacuum.' });
  add('map', 'Manifold pressure', 'Air & fuel', { short: 'Manifold', src: ['mapKpa'], range: [0, 255], unit: 'kPa', how: 'Absolute pressure in the intake manifold.' });
  add('maf', 'Air flow', 'Air & fuel', { src: ['mafGs'], range: [0, 250], unit: 'g/s', dec: 1, how: 'Mass of air entering the engine (MAF sensor).' });
  add('fuelLevel', 'Fuel level', 'Air & fuel', { short: 'Fuel', src: ['fuelLevel'], range: pctRange, unit: '%', zone: (v) => (v > 25 ? OK : v > 12 ? WARN : BAD), how: 'The tank sender, as the engine computer reports it.' });
  add('fuelFlow', 'Fuel flow', 'Air & fuel', { any: ['fuelRateLph', 'mafGs'], opt: ['mapKpa', 'iatC', 'rpm'], raw: () => { const c = S.car; return c.fuelLph != null && Date.now() - (c.lastFuelAt || 0) < 4000 ? c.fuelLph : null; },
    conv: (l) => (units.metric ? l : l / GAL), range: () => (units.metric ? [0, 40] : [0, 10]), unit: () => (units.metric ? 'L/h' : 'gal/h'), dec: 2,
    note: () => ({ ecu: '', maf: 'from air flow', est: 'estimated' }[S.car.fuelSrc] || ''), how: 'Fuel rate from the engine computer when it reports one, otherwise worked out from air flow.' });
  add('econ', 'Economy now', 'Air & fuel', { short: 'Economy', any: ['fuelRateLph', 'mafGs'], opt: ['speedKmh'], raw: () => { const c = S.car, k = car('speedKmh'); return c.fuelLph != null && Date.now() - (c.lastFuelAt || 0) < 4000 && k != null && k > 6 ? (c.fuelLph / k) * 100 : null; },
    conv: (l100) => (units.metric ? l100 : 235.215 / l100), range: () => (units.metric ? [0, 30] : [0, 60]), unit: () => units.econUnit(), dec: 1, how: 'Fuel flow ÷ speed, right now. Blank below walking pace.' });
  add('stft1', 'Short fuel trim', 'Air & fuel', { short: 'Trim short', src: ['stft1'], range: trimRange, unit: '%', dec: 1, zone: trimZone, band: [-10, 10], how: 'Moment-to-moment fuel correction, bank 1. Near zero is healthy.' });
  add('ltft1', 'Long fuel trim', 'Air & fuel', { short: 'Trim long', src: ['ltft1'], range: trimRange, unit: '%', dec: 1, zone: trimZone, band: [-10, 10], how: 'Learned fuel correction, bank 1. Far from zero points at a leak or a tired sensor.' });
  add('stft2', 'Short fuel trim (bank 2)', 'Air & fuel', { short: 'Trim short B2', src: ['stft2'], range: trimRange, unit: '%', dec: 1, zone: trimZone, band: [-10, 10], how: 'Moment-to-moment fuel correction, bank 2.' });
  add('ltft2', 'Long fuel trim (bank 2)', 'Air & fuel', { short: 'Trim long B2', src: ['ltft2'], range: trimRange, unit: '%', dec: 1, zone: trimZone, band: [-10, 10], how: 'Learned fuel correction, bank 2.' });
  add('lambda', 'Air-fuel ratio (λ)', 'Air & fuel', { short: 'Lambda', any: ['lambda34', 'lambda24'], raw: () => { const a = car('lambda34'); return a != null ? a : car('lambda24'); }, range: [0.7, 1.3], unit: 'λ', dec: 2, band: [0.97, 1.03], how: 'Measured by the wide-band sensor before the catalyst. 1.00 is a perfect burn; lower is rich.' });
  add('lambdaCmd', 'Commanded λ', 'Air & fuel', { short: 'λ target', src: ['lambdaCmd'], range: [0.7, 1.3], unit: 'λ', dec: 2, how: 'The mixture the engine computer is aiming for.' });
  add('fuelPressure', 'Fuel pressure', 'Air & fuel', { short: 'Fuel press.', any: ['railKpa', 'fuelKpa'], raw: () => { const r = car('railKpa'); return r != null ? r : car('fuelKpa'); }, conv: (k) => (units.metric ? k / 100 : k * PSI), range: () => { const rail = car('railKpa') != null; return units.metric ? [0, rail ? 250 : 8] : [0, rail ? 3600 : 110]; }, unit: () => (units.metric ? 'bar' : 'psi'), dec: () => (units.metric ? 1 : 0), how: 'Fuel rail (or pump) gauge pressure.' });
  add('ethanol', 'Ethanol in fuel', 'Air & fuel', { short: 'Ethanol', src: ['ethanol'], range: pctRange, unit: '%', how: 'Flex-fuel sensor.' });
  add('baro', 'Outside air pressure', 'Air & fuel', { short: 'Barometer', src: ['baroKpa'], conv: (k) => (units.metric ? k : k * 0.2953), range: () => (units.metric ? [60, 110] : [18, 32]), unit: () => (units.metric ? 'kPa' : 'inHg'), dec: () => (units.metric ? 0 : 1), how: 'The car\'s barometer.' });

  /* ---- Temperatures */
  add('coolant', 'Coolant', 'Temperatures', { src: ['coolantC'], conv: temp, range: tempRange(40, 130), unit: () => units.tempUnit(), band: [80, 105], zone: (v) => (v < 70 ? COLD : v < 106 ? OK : v < 114 ? WARN : BAD), how: 'Engine coolant temperature.' });
  add('oil', 'Oil temp', 'Temperatures', { src: ['oilC'], conv: temp, range: tempRange(40, 150), unit: () => units.tempUnit(), band: [80, 120], zone: (v) => (v < 70 ? COLD : v < 121 ? OK : v < 135 ? WARN : BAD), how: 'Engine oil temperature.' });
  add('intake', 'Intake air', 'Temperatures', { src: ['iatC'], conv: temp, range: tempRange(-20, 80), unit: () => units.tempUnit(), zone: (v) => (v < 50 ? OK : WARN), how: 'Air temperature in the intake.' });
  add('ambient', 'Outside air', 'Temperatures', { src: ['ambientC'], conv: temp, range: tempRange(-30, 50), unit: () => units.tempUnit(), zone: (v) => (v < 3 ? COLD : OK), how: 'The car\'s outside-temperature sensor.' });
  add('cat', 'Catalyst temp', 'Temperatures', { short: 'Catalyst', src: ['catC'], conv: temp, range: tempRange(0, 1000), unit: () => units.tempUnit(), zone: (v) => (v < 300 ? COLD : v < 850 ? OK : BAD), how: 'Catalytic converter temperature (bank 1).' });

  /* ---- Electrical */
  add('voltage', 'Voltage', 'Electrical', { src: ['voltage'], range: [9, 16], unit: 'V', dec: 1, band: [13.2, 14.8], zone: (v) => (v < 11.8 ? BAD : v < 12.4 ? WARN : v < 15 ? OK : WARN), note: () => (S.car.data.voltageSrc === 'adapter' ? 'read by the adapter' : ''), how: 'System voltage. About 14 V with the engine running means the alternator is charging.' });
  add('hybridBatt', 'Hybrid battery', 'Electrical', { src: ['hybridBatt'], range: pctRange, unit: '%', how: 'Remaining charge of the hybrid battery pack.' });

  /* ---- Emissions */
  add('o2s1', 'O₂ sensor (before cat)', 'Emissions', { short: 'O₂ front', src: ['o2s1V'], range: [0, 1.1], unit: 'V', dec: 2, how: 'Narrow-band sensor ahead of the catalyst. It should swing quickly between rich and lean.' });
  add('o2s2', 'O₂ sensor (after cat)', 'Emissions', { short: 'O₂ rear', src: ['o2s2V'], range: [0, 1.1], unit: 'V', dec: 2, how: 'Sensor behind the catalyst. A steady reading means the catalyst is working.' });
  add('evapPurge', 'Evap purge', 'Emissions', { src: ['evapPurge'], range: pctRange, unit: '%', how: 'Fuel-vapour purge valve duty.' });
  add('egr', 'EGR commanded', 'Emissions', { short: 'EGR', src: ['egrCmd'], range: pctRange, unit: '%', how: 'Exhaust-gas recirculation the engine computer is asking for.' });

  G.ch = (key) => BY[key] || null;
  const keysOf = (c) => c.src.concat(c.opt, c.any || []);
  G.watchKeys = function (deckKeys) {
    const out = new Set();
    (deckKeys || []).forEach((k) => { const c = BY[k]; if (c) keysOf(c).forEach((x) => out.add(x)); });
    return Array.from(out);
  };

  const dec = (c) => (typeof c.dec === 'function' ? c.dec() : c.dec);
  G.fmt = function (c, v) {
    const d = dec(c);
    if (d === 0) { const r = Math.round(v); return (Object.is(r, -0) ? 0 : r).toLocaleString('en-US'); }
    return v.toFixed(d);
  };
  /** a raw value of channel c as a 0..1 position on its scale */
  G.frac = function (c, raw) { const v = c.conv ? c.conv(raw) : raw, r = c.range(); return util.clamp((v - r[0]) / (r[1] - r[0]), 0, 1); };
  G.read = function (key) {
    const c = BY[key]; if (!c) return null;
    const raw = c.raw();
    if (raw == null || !isFinite(raw)) return { c, raw: null };
    const v = c.conv ? c.conv(raw) : raw;
    if (!isFinite(v)) return { c, raw: null };
    return { c, raw, v, text: G.fmt(c, v), unit: c.unit(), frac: G.frac(c, raw), color: c.zone ? c.zone(raw) : c.hue, note: c.note ? c.note() : '' };
  };
  /** 'live' · 'no' (connected, and this car does not report what it needs) · 'unknown' */
  G.state = function (key) {
    const c = BY[key], O = MP.obd; if (!c) return 'unknown';
    if (c.raw() != null) return 'live';
    if (c.gps) return 'unknown';
    const sup = O && O.state === 'polling' && O.supported.size ? O.supported : null;
    if (!sup) return 'unknown';
    const has = (k) => sup.has(pidOf(k)) || (k === 'voltage');   // voltage can always be read from the adapter itself
    return c.src.every(has) && (!c.any || c.any.some(has)) ? 'unknown' : 'no';
  };
  /** would the car described by this supported-PID list report the channel? (used for the "last connection" list) */
  G.supportedBy = function (key, pids) {
    const c = BY[key]; if (!c || c.gps) return false;
    const has = (k) => pids.has(pidOf(k)) || k === 'voltage';
    return c.src.every(has) && (!c.any || c.any.some(has)) && (c.src.length > 0 || !!c.any);
  };

  /* ------------------------------------------------------------- history */
  const H = {}, lastT = {};
  const KEEP = 125000;
  G.hist = (key) => H[key] || [];
  function record(c, t) {
    const r = c.raw(); if (r == null || !isFinite(r)) return;
    const a = H[c.key] || (H[c.key] = []);
    a.push({ t, r });
    while (a.length && t - a[0].t > KEEP) a.shift();
    const p = G.peak[c.key]; if (!p) G.peak[c.key] = { hi: r, lo: r }; else { if (r > p.hi) p.hi = r; if (r < p.lo) p.lo = r; }
  }
  function onObd() {
    const seen = S.car.seen;
    for (const c of G.list) {
      if (c.gps) continue;
      let t = 0; for (const k of keysOf(c)) { const s = seen[k]; if (s > t) t = s; }
      if (t > (lastT[c.key] || 0)) { lastT[c.key] = t; record(c, t); }
    }
    // session counters, from real engine-speed samples
    const tr = seen.rpm, ss = G.session;
    if (tr && tr !== ss._t) {
      const dt = ss._t ? Math.min(3000, tr - ss._t) : 0, rpm = S.car.data.rpm; ss._t = tr;
      if (rpm > 300 && dt > 0) { ss.runMs += dt; if (car('speedKmh') === 0) ss.idleMs += dt; }
    }
  }
  G.resetSession = function () { G.peak = {}; G.session = { since: Date.now(), idleMs: 0, runMs: 0 }; };
  if (MP.bus) {
    MP.bus.on('obd', onObd);
    MP.bus.on('gps', () => { const c = BY.gpsSpeed, t = S.gps.ts; if (t && t > (lastT.gpsSpeed || 0)) { lastT.gpsSpeed = t; record(c, t); } });
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = G;
})(typeof window !== 'undefined' ? window : globalThis);
