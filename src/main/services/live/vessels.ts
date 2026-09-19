/**
 * Vessel feed — Axiom Overwatch AIS API (no key required).
 * Returns GeoJSON with vessel positions, filtered to moving vessels only.
 *
 * Endpoint: https://www.axiomoverwatch.io/api/v1/positions/latest
 * Used by OSINT-Global-OS.
 */

import type { LiveFeature } from '@shared/types'

const AXIOM_API = 'https://www.axiomoverwatch.io/api/v1/positions/latest'

interface AxiomFeature {
  type: string
  geometry: { type: string; coordinates: [number, number] }
  properties: {
    imo: string
    name: string
    vessel_type: string
    flag: string | null
    speed: number | null
    course: number | null
    draft: number | null
    destination: string | null
    nav_status: string | null
    timestamp: string
  }
}

interface AxiomResponse {
  type: string
  features: AxiomFeature[]
}

export async function getVesselFeatures(): Promise<LiveFeature[]> {
  try {
    const url = `${AXIOM_API}?west=-180&south=-90&east=180&north=90`
    const res = await fetch(url, {
      signal: AbortSignal.timeout(30000),
      headers: { Accept: 'application/json' },
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = (await res.json()) as AxiomResponse

    const features: LiveFeature[] = []
    const MAX_VESSELS = 2000

    for (const f of data.features) {
      if (features.length >= MAX_VESSELS) break
      const [lon, lat] = f.geometry.coordinates
      if (typeof lat !== 'number' || typeof lon !== 'number') continue

      const speed = f.properties.speed ?? 0
      const navStatus = (f.properties.nav_status ?? '').toLowerCase()
      // Skip stationary / in-port vessels
      const isStatic = speed < 0.1 || /moor|anchor|aground|not under command|constrained/.test(navStatus)
      if (isStatic) continue

      features.push({
        id: `vessel:${f.properties.imo}`,
        type: 'vessel',
        position: { lon, lat, height: 0 },
        velocity:
          f.properties.speed != null && f.properties.course != null
            ? { speed: f.properties.speed * 0.5144, heading: f.properties.course } // knots → m/s
            : undefined,
        meta: {
          mmsi: f.properties.imo,
          name: f.properties.name,
          speed: f.properties.speed,
          course: f.properties.course,
          status: f.properties.nav_status,
          shipType: f.properties.vessel_type,
          destination: f.properties.destination,
          color: '#39ffd5',
        },
        freshness: Date.now(),
      })
    }

    console.log(`[live/vessels] ${features.length} vessels (filtered from ${data.features.length}, stationary excluded)`)
    return features
  } catch (err) {
    console.warn('[live/vessels] poll failed:', err)
    return []
  }
}
