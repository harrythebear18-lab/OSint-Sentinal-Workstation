/**
 * Infrastructure Service — fetches airports, power plants, substations,
 * generators, transformers, monitoring stations, lighthouses, and
 * navigation buoys from OpenStreetMap via the Overpass API.
 *
 * Free, no key, no auth. Uses the same multi-mirror fallback pattern as
 * road-service.ts and water-service.ts. Bbox-scoped so it scales to any
 * viewport size without pulling the whole planet.
 *
 * Sensor / infrastructure classes fetched:
 *  - aeroway=aerodrome / helipad                 → airports, helipads
 *  - power=plant                                 → power stations (with fuel)
 *  - power=substation                            → electrical substations
 *  - power=generator                             → individual generators
 *  - power=transformer                           → transformers
 *  - power=tower / pole                          → transmission towers
 *  - man_made=monitoring_station                 → static monitoring stations
 *  - man_made=lighthouse                         → lighthouses
 *  - seamark:type=*buoy*                         → navigation buoys
 *  - man_made=weather_station                    → weather stations
 *
 * The renderer is responsible for centroid extraction from polygon outlines
 * and viewport culling. This service returns the raw OSM geometry so the
 * inspector can show footprints where available.
 */

import type { LngLat, InfrastructureFeature, InfrastructureResponse, InfrastructureType } from '@shared/types'
import { featureCache } from './feature-cache'

export type { InfrastructureFeature, InfrastructureResponse }

const OVERPASS_URLS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.openstreetmap.ru/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
]

/** Overpass servers reject requests without a proper User-Agent (return 406). */
const USER_AGENT = 'OSINTSentinelWorkstation/0.1 (https://github.com/harrythebear18-lab/OSint-Sentinal-Workstation)'

interface OverpassElement {
  type: 'node' | 'way' | 'relation'
  id: number
  lat?: number
  lon?: number
  tags?: Record<string, string>
  geometry?: { lat: number; lon: number }[]
  members?: { ref: number; role: string; type: string; geometry?: { lat: number; lon: number }[] }[]
}

/** Map an OSM element to an InfrastructureType, or null if not infrastructure. */
function classify(tags: Record<string, string>): { type: InfrastructureType; osmType: string; subtype?: string } | null {
  if (tags['aeroway'] === 'aerodrome') return { type: 'airport', osmType: 'aerodrome', subtype: tags['aerodrome:type'] }
  if (tags['aeroway'] === 'helipad') return { type: 'helipad', osmType: 'helipad' }
  if (tags['power'] === 'plant') return { type: 'power_plant', osmType: 'plant', subtype: tags['plant:source'] }
  if (tags['power'] === 'substation') return { type: 'substation', osmType: 'substation', subtype: tags['substation'] }
  if (tags['power'] === 'generator') return { type: 'generator', osmType: 'generator', subtype: tags['generator:source'] }
  if (tags['power'] === 'transformer') return { type: 'transformer', osmType: 'transformer' }
  if (tags['power'] === 'tower' || tags['power'] === 'pole') return { type: 'tower', osmType: tags['power'] }
  if (tags['man_made'] === 'monitoring_station') return { type: 'monitoring_station', osmType: 'monitoring_station', subtype: tags['monitoring:weather'] ? 'weather' : tags['monitoring:water_level'] ? 'water_level' : undefined }
  if (tags['man_made'] === 'lighthouse') return { type: 'lighthouse', osmType: 'lighthouse' }
  if (tags['man_made'] === 'weather_station') return { type: 'weather_station', osmType: 'weather_station' }
  // Navigation buoys — seamark:type contains "buoy" (e.g. lateral_buoy, safe_water_buoy)
  const seamark = tags['seamark:type'] ?? ''
  if (seamark.includes('buoy')) return { type: 'navigation_buoy', osmType: seamark }
  return null
}

/** Parse a numeric tag like "400" or "400 MW" into a number, or undefined. */
function parseNumber(val: string | undefined): number | undefined {
  if (!val) return undefined
  const m = val.match(/-?\d+(\.\d+)?/)
  if (!m) return undefined
  const n = parseFloat(m[0])
  return Number.isFinite(n) ? n : undefined
}

/** Extract the first coordinate from a way/relation geometry (used for node-less elements). */
function geometryToCoords(geom: { lat: number; lon: number }[] | undefined): LngLat[] {
  if (!geom || geom.length === 0) return []
  return geom.map((g) => ({ lng: g.lon, lat: g.lat }))
}

/** Convert an Overpass element to an InfrastructureFeature, or null if it has no usable geometry. */
function toFeature(el: OverpassElement): InfrastructureFeature | null {
  const tags = el.tags ?? {}
  const cls = classify(tags)
  if (!cls) return null

  let coords: LngLat[] = []
  if (el.type === 'node' && el.lat != null && el.lon != null) {
    coords = [{ lng: el.lon, lat: el.lat }]
  } else if (el.type === 'way' && el.geometry) {
    coords = geometryToCoords(el.geometry)
  } else if (el.type === 'relation' && el.members) {
    // Take the outermost member geometry as the footprint
    for (const m of el.members) {
      if (m.role === 'outer' && m.geometry && m.geometry.length > 0) {
        coords = geometryToCoords(m.geometry)
        break
      }
    }
    // Fall back to any member with geometry
    if (coords.length === 0) {
      for (const m of el.members) {
        if (m.geometry && m.geometry.length > 0) {
          coords = geometryToCoords(m.geometry)
          break
        }
      }
    }
  }

  if (coords.length === 0) return null

  // Parse voltage — may be a single value or a list like "380;220;110"
  const voltageRaw = tags['voltage'] ?? tags['substation:voltage']
  let voltageKv: number | undefined
  if (voltageRaw) {
    const parts = voltageRaw.split(';').map((p) => parseNumber(p.trim())).filter((n): n is number => n != null)
    if (parts.length > 0) voltageKv = Math.max(...parts)
  }

  return {
    id: `infra:${el.type}:${el.id}`,
    type: cls.type,
    osmType: cls.osmType,
    subtype: cls.subtype,
    icao: tags['icao'] || undefined,
    iata: tags['iata'] || undefined,
    outputMw: parseNumber(tags['plant:output:electricity'] ?? tags['generator:output:electricity']),
    voltageKv,
    fuel: tags['plant:source'] ?? tags['generator:source'] ?? undefined,
    operator: tags['operator'] || undefined,
    coords,
    name: tags['name'] || undefined,
  }
}

/**
 * Query Overpass for infrastructure within a bounding box.
 * Tries multiple Overpass servers for reliability.
 *
 * Note: the query is split into two passes (airports + power, then sensors)
 * to keep individual request sizes manageable and avoid Overpass timeouts
 * on large bboxes. Both passes are merged before returning.
 */
export async function fetchInfrastructure(bounds: [LngLat, LngLat]): Promise<InfrastructureResponse> {
  const [sw, ne] = bounds
  const bboxNums: [number, number, number, number] = [sw.lng, sw.lat, ne.lng, ne.lat]

  // Check disk cache first
  const cached = await featureCache.get<InfrastructureResponse>('infra', bboxNums)
  if (cached) {
    console.log('[infra] cache hit')
    return cached
  }

  const bbox = `${sw.lat},${sw.lng},${ne.lat},${ne.lng}`

  // Pass 1 — airports + power infrastructure
  const query1 = `
    [out:json][timeout:40];
    (
      way["aeroway"~"aerodrome|helipad"](${bbox});
      relation["aeroway"~"aerodrome|helipad"](${bbox});
      node["aeroway"="helipad"](${bbox});
      way["power"~"plant|substation|generator|transformer"](${bbox});
      relation["power"~"plant|substation|generator|transformer"](${bbox});
      node["power"~"generator|transformer"](${bbox});
      way["power"~"tower|pole"](${bbox});
    );
    out geom 10000;
  `

  // Pass 2 — monitoring / navigation / weather sensors
  const query2 = `
    [out:json][timeout:40];
    (
      node["man_made"="monitoring_station"](${bbox});
      way["man_made"="monitoring_station"](${bbox});
      node["man_made"="lighthouse"](${bbox});
      node["man_made"="weather_station"](${bbox});
      node["seamark:type"~"buoy"](${bbox});
    );
    out geom 5000;
  `

  const [res1, res2] = await Promise.allSettled([
    runOverpass(query1, bbox),
    runOverpass(query2, bbox),
  ])

  const features: InfrastructureFeature[] = []
  const errors: string[] = []
  const seenIds = new Set<string>()

  for (const r of [res1, res2]) {
    if (r.status === 'fulfilled') {
      for (const f of r.value) {
        if (seenIds.has(f.id)) continue
        seenIds.add(f.id)
        features.push(f)
      }
    } else {
      errors.push(String(r.reason))
    }
  }

  if (features.length === 0 && errors.length > 0) {
    return { features, bounds, error: errors.join('; ') }
  }
  const result = { features, bounds }
  featureCache.set('infra', bboxNums, result).catch(() => {})
  return result
}

/** Run a single Overpass query against the mirror list, returning parsed features. */
async function runOverpass(query: string, _bbox: string): Promise<InfrastructureFeature[]> {
  let lastError: Error | null = null

  for (const url of OVERPASS_URLS) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': USER_AGENT,
        },
        body: 'data=' + encodeURIComponent(query),
        signal: AbortSignal.timeout(35000),
      })

      if (!res.ok) {
        lastError = new Error(`Overpass ${url} returned ${res.status}`)
        continue
      }

      const text = await res.text()
      if (!text.startsWith('{')) {
        lastError = new Error(`Overpass ${url} returned non-JSON response`)
        continue
      }

      const data = JSON.parse(text) as { elements?: OverpassElement[] }
      const features: InfrastructureFeature[] = []
      for (const el of data.elements ?? []) {
        const f = toFeature(el)
        if (f) features.push(f)
      }
      return features
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e))
      continue
    }
  }

  throw lastError ?? new Error('All Overpass servers failed')
}
