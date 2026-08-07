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
