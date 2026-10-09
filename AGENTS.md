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


## Trippin' (`trippin/`) — the second, separate app

A from-scratch rebuild of the road-trip cockpit that lives beside the original (`index.html` is untouched).
Static files only, no build step, no runtime dependencies. Serve the repo root and open `/trippin/index.html`.
There is **no built-in trip**: you plan any trip in the Trip tab (place search → real OSRM routes), or press START on Drive
for a **free drive** with no destination (the windshield shows a straight road along your GPS heading).

- **Idea:** the UI speaks the road's own visual language. Drive is a live *windshield* (road curvature/hills from the route,
  sun and moon at their true positions, weather, exit gantries), a dark dashboard cluster, a dot-matrix message board, a
  split-flap ETA, and a nav bar styled as a highway sign. Ahead is a strip map with the **Pit Window** (fuel · alertness ·
  daylight · weather on one clock) and **Future You** (drag to time-travel the trip). Car is a real ELM327/BLE OBD dashboard with
  a **Black Box** recorder and **Pace Lab**. Pilot has alerts, the **Sky Dial**, voice/text questions and roadside stories.
- **Same rule as the original:** real data only. No simulated telemetry in the shipped app. `trippin/tests/` holds test-only
  fixtures/emulators — never loaded by `index.html`. Anything unknown is shown as unknown ("unavailable", "—"), never guessed.
- **Layout (`trippin/js/`):** `core.js` (geo/route/sun/units/storage), `engine.js` (state machine: GPS, ETA, stops, alertness,
  fuel), `plan.js` (trip plan model), `intel.js` (all network clients, see below), `voice.js` (TTS, speech recognition, command
  parser, optional Gemini), `future.js`+`pit.js` (projection + Pit Window), `scene.js` (windshield), `map.js` (canvas map),
  `obd.js`+`dtc.js` (OBD), `logger.js` (Black Box + Pace Lab), screens: `drive.js` `ahead.js` `car.js` `pilot.js` `trip.js`,
  plus `hud.js` (dash-top display), `recap.js` (shareable poster), `diag.js` (error capture + "Share report"), `app.js` (boot).
- **Public services (all keyless, all with fallbacks and status tracking in `MP.intel.status`):** routing OSRM
  (router.project-osrm.org → routing.openstreetmap.de), search Nominatim → Photon → Open-Meteo geocoder, weather + elevation
  Open-Meteo (OpenTopoData fallback), fuel/rest stops Overpass (several mirrors), stories Wikipedia, warnings US NWS,
  tiles CARTO. The demo OSRM server sends no `toll` class, so toll roads are *inferred from road names* and labelled "likely".
  Trip → Health check runs a live test of every service on the device.
- **Tests (no dependencies):** `node trippin/tests/unit.js`, `node trippin/tests/obd.test.js`, `node trippin/tests/intel.test.js`
  (parsers against real captured fixtures in `tests/fixtures/`, retry/fallback behaviour with a fake `fetch`, voice commands,
  alert rules, recap). `node trippin/tests/live.js "Toledo, OH" "Pittsburgh, PA"` exercises the REAL services end to end
  (set `NODE_USE_ENV_PROXY=1` behind a proxy). Browser checks: Playwright + Chromium can drive the app with a phone viewport;
  move the simulated GPS with `context.setGeolocation` (test harness input only).
- **Android APK:** `android/` is a thin WebView shell (bundles `trippin/` as assets; native BLE for the OBD adapter because
  WebView has no Web Bluetooth; native TTS, speech recognition, share/save, keep-awake, Back-button handling). Build locally with
  `scripts/build-apk.sh` (needs JDK 17+, `ANDROID_HOME` with platform 34 + build-tools 34.0.0, Gradle 8.x → `Trippin-debug.apk`).
  `.github/workflows/build-trippin-apk.yml` runs the tests, builds on GitHub and publishes the rolling **"Trippin' (latest test
  build)"** pre-release (`trippin-latest`). It is debug-signed with the fixed public key `android/debug.keystore` (test builds
  only; new builds install over old ones). Cloud-container note: `dl.google.com` and the public APIs must be allowed in the
  environment's network settings to build/test here; Maven Central may answer 429 on the first Gradle run — just retry.
- **Not verified on hardware:** the native Bluetooth, speech and GPS bridges are compile-checked and exercised through the web
  paths, but have not been run on a phone with an OBD adapter yet.
