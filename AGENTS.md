# Road Trip Companion

A single-file client-side Progressive Web App: a live road-trip companion and
Veepeak+ OBD-II diagnostic dashboard (Sterling Heights, MI → Sewell, NJ). The
entire app is `index.html` — HTML + inline Tailwind (CDN), Leaflet (CDN), and
vanilla JS. There is no backend, build step, package manager, or dependencies.

## Cursor Cloud specific instructions

### Run it
- No install/build. Serve the repo root statically and open `index.html`, e.g.
  `python3 -m http.server 8000` → http://localhost:8000/index.html
- `python3` is the only requirement (used purely as a static file server).
- There are no automated tests, linters, or build commands in this repo.

### Design rule: real data only, never simulated
- By explicit product decision there is **no mock/simulated telemetry**. All
  live vehicle data comes only from the real Veepeak BLE dongle (Web Bluetooth)
  and real device GPS. When nothing is connected the gauges stay idle and the
  status reads "Disconnected" — this is intended, not a bug.

### Hardware / capability gotchas (expected, not failures)
- **Web Bluetooth (OBD connect)** needs Chrome (Android or desktop) served over
  HTTPS or `localhost`. It is unavailable in Firefox/Safari and in many
  automated/headless browsers; the app shows an honest toast in that case.
- **GPS** only engages when a trip is active (the header GO button) and requires
  a real device plus a granted geolocation permission. Denied/absent GPS surfaces
  a `GeolocationPositionError` in the console — expected.
- **Gemini AI Co-Pilot** requires the user's own Google Gemini API key (prompted
  once, stored in `localStorage`); without a key it reports an honest error.

### Service worker cache gotcha (important when iterating)
- The app registers an inline service worker. A previously-registered SW on an
  origin can serve a **stale cached page**, so code edits may not appear on
  reload. If the served page looks outdated or throws `ReferenceError`s for
  functions that clearly exist in `index.html`, either unregister the SW and
  "Clear site data" via DevTools → Application, hard-reload (Ctrl+Shift+R), or
  simply serve on a fresh port (a new origin has no prior SW).
- Inline-blob SW registration is not supported in every context and logs a
  benign, caught `TypeError`; the app functions normally regardless.


## Milepost (`milepost/`) — the second, separate app

A from-scratch rebuild of the road-trip cockpit that lives beside the original (`index.html` is untouched).
Static files only, no build step, no runtime dependencies. Serve the repo root and open `/milepost/index.html`.

- **Idea:** the UI speaks the road's own visual language. Drive is a live *windshield* (road curvature/hills from the
  route, sun and moon at their true positions, weather, exit gantries), a dark dashboard cluster, a dot-matrix message
  board, a split-flap ETA, and a nav bar styled as a highway sign. Ahead is a strip map with the **Pit Window** (fuel ·
  alertness · daylight · weather on one clock) and **Future You** (drag to time-travel the whole trip). Car is a real
  ELM327/BLE OBD dashboard with a **Black Box** pre-trigger recorder and **Pace Lab** (this car's own speed-vs-economy curve).
- **Same rule as the original:** real data only. No simulated telemetry in the shipped app. `milepost/tests/` holds
  test-only fixtures/emulators (ELM327 emulator, a curvy fixture route) — never loaded by `index.html`.
- **Layout:** `js/core.js` (geo/route/sun/units), `engine.js` (state machine: GPS, ETA, stops, alertness, fuel),
  `future.js`+`pit.js` (projection + Pit Window), `scene.js` (windshield renderer), `map.js` (canvas map),
  `obd.js`+`dtc.js` (OBD), `logger.js` (Black Box + Pace Lab), `drive.js`/`ahead.js`/`car.js`/`trip.js` (screens).
- **Tests:** `node milepost/tests/unit.js` and `node milepost/tests/obd.test.js` (no dependencies).
- **Not built yet:** Pilot tab (alerts feed, Sky Dial, voice, Roadside Stories), full Trip planner (search/OSRM/Open-Meteo/
  Overpass clients), recap poster. `js/intel.js` currently holds only the elevation/weather accessors.
- **Android APK:** `android/` is a thin WebView shell (bundles `milepost/` as assets; native BLE bridge for the OBD adapter
  because WebView has no Web Bluetooth). `.github/workflows/build-milepost-apk.yml` builds it on GitHub and publishes the
  "Milepost (latest test build)" pre-release. It is debug-signed with the fixed public key `android/debug.keystore`
  (test builds only). The build could not be run in the Cursor Cloud container (no Android SDK / dl.google.com blocked).
