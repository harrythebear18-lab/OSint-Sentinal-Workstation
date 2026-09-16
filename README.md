# OSINT Sentinel Workstation

## At a glance

| | |
|---|---|
| **Platform** | Windows (x64 + arm64) — Electron 32, React 18, CesiumJS |
| **Plugins** | 41, in 11 domain groups — 41/41 pass the headless harness |
| **Compute** | WebGPU (7 WGSL kernels) → WASM SIMD (4 kernels) → worker pool (4 scripts) → CPU, auto-dispatched |
| **Imagery** | Sentinel-2 STAC/COG up to 2048² cells; Esri base to z18; GIBS NDVI canopy |
| **Terrain** | DEM hillshade, slope, anomaly, D8 + Priority-Flood hydrology — all worker/GPU-backed |
| **Live feeds** | Satellites, ADS-B, AIS, lightning, fires, quakes, volcanoes, storms, space weather |
| **Offline** | Bounded caches — 256 MB DEM + 1 GB imagery, LRU + 45-day expiry |
| **AI** | Local Ollama (Qwen-VL) + CLIP — nothing leaves the machine unless you allow it |
| **Ships as** | NSIS installer (x64+arm64, 231 MB) or portable x64 (117 MB) |

## Overview

> An offline-first, single-window geospatial intelligence cockpit.
> A hardware-accelerated Cesium globe at the center, with Sentinel-2 multispectral
> analysis, DEM terrain compute, live feeds, local AI, and mission-grade
> search-and-rescue tooling.

This is not a photorealistic viewer built on Google 3D Tiles.
It is a terrain and signals intelligence platform — a programmable Earth —
built on CesiumJS, live public feeds, real DEM analysis, and a Hardware
Abstraction Layer that dispatches work to WebGPU, WASM SIMD, WebCodecs,
and a `worker_threads` pool with automatic fallback.

![OSINT Sentinel Workstation — cockpit view: Cesium globe with live Argo buoy network, satellite orbital tracks, grouped plugin panel, and entity inspector](docs/screenshots/cockpit.png)

## What it is

- **Single-window cockpit** — one Cesium 3D globe, HUD overlays, left/right dock
  panels, floating draw tools, and a plugin manager. No multi-window sprawl.
- **3D Cesium globe** — Esri World Imagery base (zoom to level 18, ~0.6 m/px),
  terrain-aware, cinematic camera, clamped-to-ground overlays, optional animated
  sun/terminator lighting (gated behind the hillshade toggle for performance).
- **Sentinel-2 STAC/COG** — real S2 L2A band ingestion from Earth Search with
  NDVI/NDWI/NBR band math. Output grid selectable at 512 / 1024 (default) /
  2048 cells per side (~49 m/px effective at 2048 on a typical scene).
- **Terrain analysis** — DEM, slope bands, hillshade, anomaly detection
  (depressions/prominences), runoff flow paths (D8 + Priority-Flood + SCS Curve
  Number), flood risk (Kirpich time of concentration), watershed divides, rest
  points, fall risk.
- **Canopy / vegetation** — GIBS MODIS NDVI 8-day composite (WMS, CRS:84
  longitude-first), 7-class vegetation mapping (dense forest → barren → water),
  DEM roughness-based canopy height, convex-hull zone polygons.
- **Volcano monitoring** — NASA EONET + USGS + Smithsonian GVP feeds,
  ash/SO2 dispersion simulation.
- **Acoustic propagation** — ISO 9613-1 outdoor sound modeling on real terrain
  with live weather.
- **SAR / mission tooling** — search zones (LKP rings), remains corridor
  (fall → flow → find), hiker profile calibration, trip-parameter physiology,
  case profiles, road-aware A* + Tobler routing, GeoJSON/KML/KMZ export/import.
- **OSM vector overlays** — roads, water features (rivers, streams, lakes,
  springs), via Overpass with multi-server fallback and error surfacing.
- **Live feeds** — SGP4 satellites, ADS-B aircraft (rate-limited, 300 s backoff),
  AIS vessels, NASA FIRMS fires, USGS earthquakes, Blitzortung lightning
  (WebSocket, character-based LZW), NHC storms, NOAA space weather, grid assets,
  network status.
- **Weather** — RainViewer radar + satellite, Open-Meteo forecast, rainfall
  integration with hydrology (auto-fetch or manual override).
- **Local AI console** — Ollama (Qwen-VL) with tool use, CLIP (local FastAPI on
  :9776), web search, scene-aware workflows, analyst query engine over live data.
- **Analyst architecture** — query engine (filters, spatial scope, follow-ups),
  action runner (8 LLM-callable tools: fly_to, query_data, select_nearest,
  track_entity, etc.), context store, annotation resolver (Nominatim + Overpass
  footprints), detection overlay (screen-space brackets, 4 density modes,
  4 themes).
- **Offline-first** — bounded local caches; the app runs without a network for
  anything already cached. DEM tiles: 256 MB LRU cap. Imagery tiles: 1 GB LRU
  cap + 45-day expiry. Eviction runs at startup, daily, and per-write —
  caches cannot grow unbounded.
- **Privacy-first** — 4-stage security model (LOCK / AI / FULL / NET), local AI,
  no telemetry unless enabled. See `PRIVACY.md`.
- **License-gated Core Engine** — the cockpit is open source (VOC-L); the Core
  Engine (HAL, WebGPU, worker pool, prediction) is proprietary (VCE-L) with a
  14-day trial. See `LICENSING.md`.

## Tech stack

- **Shell:** Electron 32 (Chromium 128, Node 20)
- **Build:** electron-vite + Vite 5, electron-builder 26 (NSIS + portable)
- **UI:** React 18 + TypeScript
- **3D globe:** CesiumJS
- **GPU compute:** WebGPU — 7 WGSL compute kernels via the compute dispatcher
- **CPU parallelism:** `worker_threads` pool (4 worker scripts: slope, hillshade,
  anomaly blur, priority-flood) + SharedArrayBuffer
- **WASM SIMD:** 4 hand-written kernels compiled from WAT at build time
  (`band_math`, `slope`, `hillshade`, `box_blur`, 1505-byte module)
- **Hardware codecs:** WebCodecs — ImageDecoder (DEM/canopy PNG decode via
  main→renderer bridge), VideoEncoder (timelapse VP9/WebM), VideoDecoder
  (drone footage frame extraction)
- **Streaming I/O:** ReadableStream pipelines with backpressure (DEM, canopy,
  tile fetches)
- **SGP4 / orbital math:** `satellite.js`
- **KML/KMZ:** `@xmldom/xmldom` + `adm-zip`
- **COG/GeoTIFF:** `geotiff` + `proj4`
- **AI:** Ollama (Qwen-VL) + CLIP (local FastAPI, CUDA-backed)
- **Production hardening:** sourcemaps excluded from ASAR, Terser
  minification, main/preload obfuscation, `NODE_ENV` gating, signtool signing

## HAL — Hardware Abstraction Layer

The workstation probes real hardware capabilities at startup and dispatches
workloads to the fastest available backend, with graceful fallback
(WebGPU → WASM SIMD → worker pool → inline CPU). See `HAL.md` and `AUDIT.md`
for the full picture.

| Subsystem | What it touches | Status |
|-----------|----------------|--------|
| WebGPU compute | GPU cores — 7 WGSL kernels | **wired** (slope, hillshade, anomaly, band math) |
| Worker threads | OS threads + SharedArrayBuffer | **wired** — 4 worker scripts shipped in `out/main/workers`, verified inside packaged ASAR |
| Streaming I/O | ReadableStream backpressure | **wired** (DEM, canopy, tile cache) |
| WebCodecs | NVENC/QuickSync/VAAPI codecs | **wired** (PNG decode, timelapse VP9 encode, drone decode) |
| WASM SIMD | 128-bit CPU vector units | **active** — 4 kernels, built from WAT each build |
| CUDA native | NVIDIA GPU compute | deferred |
| OpenXR native | Meta Quest 3S PC Link | scaffold (unbuilt) |

HAL probe output on startup:

```
[hal] CPU: 16 cores, 32768/65536 MB free
[hal] Worker threads: yes, SAB: yes
[hal] Renderer: webgpu=true, webcodecs=true, wasmSimd=true
[hal/gpu-compute] WebGPU device: nvidia
[hal/gpu-compute] compiled 7 compute kernels
[hal/worker-pool] initialized: 8 workers, 4 task types
```

### Dispatch order

Every terrain/spectral compute call flows through `computeDispatcher`, which
logs the chosen backend per task:

```
[hal/dispatcher] hillshade → webgpu — 65536 cells in 12ms
[hal/dispatcher] slope → wasm-simd — 65536 cells in 8ms
[compute-fallback] hillshade → worker "dem-hillshade"
```

The hillshade plugin reports backend + duration in its panel, so you can see
exactly which hardware ran the job.

## Plugin architecture

All **41 plugins** follow a unified interface (`EarthEnginePlugin`):
`register / unregister / update / getStats / getControls / onControl`.

The plugin panel groups them into 11 domains:

| Group | Plugins |
|-------|---------|
| ⛰️ Terrain & DEM | slope-bands, hillshade, anomaly, hydrology, acoustic |
| 🛰️ Imagery & Spectral | sentinel-stac, band-math, canopy |
| 🗺️ Maps & Routing | water, roads, routes |
| 🧭 Mission & SAR | behavior, predictions, search-zones, rest-points, fall-risk, remains-corridor, case-profiles, hiker-profile |
| 📡 Live Feeds | weather, earthquakes, volcano, fires, aircraft, vessels, lightning |
| 🌊 Climate & Ocean | climate-stations, storms, space-weather |
| ⚡ Infrastructure | infrastructure, grid-assets, network |
| 🧠 AI & Vision | clip, vision, web-search, detection |
| 📹 Media & Export | timelapse, drone-footage, export-import |
| 🖥️ System | benchmark |
| 🥽 VR / OpenXR | vr |

Each plugin activates on the selection bbox or LKP pin, renders Cesium
entities, and exposes controls (toggles, sliders, buttons, displays) in the
panel. SGP4 satellites render as a separate overlay (`SatellitesOverlay`) since
they need continuous TLE propagation.

### Plugin harness

A headless regression harness (`src/renderer/globe/plugins/plugin-harness.ts`)
exercises every plugin's full lifecycle against a Cesium-shaped mock viewer
with stubbed fetch — no real rendering, no network. Run it from the renderer
DevTools console:

```js
await window.runPluginTests({ stepTimeoutMs: 30000, stepsBeforeYield: 2 })
// → { total: 41, passed: 41, failed: 0, results: [...] }
```

Current status: **41/41 PASS.**

## Hydrology model

The runoff/flood analysis uses proper hydrological methods:

- **D8 flow direction** with diagonal distance correction (√2 factor)
- **Priority-Flood** depression filling (Barnes 2014) — real spill-point detection
- **Topological sort** flow accumulation — O(n) instead of O(n²)
- **SCS Curve Number** runoff model — realistic infiltration
- **Strahler stream ordering** — tributaries vs main channels
- **Kirpich formula** for time of concentration → peak discharge
- **Watershed divides** as actual ridge polylines, not bounding boxes
- **Convex hull** pool polygons from depression clusters

## Licensing — Visentrix Three-Layer Model

See `LICENSING.md` for the full explanation and file-level classification.

| Layer | License | What's covered | Status |
|-------|---------|----------------|--------|
| 1 — Cockpit | VOC-L (open, MIT-like) | Electron shell, Cesium globe, plugin manager, UI, plugins, analyst, HUD, feeds, AI console | Open source |
| 2 — Core Engine | VCE-L (proprietary) | HAL, WebGPU kernels, worker pool, streaming I/O, prediction engine, native bridges | All rights reserved |
| 3 — Plugins | VPL (hybrid) | Community, commercial, private, mission plugins linking to Cockpit API | Open or commercial |

The Core Engine is gated by a machine-bound license system
(`src/main/services/license-manager.ts`) with a 14-day trial, encrypted
storage, and HMAC tamper detection. The Cockpit always works without a
license — the Core Engine does not.

## AI services

Local AI for scene analysis and data queries:

- **Ollama** — `http://localhost:11434` — LLM + vision (Qwen-VL, Qwen-Coder, Llama)
- **CLIP** — `http://localhost:9776` — embeddings via `scripts/clip_server.py`
  (FastAPI + open_clip, CUDA-backed). Requires a Python environment —
  if Python isn't installed, CLIP is skipped gracefully.

```bash
python scripts/clip_server.py   # start CLIP
node scripts/check-ai.js        # check AI service status
ollama serve && ollama pull qwen2.5vl:7b   # start Ollama
```

## Project structure

```
osint-sentinel-workstation/
├── src/
│   ├── main/                  # Electron main process
│   │   ├── index.ts           # single-window lifecycle, cache eviction wiring
│   │   ├── ipc-handlers.ts    # typed IPC router
│   │   └── services/
│   │       ├── hal/           # Hardware Abstraction Layer
│   │       │   ├── hal-manager.ts    # probes CPU/GPU/SAB
│   │       │   ├── worker-pool.ts    # worker_threads + SAB, task dispatch
│   │       │   ├── streaming-io.ts   # ReadableStream pipelines
│   │       │   └── workers/          # 4 CPU worker scripts (slope, hillshade,
│   │       │                         #   anomaly-blur, priority-flood)
│   │       ├── compute-fallback.ts   # compute:task → worker pool router
│   │       ├── dem-tiles.ts          # Terrarium DEM fetch + 256MB LRU cache
│   │       ├── tile-cache.ts         # imagery cache — 1GB LRU + 45d expiry
│   │       ├── stac-cog-service.ts   # Sentinel-2 STAC/COG (512–2048 cells)
│   │       ├── canopy-service.ts     # GIBS NDVI (CRS:84) + canopy height
│   │       ├── runoff-service.ts     # D8 + Priority-Flood + SCS hydrology
│   │       ├── license-manager.ts    # machine-bound VCE-L license
│   │       ├── system-verifier.ts    # on-demand health check
│   │       ├── prediction/           # prediction engine + wildfire spread
│   │       └── live/                 # aircraft, vessels, fires, quakes, ...
│   ├── preload/               # safe IPC bridge (window.api)
│   ├── shared/                # IPC channels + shared types
│   └── renderer/
│       └── globe/             # single 3D Cesium cockpit
│           ├── App.tsx        # cockpit shell + plugin manager
│           ├── Globe.tsx      # Cesium viewer + drawing manager + lighting gate
│           ├── hal/           # renderer-side HAL
│           │   ├── gpu-compute.ts      # WebGPU WGSL kernels
│           │   ├── compute-dispatcher.ts # WebGPU→WASM→worker→CPU routing
│           │   ├── webcodecs.ts        # hardware codecs
│           │   └── wasm/               # WAT source + compiled SIMD module
│           ├── analyst/       # analyst engine, action runner, context store,
│           │                  #   annotation resolver, detection overlay
│           └── plugins/       # 41 plugins + manager + harness + panel
├── scripts/
│   ├── clip_server.py         # CLIP FastAPI server
│   ├── check-ai.js            # AI status checker
│   ├── compile-wasm.mjs       # WAT → WASM build step
│   └── obfuscate-build.mjs    # main/preload obfuscation
├── native/openxr-bridge/      # future Quest 3S PC Link
└── electron.vite.config.ts    # build + copy-hal-workers plugin
```

## Quick start

Requires Node.js 20+.

```bash
git clone https://github.com/harrythebear18-lab/OGOS-GEV.git
cd OGOS-GEV
npm install
npm run dev        # copies Cesium assets, starts electron-vite + Electron
```

This opens the cockpit window with the globe, plugin panel, and draw tools.
Imagery/DEM tiles cache locally under
`%USERPROFILE%\.osint-sentinel-workstation\cache\` (bounded — see above).

## Build & package

```bash
npm run build          # compile WASM + Cesium + electron-vite → out/
npm run build:prod     # production build + main/preload obfuscation
npm run preview        # launch built app
npm run dist:win       # Windows NSIS installer (x64+arm64) + portable x64
npm run dist:portable  # portable x64 only
npm run dist:mac       # macOS DMG (x64+arm64)
```

`dist:win` output goes to `E:/osint-builds/release/` (configured in
`package.json` → `build.directories.output`):

```
OSINT Sentinel Workstation Setup 0.1.0.exe   NSIS installer, x64+arm64 (~231 MB)
OSINT Sentinel Workstation 0.1.0.exe         portable x64 (~117 MB)
win-unpacked/                                unpacked x64 app
win-arm64-unpacked/                          unpacked arm64 app
latest.yml                                   update metadata
```

The build pipeline: `compile:wasm` (WAT→WASM) → `copy:cesium` →
`electron-vite build` (main + preload + renderer; HAL workers copied to
`out/main/workers` by a Vite plugin) → `obfuscate` → `electron-builder`.
Workers inside the packaged ASAR are loaded via the pool's eval-worker +
`require()` path, verified working.

## Status

**v0.1.0 — production build**

- 41/41 plugins pass the headless harness (register → controls → update →
  control → unregister, zero network)
- HAL fully wired: WebGPU + WASM SIMD + worker pool + WebCodecs + streaming I/O
- Sentinel-2 STAC/COG at up to 2048² output cells; Esri base at z18
- Canopy GIBS WMS axis-order fixed (CRS:84) — real vegetation zones
- Bounded caches: DEM 256 MB, imagery 1 GB / 45 d, startup + daily + per-write
  eviction
- Plugin panel reorganized into 11 domain groups
- Globe lighting gated behind hillshade toggle (animated 12× sun cycle when on,
  zero per-render cost when off)
- Production packaging verified: installer + portable, workers functional
  inside ASAR, signed exes

Known limitations / roadmap:

- CUDA native addon — deferred (WebGPU covers current workloads)
- OpenXR bridge — scaffold only, needs Visual Studio C++ build
- Renderer bundle ~5 MB minified — code splitting planned
- Application icon — currently default Electron icon
- Optional: configurable cache location (e.g., off C:)

## Documentation

| File | Purpose |
|------|---------|
| `README.md` | This file — overview, stack, status |
| `HAL.md` | Hardware Abstraction Layer — architecture, subsystems, status |
| `AUDIT.md` | Front-to-back codebase audit — every claim verified |
| `LICENSING.md` | Visentrix three-layer licensing model |
| `PRIVACY.md` | GDPR privacy policy |
| `SECURITY.md` | Security policy + vulnerability reporting |
| `CONTRIBUTING.md` | Layer-aware contribution guide |
| `CODE_OF_CONDUCT.md` | Contributor Covenant 1.4 |
