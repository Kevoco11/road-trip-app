# Trippin' windshield — what it takes to sell it to vehicle manufacturers

The 3D windshield (`path.js` → `world.js` → `terrain.js` → `glscene.js`) is the part with product value: it turns a route plus
map data into a smooth, real-data 3D view of the road ahead, lane-accurate where the data says so, at 60 fps on a phone GPU.
Everything else in the app is a demo cockpit around it. This file lists what stands between today's build and a licensable component.
It is a checklist, not a legal opinion: **every licence below must be re-read against its current terms before anything ships.**

## 1. Data: the biggest blocker

Today the app runs on free public services. They are fine for a personal test build and **not** for a product with customers.

| Need | Today | Why it cannot ship to an OEM | Replace with |
|---|---|---|---|
| Routing | OSRM public demo server | demo server, no SLA, usage policy forbids production load | self-hosted OSRM / Valhalla, or HERE / TomTom / Mapbox routing |
| Search | Nominatim → Photon → Open-Meteo geocoder | public instances: ~1 request/s, no bulk or commercial load | self-hosted Pelias/Photon, or a commercial geocoder |
| Street furniture, lanes | Overpass public servers | fair-use only, often 504-busy | self-hosted Overpass, or extract once into your own tile set |
| Scenery tiles | OpenFreeMap (OpenStreetMap) | free community service, no SLA | self-hosted OpenMapTiles/Planetiler build, or MapTiler/Mapbox/HERE |
| Buildings, land cover, trees | Overture Maps (S3 PMTiles) | open data (ODbL / CC-BY-4.0 parts), but you must carry attribution and honour share-alike for derived databases | download releases, build your own tiles, ship attribution |
| Basemap (2D map) | Esri World Gray Canvas tiles | keyless access is not a licence for a commercial product | licensed basemap or your own style |
| Weather | Open-Meteo | free tier is for non-commercial use | their commercial plan, or NWS/ECMWF/Meteomatics |
| Traffic | optional TomTom key | a key per developer account | OEM-level agreement |

Open-data attribution (OpenStreetMap contributors, Overture Maps Foundation, ESA WorldCover) is required in the product UI.

**Data gaps that no free source fills** (found while testing on real drives):
- **Street trees in suburbs.** Overture/OSM map individual trees sparsely (a Sterling Heights tile: ~400 in 4.9 km), and the satellite land cover calls
  most neighbourhoods "built-up". The windshield shows trees only where data says there are trees, so tree-lined streets look bare.
  Fix: a canopy dataset at ≤2 m (aerial-imagery derived), or LiDAR/canopy-height tiles per region.
- **Building height and roof shape** are measured in only some places; elsewhere height comes from floors or building class.
- **Signal state** (red/amber/green) is not public data; heads are drawn dark. Real state needs V2X/SPaT or a city feed.

## 2. Platform

- The app is HTML/JS in an Android WebView. Production head units run Android Automotive OS (WebView exists, but OEMs often ban it for safety-relevant UI),
  QNX, Linux/Yocto, or proprietary stacks. The rendering core is pure functions + one WebGL2 shader, so it ports; plan for a native renderer
  (C++/Vulkan/Metal) behind the same mesh builders, or an embedded web runtime the OEM approves.
- Performance budget to agree with each OEM: target SoC, frame rate (60 fps), memory, cold-start time, offline behaviour. The quality governor
  (`glscene.js`) already sheds detail under load; it needs per-SoC calibration.
- Offline-first: regional tile packs on the head unit, delta updates, and a defined fallback when data is missing (today: ground + road).

## 3. Safety and HMI

- Driver-distraction rules apply to anything shown while moving: NHTSA visual-manual guidelines (glances ≤ 2 s, ≤ 12 s total task time),
  ISO 15005 / 15008 (legibility), UNECE R10/R21 where relevant, plus each OEM's own HMI spec and night/day, glare and colour-blind requirements.
- Regional rules: markings, signs and driving side are US (MUTCD) today. Europe, Japan, left-hand traffic need their own styles.
- The windshield must never present guessed facts as true. That rule is already enforced in code and tests; keep it. Add a documented
  confidence/“unknown” state for each data layer so the OEM's safety case can rely on it.

## 4. Engineering to do next

1. A **data adapter layer**: one interface per source (route, tiles, buildings, land cover, street nodes, weather), so swapping to a licensed feed is configuration, not a rewrite.
2. **Golden-image regression**: `tests/live-lab.html` renders any real route; fix a set of routes/times/weather and diff screenshots in CI.
3. A **drive-log replay** harness (record real GPS + route, replay on a bench) so OEM engineers can reproduce what a tester saw.
4. Structured telemetry (frame time, tile latency, data coverage per mile) behind a consent switch.
5. A **style system**: colours, car model, sign style, units, driving side as data, so each OEM can brand it without touching the renderer.
6. Security review (no keys in the bundle, signed updates, no third-party calls without a data-processing agreement).
