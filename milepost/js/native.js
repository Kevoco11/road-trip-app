/* Milepost native bridge (Android APK shell).
 *
 * When the app runs inside the Android WebView shell, `window.MilepostNative` is injected by the
 * Java side (see android/). WebView has no Web Bluetooth, no speech recognition and no wake-lock
 * guarantees, so those features are provided natively and exposed here with the same shape the
 * browser versions have. In a normal browser (Chrome, installed PWA) none of this is active and
 * the standard web APIs are used instead.
 *
 * JS → Java:  window.MilepostNative.<method>(…)      (strings / numbers / booleans only)
 * Java → JS:  window.MPN.<callback>(…)               (defined below; Java calls evaluateJavascript)
 */
(function (root) {
  'use strict';
  const MP = (root.MP = root.MP || {});
  const N = root.MilepostNative || null;
  const handlers = {};

  const api = {
    available: !!N,
    on(evt, cb) { (handlers[evt] = handlers[evt] || []).push(cb); return () => api.off(evt, cb); },
    off(evt, cb) { handlers[evt] = (handlers[evt] || []).filter((f) => f !== cb); },
    emit(evt, ...a) { (handlers[evt] || []).slice().forEach((f) => { try { f(...a); } catch (e) { console.error(e); } }); },
    /** safe call into the Java side; returns null if the method is missing */
    call(name, ...args) {
      try { return N && typeof N[name] === 'function' ? N[name](...args) : null; } catch (e) { console.warn('native call failed', name, e); return null; }
    },
    has(name) { return !!(N && typeof N[name] === 'function'); },
    version() { return api.call('version') || ''; },
  };

  root.MPN = {
    onScanResult(id, name, rssi) { api.emit('scan', { id, name: name || '', rssi }); },
    onScanDone() { api.emit('scanDone'); },
    onBleState(state, msg) { api.emit('bleState', state, msg || ''); },
    onBleData(text) { api.emit('bleData', text); },
    onPerm(kind, granted) { api.emit('perm', kind, !!granted); },
    onSpeech(text, isFinal) { api.emit('speech', text, !!isFinal); },
    onSpeechEnd(err) { api.emit('speechEnd', err || ''); },
    onTtsDone() { api.emit('ttsDone'); },
    onBack() { api.emit('back'); },
  };

  MP.native = api;
})(typeof window !== 'undefined' ? window : globalThis);
