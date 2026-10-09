/* VOICE — spoken alerts and hands-free questions.
 *
 *   say(text)      speak through Android's TTS (APK) or the browser's speechSynthesis
 *   listen()       one spoken question via Android's SpeechRecognizer (APK) or webkitSpeechRecognition (Chrome)
 *   parse(text)    turn what you said into an intent; answer(intent) builds the reply from live state
 *   ask(text)      optional: free-form questions go to Google Gemini if you have added your own API key
 *
 * Replies are composed only from real state (GPS, route, OBD, forecast); if something isn't known the reply says so.
 */
(function (root) {
  'use strict';
  const MP = root.MP;
  const { units, fmt, util } = MP;
  const S = MP.S;
  const V = (MP.voice = { last: null });
  const doc = root.document;

  /* ---------------------------------------------------------------- speaking */
  const recent = {};
  let unlocked = false;
  const synth = () => (root.speechSynthesis || null);

  V.available = () => !!(MP.native.available && MP.native.has('speak')) || !!synth();
  V.canListen = () => (MP.native.available ? MP.native.has('listen') : !!(root.SpeechRecognition || root.webkitSpeechRecognition));

  /** call from a tap so browsers allow later, automatic speech */
  V.unlock = function () {
    if (unlocked || MP.native.available || !synth()) { unlocked = true; return; }
    try { const u = new root.SpeechSynthesisUtterance(' '); u.volume = 0; synth().speak(u); unlocked = true; } catch (e) { /* ignore */ }
  };

  /** speak `text` if voice is on. o = {force, key, cooldownMs}. returns true if it was spoken */
  V.say = function (text, o) {
    o = o || {};
    if (!text || (!S.prefs.voice && !o.force)) return false;
    if (o.key) {
      const now = Date.now();
      if (recent[o.key] && now - recent[o.key] < (o.cooldownMs || 60000)) return false;
      recent[o.key] = now;
    }
    V.last = { text, at: Date.now() };
    const rate = S.prefs.voiceRate || 1;
    try {
      if (MP.native.available && MP.native.has('speak')) { MP.native.call('speak', String(text), rate); return true; }
      if (synth()) {
        if (o.interrupt !== false) synth().cancel();
        const u = new root.SpeechSynthesisUtterance(String(text));
        u.rate = rate; u.lang = (root.navigator && root.navigator.language) || 'en-US';
        synth().speak(u); return true;
      }
    } catch (e) { console.warn('speech failed', e); }
    return false;
  };
  V.stop = function () {
    try { if (MP.native.available) MP.native.call('stopSpeak'); else if (synth()) synth().cancel(); } catch (e) { /* ignore */ }
  };
  /** short vibration pattern for alerts */
  V.buzz = function (ms) {
    if (!S.prefs.haptics) return;
    try { if (MP.native.available && MP.native.has('vibrate')) MP.native.call('vibrate', ms || 220); else if (root.navigator && root.navigator.vibrate) root.navigator.vibrate(ms || 220); } catch (e) { /* ignore */ }
  };

  /* ---------------------------------------------------------------- listening */
  let rec = null, listening = false;
  /** listen for one phrase. cb(text, isFinal) streams partial text; resolves with the final text. */
  V.listen = function (cb) {
    return new Promise((resolve, reject) => {
      if (listening) { V.cancelListen(); }
      if (!V.canListen()) { reject(new Error('Speech recognition is not available here. You can type your question instead.')); return; }
      V.stop();
      listening = true; MP.bus.emit('listening', true);
      const finish = (text, err) => {
        if (!listening) return;
        listening = false; MP.bus.emit('listening', false);
        offs.forEach((f) => f());
        if (err && !text) reject(new Error(err)); else resolve(text || '');
      };
      let offs = [];
      if (MP.native.available) {
        offs = [
          MP.native.on('speech', (t, fin) => { if (cb) cb(t, fin); if (fin) finish(t); }),
          MP.native.on('speechEnd', (err) => finish('', err ? 'Could not hear you (' + err + ')' : 'Nothing heard')),
        ];
        MP.native.call('listen');
        return;
      }
      const SR = root.SpeechRecognition || root.webkitSpeechRecognition;
      rec = new SR(); rec.lang = (root.navigator && root.navigator.language) || 'en-US'; rec.interimResults = true; rec.maxAlternatives = 1;
      let got = '';
      rec.onresult = (e) => { let t = ''; for (let i = e.resultIndex; i < e.results.length; i++) t += e.results[i][0].transcript; got = t; if (cb) cb(t, e.results[e.results.length - 1].isFinal); };
      rec.onerror = (e) => finish(got, e.error === 'not-allowed' ? 'Microphone permission was denied' : e.error);
      rec.onend = () => finish(got, got ? '' : 'Nothing heard');
      try { rec.start(); } catch (e) { finish('', e.message); }
    });
  };
  V.cancelListen = function () {
    try { if (MP.native.available) MP.native.call('cancelListen'); else if (rec) rec.abort(); } catch (e) { /* ignore */ }
    listening = false; MP.bus.emit('listening', false);
  };
  V.isListening = () => listening;

  /* --------------------------------------------------------------- commands */
  const RULES = [
    ['stop', /\b(stop talking|be quiet|quiet|shut up|silence|mute)\b/],
    ['mark', /\b(mark|black ?box|that was weird|record that)\b/],
    ['story', /\b(story|stories|tell me something|what'?s (around|nearby)|anything interesting|history)\b/],
    ['gas', /\b(gas|fuel|petrol|diesel|fill ?up|filling station)\b(?!.*\b(range|left|tank)\b)/],
    ['rest', /\b(rest area|rest stop|restroom|bathroom|toilet|service (plaza|area)|food|coffee|break)\b/],
    ['range', /\b(range|how much (gas|fuel)|tank|miles? left|fuel left)\b/],
    ['eta', /\b(eta|arriv\w*|what time|when (do|will) (we|i) (get|arrive)|how long)\b/],
    ['dist', /\b(how far|distance|miles? to go|km to go|remaining|to go)\b/],
    ['alert', /\b(tired|sleepy|alert|drowsy|fatigue|how am i|how('?m| am) i doing)\b/],
    ['weather', /\b(weather|rain|snow|storm|forecast|temperature|fog|ice)\b/],
    ['speed', /\b(speed|how fast|mph|km\/h)\b/],
    ['sun', /\b(sun|sunset|sunrise|glare|dark|daylight)\b/],
  ];
  /** what did the driver ask for? → {intent, text} (intent 'ask' = free-form) */
  V.parse = function (text) {
    const t = String(text || '').toLowerCase().replace(/[?!.,]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!t) return { intent: 'none', text: '' };
    for (const [intent, re] of RULES) if (re.test(t)) return { intent, text: t };
    return { intent: 'ask', text: t };
  };

  /** a distance the way a person says it: "300 feet", "0.8 miles", "12 miles", "1 kilometer" */
  const mi = V.dist = (m) => {
    const plural = (n, w) => n + ' ' + w + (Math.abs(n - 1) < 1e-9 ? '' : 's');
    if (units.metric) {
      if (m < 950) return plural(Math.max(10, Math.round(m / 10) * 10), 'meter');
      const km = m / 1000; return plural(km < 10 ? Math.round(km * 10) / 10 : Math.round(km), 'kilometer');
    }
    const ft = m * 3.28084;
    if (ft < 1000) return plural(Math.max(50, Math.round(ft / 50) * 50), 'foot').replace('foots', 'feet').replace('1 foots', '1 foot');
    const mile = m / 1609.344; return plural(mile < 10 ? Math.round(mile * 10) / 10 : Math.round(mile), 'mile');
  };
  function nextStop(fuelOnly) {
    const along = S.trip ? S.d.along || 0 : 0;
    if (!MP.intel) return null;
    return MP.intel.nextPois(along, { n: 1, fuel: fuelOnly })[0] || null;
  }

  /** the spoken reply for an intent, from live state. returns a string. */
  V.answer = function (p) {
    const d = S.d, r = S.route;
    switch (p.intent) {
      case 'speed': return d.stale && !S.car.connected ? 'I do not have a speed reading yet.' : 'You are going ' + units.speed(d.speedMps) + ' ' + (units.metric ? 'kilometers per hour' : 'miles per hour') + '.';
      case 'dist':
        if (!r) return 'No destination is set. You have driven ' + mi(S.trip ? S.trip.distM : 0) + ' on this trip.';
        return mi(d.remaining) + ' to go.';
      case 'eta':
        if (!r) return 'No destination is set, so I cannot give an arrival time.';
        return 'You will arrive around ' + fmt.clock(d.etaMs) + ', in ' + fmt.dur(((d.etaMs || Date.now()) - Date.now()) / 1000) + '.';
      case 'range': {
        const f = d.fuel;
        if (!f || f.gal == null) return 'I do not know your fuel level yet. Set it from the Fuel button on the Drive screen, or connect the OBD adapter.';
        return 'About ' + mi(f.rangeM) + ' of range before your reserve, from ' + units.vol(f.gal * 3.785411784).toFixed(1) + ' ' + (units.metric ? 'liters' : 'gallons') + (f.src === 'assumed' ? ', assuming a full tank.' : '.');
      }
      case 'gas': {
        if (!r) return 'I need a route to look ahead for fuel stops. Plan a trip first.';
        const p0 = nextStop(true);
        if (!p0) return S.intel.loading && S.intel.loading.pois === 'ok' ? 'I do not see any fuel stop on the rest of this route.' : 'Fuel stops have not loaded yet.';
        return 'Next fuel: ' + p0.name + ', ' + mi(p0.d - (S.d.along || 0)) + ' ahead' + (p0.open24 ? ', open all night.' : '.');
      }
      case 'rest': {
        if (!r) return 'I need a route to look ahead for rest stops. Plan a trip first.';
        const list = MP.intel.nextPois(S.trip ? S.d.along || 0 : 0, { n: 12 }).filter((x) => x.kind !== 'fuel');
        const q = list[0];
        return q ? 'Next ' + (q.kind === 'services' ? 'service plaza' : 'rest area') + ': ' + q.name + ', ' + mi(q.d - (S.d.along || 0)) + ' ahead.' : 'No rest area is listed on the rest of this route.';
      }
      case 'alert': {
        const a = d.alert;
        if (!a) return 'No estimate yet.';
        return 'My time-based estimate says your alertness is ' + a.score + ' percent, ' + a.level + '. ' + MP.alertness.advice(a.level, new Date().getHours()) + ' That is an estimate from drive time and the clock, not a measurement.';
      }
      case 'weather': {
        const along = S.trip ? d.along || 0 : 0;
        const w = MP.wxAt(along, Date.now());
        if (!w || w.unknown || w.label == null) return S.intel.loading && S.intel.loading.wx === 'fail' ? 'The forecast could not be loaded.' : 'I do not have a forecast for this route yet.';
        let ahead = '';
        if (r) {
          for (let k = 1; k <= 12; k++) {
            const a = Math.min(r.total, along + k * 10000), x = MP.wxAt(a, Date.now() + (r.timeAt(a) - r.timeAt(along)) * 1000);
            if (x.hazard >= 30 && x.hazard > (w.hazard || 0)) { ahead = ' Watch for ' + x.label.toLowerCase() + ' in ' + mi(a - along) + '.'; break; }
          }
        }
        return 'Right now: ' + w.label.toLowerCase() + ', ' + units.temp(w.tempC) + ' degrees.' + ahead;
      }
      case 'sun': {
        const ev = d.sunEvent;
        if (!d.sun) return 'I need a location first.';
        return (d.sun.alt > 0 ? 'The sun is up' : 'The sun is down') + (ev ? ', and ' + ev.type + ' is at ' + fmt.clock(ev.time) + '.' : '.') + (d.sun.glare > 0.4 ? ' Sun glare is likely: visor down.' : '');
      }
      case 'mark': {
        if (!MP.logger) return 'The black box is not running.';
        const ok = MP.logger.trigger('Marked moment', 'You asked for a mark');
        return ok ? 'Marked. I am saving the last minute.' : 'Already saving one.';
      }
      case 'story': {
        const s = V.nextStory();
        return s ? s.title + '. ' + s.extract : 'No roadside stories are loaded for this route.';
      }
      default: return '';
    }
  };

  /** the next unseen story ahead of the car (or the first on the route before the trip starts) */
  V.nextStory = function () {
    const along = S.trip ? S.d.along || 0 : 0;
    return (S.intel.stories || []).find((s) => s.d > along - 200) || null;
  };

  /** context lines for the optional Gemini co-pilot (facts only) */
  V.context = function () {
    const d = S.d, r = S.route, L = [];
    L.push('Time now: ' + new Date().toLocaleString());
    L.push('Speed: ' + units.speed(d.speedMps) + ' ' + units.speedUnit());
    if (r) { L.push('Route: ' + (S.plan ? S.plan.from.name + ' to ' + S.plan.to.name : '') + ', ' + mi(d.remaining) + ' remaining, ETA ' + fmt.clock(d.etaMs)); }
    else L.push('No destination set (free drive).');
    if (d.fuel && d.fuel.gal != null) L.push('Fuel range about ' + mi(d.fuel.rangeM));
    if (d.alert) L.push('Alertness estimate ' + d.alert.score + '% (' + d.alert.level + ')');
    const nf = r && nextStop(true); if (nf) L.push('Next fuel stop: ' + nf.name + ' in ' + mi(nf.d - (S.d.along || 0)));
    return L.join('\n');
  };

  /** free-form question → Gemini (needs the user's own key). resolves with reply text */
  V.ask = async function (question) {
    const key = S.prefs.geminiKey;
    if (!key) throw new Error('Free-form questions use Google Gemini. Add your own API key in Trip → Connections to turn this on.');
    const model = S.prefs.geminiModel || 'gemini-2.5-flash';
    const body = {
      systemInstruction: { parts: [{ text: 'You are the voice co-pilot in a road-trip app. The driver is driving: answer in at most two short sentences, plain words, no lists, no markdown. Use only the facts given; if you do not know, say so. Never encourage looking at a screen.' }] },
      contents: [{ role: 'user', parts: [{ text: 'Facts about the trip right now:\n' + V.context() + '\n\nDriver asks: ' + question }] }],
    };
    const res = await root.fetch('https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify(body),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((j.error && j.error.message) || 'Gemini returned HTTP ' + res.status);
    const text = j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts.map((p) => p.text).join(' ').trim();
    if (!text) throw new Error('Gemini sent no answer');
    return text;
  };

  /** the whole loop: text → intent → reply (spoken if voice is on). resolves with {intent, reply} */
  V.handle = async function (text, o) {
    o = o || {};
    const p = V.parse(text);
    if (p.intent === 'none') return { intent: 'none', reply: '' };
    if (p.intent === 'stop') { V.stop(); return { intent: 'stop', reply: '' }; }
    let reply;
    if (p.intent === 'ask') {
      try { reply = await V.ask(text); } catch (e) { reply = S.prefs.geminiKey ? 'Sorry, I could not reach Gemini: ' + e.message : 'I can answer: how far, ETA, next gas, next rest stop, weather, range, speed, how am I doing, sun, tell me a story, or mark that. For anything else, add a Gemini key in Trip.'; }
    } else reply = V.answer(p);
    if (o.speak !== false) V.say(reply, { force: o.force !== false });
    MP.bus.emit('voice-reply', { q: text, intent: p.intent, reply });
    return { intent: p.intent, reply };
  };

  /** the Drive screen's mic key: listen, then answer */
  V.converse = async function () {
    const ui = MP.ui;
    if (V.isListening()) { V.cancelListen(); return; }
    V.unlock();
    try {
      ui.toast('Listening…', 'info', 2500);
      const heard = await V.listen();
      if (!heard) return;
      ui.toast('“' + heard + '”', 'info', 2500);
      const r = await V.handle(heard);
      if (r.reply) ui.toast(r.reply, 'info', 6000);
    } catch (e) { ui.toast(e.message, 'warn', 4500); }
  };
  V.listenKey = V.converse;

  if (typeof module !== 'undefined' && module.exports) module.exports = V;
  void doc; void util;
})(typeof window !== 'undefined' ? window : globalThis);
