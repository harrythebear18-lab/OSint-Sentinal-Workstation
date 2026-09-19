# v0.1.2 Plan — "Runtime, Not Viewer"

## What Sentinel Workstation actually is (grounding)

Not a map with plugins — a cross-domain intelligence runtime. The real
inventory as of v0.1.0:

- **~75 IPC channels / ~89 handlers** — a service surface, not a UI surface
- **Terrain analysis layer** — dem:profile/raw/sample, slope, anomaly,
  runoff (D8 + Priority-Flood + SCS), canopy (NDVI + roughness height),
  rest-points, search-zones, behavior-engine, route-plan (A* + Tobler),
  road/water vector fetch
- **Human-factors SAR** — hiker:calibrate, trip:derive — physiology-driven
  mission modeling (speed decay, fatigue, caloric load)
- **Prediction suite** — 7 domain predictors: wildfire-spread, storm-track,
  radar-nowcast, severe-weather, climate-anomaly, sensor-failure,
  ocean-atmosphere coupler
- **Integrity engines** — climate and grid each run whitelist/snooze/alert/
  traffic channels with heuristic watchdogs, results verifiers, and
  cross-domain influence models (seismic + space-weather effects *on grid*)
- **Network posture** — bandwidth, DNS, fault detection, GeoIP, VPN
  detection, speedtest — a forensics module, not a status widget
- **AI agent** — session-based tool use with register/resolve/reject —
  human-in-the-loop approval over 8 scene tools
- **HAL** — WebGPU (7 WGSL kernels) → WASM SIMD → worker pool → inline
- **XR** — xr:pose/frame/controllers protocol channels already defined
- **41 plugins / 11 domain groups** — the visible surface of all the above

v0.1.2 does not add domains — it deepens the runtime and opens it up.

---

## Workstream 1 — GPU-First Compute Routing

Stop burning CPU on work the GPU does better. Today medium grids
(128²–512²) never touch WebGPU, and the worker path serializes grids as
`number[]` through IPC in both directions — pure CPU waste.

| File | Change |
|------|--------|
| `compute-dispatcher.ts` | Add `webgpu` to medium tier — a ~1 ms GPU dispatch beats `Array.from` + IPC + worker |
| `compute-dispatcher.ts` | Pass `Float32Array` over IPC directly (structured clone) — drop `Array.from` on request |
| `compute-fallback.ts` | Return `Float32Array` — drop `Array.from` on response; widen `ComputeResponse.output` |
| `worker-pool.ts` | Cap pool at `availableParallelism() - 2` — leave headroom for Cesium + main |

**Done when:** 256² hillshade logs `→ webgpu`; no sustained CPU saturation
during repeated bbox analysis; harness stays 41/41.

Later (v0.1.3+): GPU-resident pipelines (slope→hillshade→anomaly as one
on-device chain, no Float32Array round-trips); CUDA addon for flood sims.

---

## Workstream 2 — History & Research Module

A 12th domain group — 📜 **History & Research** — extending the mission
frame into the temporal axis: Stonehenge, medieval city fabric, WW1/WW2
wartime sites. Educational, grounded, inside the bbox.

**Rule of thumb: nothing modern, nothing classified.** All sources are
public heritage registers; post-1945 excluded by default (toggleable).

**Sources — same Overpass multi-server pattern as water/roads:**

| Source | Role |
|--------|------|
| Overpass `historic=*` | Spatial backbone: archaeological_site, castle, battlefield, fort, ruins, wreck, bunker, pillbox, city_gate, memorial |
| Wikidata SPARQL (bbox) | Era classification: inception dates, heritage designations, battle events |
| Wikipedia REST | Educational layer — real prose on click |
| v2: Historic England, Canmore, Coflein, Pleiades, CWGC | Official registers, ancient world, war graves |

**Era taxonomy** (start_date + site-type keywords):
Prehistoric (henges, barrows) → Roman → Medieval (castles, abbeys, ports)
→ Early modern/Industrial → **WW1/WW2** (pillboxes, airfields, coastal
batteries, wrecks) → post-1945 excluded.

**UX — plugs into existing systems, doesn't invent new ones:**

- Era-colored markers + the existing detection-overlay density modes
- Chronological panel — sites sorted by date
- Click → Wikipedia summary card via the existing inspector/WorldOverlay
- Results feed `export:geojson` — history layers are exportable day one
- Selection bbox + LKP semantics inherited — the plugin *is* the pattern

**Done when:** Wiltshire bbox → Stonehenge/Avebury classified prehistoric;
Thames estuary bbox → WW2 defenses; click → summary card.

**Status: IMPLEMENTED (v0.1.2).** `history-service.ts` (Overpass
`historic=*`, multi-server fallback, featureCache, era classification from
start_date + keywords — 17/17 classifier unit checks pass) + `history-plugin`
(era-colored markers/labels, era filter, post-1945 toggle, click → site card
+ Wikipedia REST summary, GeoJSON export). Wikidata carried via `wikidata`
QID tags; SPARQL bbox enrichment deferred to v2 with the official registers.

---

## Workstream 3 — Sentinel API (bidirectional bridge)

**The reframe:** the ~75 IPC channels already ARE the API. This workstream
externalizes that surface — versioned, documented, transport-agnostic —
rather than inventing a parallel one.

**Inbound (external software drives Sentinel):**

```
POST localhost:9777/rpc    { "method": "terrain:runoff:analysis", "params": {...} }
WS   localhost:9777/events → feed ticks, selection changes, results
```

Versioned namespaces mirroring the IPC surface — but curated, not 1:1:
`scene.*`, `terrain.*`, `plugins.*`, `compute.*` (HAL-as-a-service),
`feeds.*`, `data.*` (analyst engine), `mission.*` (search-zones, routes,
hiker), `export.*`. Internal channels (license, net:vpn) stay private.

**Outbound (Sentinel drives other apps) — the codec:**

```
Sentinel scene event → SceneCodec.encode() → neutral wire event
    → adapter (GEV / OGOS / generic WS / file-watch) → target renders
    ← target events → SceneCodec.decode() → Sentinel entities
```

One neutral event schema; per-target adapters. This is the "programmable
Earth" bridge — Sentinel scene state mirrored into another engine, or vice
versa. The AI agent's action-runner is the model: named ops + params.

**Security:** localhost-bound default, token auth optional, inherits the
4-stage privacy model (NET stage gates the API entirely).

**Done when:** curl flies the camera; a second process receives
`entity.added` over WS; `compute.dispatch` runs a hillshade for an
external caller and returns the backend tag.

---

## Workstream 4 — Ops-Room Sessions (multi-user)

The biggest piece — and the one where this system's shape matters most:
what syncs is not markers, it's a **shared mission scene**: selection bbox,
LKP pin, plugin outputs, annotations, camera follow.

**Model: host-authoritative.** The workstation's main process IS the
session server — consistent with everything else being local-first.

```
Host (main proc) — session server on :9778
  ├── clients: full Sentinel instances (LAN first)
  ├── events: state deltas via the §3 codec — same wire format
  └── later: relay for internet traversal
```

**What syncs, in order:**

| State | Model |
|-------|-------|
| Markers/annotations | per-entity ownership + last-writer-wins |
| Selection bbox / LKP | shared, role-gated |
| Camera | per-client opt-in "follow host/analyst" |
| Feed snapshots | host fans out at 1–4 Hz (not raw ticks) |
| Plugin results | host runs, broadcasts result refs (not raw grids — pointer to shared layer state) |

**Roles:** host / analyst (annotate, query, run plugins) / observer
(follow only). Room code join; host approval; session inherits host's
security stage — a LOCK-stage session shares nothing sensitive.

**Phases:**

- **4a LAN alpha** — full installs only; shared markers + follow-camera +
  presence. Proves the sync model.
- **4b analyst layer** — roles, per-user cursors, plugin run requests
  routed to host, annotation threads on shared entities.
- **4c relay** — optional internet relay; frames E2E encrypted with a key
  derived from the room code; relay sees ciphertext only.

**Design risks flagged now:**

- Plugin outputs are large Float32Array grids — sync the *layer reference*
  (task + bbox + params), let clients re-derive or fetch tiles from host.
  Never stream raw grids.
- Observer thin client: **deferred indefinitely** (locked) — it cannot
  represent prediction states, HAL routing, or integrity engines.
  All session participants run full installs.
- Feed fan-out volume: aircraft/vessels can be 500+ entities — snapshot
  deltas, not full states.

**Done when (4a):** two LAN instances share a session; marker placed on
one appears on the other <200 ms; follow-camera toggles work.

---

## Sequencing

| Milestone | Contents | Depends on |
|-----------|----------|-----------|
| M1 | GPU-first routing (§1) | — |
| M2 | History & Research (§2) | M1 |
| M3 | Sentinel API v1 — inbound + codec (§3) | M1 |
| M4 | Ops sessions LAN alpha (§4a) | M3 (reuses codec + WS plumbing) |
| M5+ | API adapters, roles/annotations, relay | M4 |

## Decisions (locked)

1. **`includePost1945` — toggleable, default OFF.** Keeps the domain
   academically clean.
2. **API — one port.** RPC + WS upgrade on the same port: simpler, avoids
   CORS hell.
3. **Sessions — full installs only for 4a.** A thin viewer cannot
   represent prediction states, HAL routing, plugin outputs, or the
   integrity engines. Thin viewer deferred indefinitely, not to 4c.
4. **Sessions — E2E encrypted even on LAN.** Room-code-derived key; LAN
   is not inherently safe and the cost is negligible.
5. **History → GeoJSON export on day one.** Aligns with existing export
   flows; free win.
6. **`mission.*` exposed in API v1.** Search-zones, hiker physiology,
   route-plan are Sentinel's most unique capabilities — they ARE the
   "programmable Earth" identity. The API inherits the privacy stage, so
   `mission.*` is gated automatically by the security model.
