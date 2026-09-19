/**
 * Aircraft feed — OpenSky Network public API.
 * Returns all current aircraft states (ICAO24, callsign, position, velocity).
 * No API key required for anonymous access (rate-limited to ~100 req / 10 min).
 *
 * Endpoint: https://opensky-network.org/api/states/all
 * With optional bbox: ?lamin=&lomin=&lamax=&lomax=
 *
 * Implements 429 backoff: when rate-limited, skips polls for a cooldown period.
 */

import type { LiveFeature } from '@shared/types'
import { enrichAircraftBatch } from './aircraft-metadata'

interface OpenSkyResponse {
  time: number
  states: any[][] | null
}

const OPENSKY_URL = 'https://opensky-network.org/api/states/all'
const MAX_AIRCRAFT = 1500

/**
 * adsb.lol readsb-style API — free, no key. Point+radius only (max ~250nm),
 * so cover major airspace with a probe grid. Response: { ac: [{hex, flight,
 * lat, lon, alt_baro(ft), gs(kts), track}] }.
 */
// Interleaved by region — each 3-probe poll spans continents from the start
const ADSB_LOL_PROBES: [number, number][] = [
  [47, -100],   // C North America
  [52, 10],     // C Europe
  [35, 115],    // E China
  [35, -95],    // S CONUS
  [48, -5],     // W Europe / Atlantic lanes
  [20, 78],     // India
  [45, -70],    // NE corridor
  [25, 50],     // Gulf
  [15, 100],    // SE Asia
  [-15, -55],   // Brazil
  [35, 139],    // Japan
  [-30, 145],   // SE Australia
  [5, 20],      // Central Africa
]

interface AdsbLolResponse {
  ac?: {
    hex?: string
    flight?: string
    lat?: number
    lon?: number
    alt_baro?: number | string
    gs?: number
    track?: number
  }[]
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * adsb.lol enforces a ~3-request burst limit, and live-data replaces the
 * aircraft set each poll — so probe a rotating 3-region window per poll and
 * accumulate into a persistent store with staleness expiry. Coverage builds
 * over ~4-5 polls and stays stable instead of flickering region to region.
 */
const ADSB_TTL_MS = 8 * 60 * 1000
const PROBES_PER_POLL = 3
const adsbStore = new Map<string, { feature: LiveFeature; seen: number }>()
let probeOffset = 0

async function getAdsbLolFeatures(): Promise<LiveFeature[]> {
  const now = Date.now()

  for (let i = 0; i < PROBES_PER_POLL; i++) {
    const [lat, lon] = ADSB_LOL_PROBES[(probeOffset + i) % ADSB_LOL_PROBES.length]
    if (i > 0) await sleep(1500)
    try {
      const res = await fetch(`https://api.adsb.lol/v2/lat/${lat}/lon/${lon}/dist/250`, {
        // adsb.lol rejects non-browser user agents with a plain-text error page
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36' },
        signal: AbortSignal.timeout(12000),
      })
      if (res.status === 429) break // burst window spent — remaining probes would also fail
      if (!res.ok) continue
      const text = await res.text()
      if (!text.startsWith('{')) continue // rate-limit HTML/error page
      const data = JSON.parse(text) as AdsbLolResponse
      for (const a of data.ac ?? []) {
        if (a.lat == null || a.lon == null || !a.hex) continue
        const altFt = typeof a.alt_baro === 'number' ? a.alt_baro : null
        adsbStore.set(a.hex, {
          seen: now,
          feature: {
            id: `aircraft:${a.hex}`,
            type: 'aircraft',
            position: { lon: a.lon, lat: a.lat, height: altFt != null ? altFt * 0.3048 : 0 },
            velocity:
              a.gs != null && a.gs > 0
                ? { speed: a.gs * 0.5144, heading: a.track ?? 0 }
                : undefined,
            meta: {
              callsign: a.flight?.trim() || a.hex,
              icao24: a.hex,
              altitude: altFt != null ? altFt * 0.3048 : null,
              color: '#4aff8a',
            },
            freshness: now,
          },
        })
      }
    } catch {
      continue
    }
  }
  probeOffset = (probeOffset + PROBES_PER_POLL) % ADSB_LOL_PROBES.length

  // Expire aircraft not re-seen within the TTL window
  for (const [hex, e] of adsbStore) {
    if (now - e.seen > ADSB_TTL_MS) adsbStore.delete(hex)
  }

  return [...adsbStore.values()].map((e) => e.feature)
}

// Backoff state — when we get 429, skip polls until this timestamp
let rateLimitedUntil = 0

export async function getAircraftFeatures(): Promise<LiveFeature[]> {
  // If we're in a rate-limit cooldown, skip OpenSky this poll — adsb.lol below.
  if (rateLimitedUntil > Date.now()) {
    const waitSec = Math.ceil((rateLimitedUntil - Date.now()) / 1000)
    console.log(`[live/aircraft] OpenSky rate-limited (${waitSec}s) — using adsb.lol`)
    const fallback = await getAdsbLolFeatures()
    return enrichAircraftBatch(fallback)
  }

  try {
    const res = await fetch(OPENSKY_URL, { signal: AbortSignal.timeout(15000) })

    if (res.status === 429) {
      // Rate limited — back off for 5 minutes
      rateLimitedUntil = Date.now() + 5 * 60 * 1000
      const retryAfter = res.headers.get('retry-after')
      if (retryAfter) {
        const secs = parseInt(retryAfter, 10)
        if (!isNaN(secs)) rateLimitedUntil = Date.now() + secs * 1000
      }
      console.warn(`[live/aircraft] HTTP 429 — backing off for ${Math.ceil((rateLimitedUntil - Date.now()) / 1000)}s, using adsb.lol`)
      const fallback = await getAdsbLolFeatures()
      return enrichAircraftBatch(fallback)
    }

    if (!res.ok) throw new Error(`HTTP ${res.status}`)

    const data = (await res.json()) as OpenSkyResponse
    if (!data.states) {
      // OpenSky anonymous tier often returns null states — treat as failure.
      const fallback = await getAdsbLolFeatures()
      console.log(`[live/aircraft] OpenSky empty → ${fallback.length} via adsb.lol`)
      return enrichAircraftBatch(fallback)
    }

    const features: LiveFeature[] = []
    for (const s of data.states) {
      if (features.length >= MAX_AIRCRAFT) break
      // OpenSky states array indices:
      // 0: icao24, 1: callsign, 5: lon, 6: lat, 7: baro_alt (m),
      // 9: velocity (m/s), 10: heading (deg)
      const icao24 = s[0] as string
      const callsign = (s[1] as string)?.trim() || icao24
      const lon = s[5] as number
      const lat = s[6] as number
      const alt = s[7] as number | null
      const velocity = s[9] as number | null
      const heading = s[10] as number | null

      if (lon == null || lat == null) continue

      features.push({
        id: `aircraft:${icao24}`,
        type: 'aircraft',
        position: { lon, lat, height: alt ?? 0 },
        velocity: velocity != null ? { speed: velocity, heading: heading ?? 0 } : undefined,
        meta: {
          callsign,
          icao24,
          altitude: alt,
          color: '#4aff8a',
        },
        freshness: Date.now(),
      })
    }
    // OpenSky anonymous is starved — a tiny result means the feed is degraded;
    // top it up from the adsb.lol probe grid (deduped by icao24).
    if (features.length < 50) {
      const openskyCount = features.length
      const extra = await getAdsbLolFeatures()
      const have = new Set(features.map((f) => f.id))
      for (const f of extra) if (!have.has(f.id)) features.push(f)
      console.log(`[live/aircraft] opensky degraded (${openskyCount}) → merged adsb.lol → ${features.length} total`)
    } else {
      console.log(`[live/aircraft] ${features.length} aircraft tracked (opensky)`)
    }
    return enrichAircraftBatch(features)
  } catch (err) {
    console.warn('[live/aircraft] OpenSky poll failed, trying adsb.lol:', err)
    const fallback = await getAdsbLolFeatures()
    console.log(`[live/aircraft] ${fallback.length} aircraft tracked (adsb.lol)`)
    return enrichAircraftBatch(fallback)
  }
}
