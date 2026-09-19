/**
 * Road Service — fetches roads, paths, and trails from OpenStreetMap via
 * Overpass API. Used by the route planner to give A* a road network cost
 * advantage, so routes follow roads/trails in urban and countryside areas
 * instead of taking terrain-optimal cross-country paths.
 *
 * Free, no key, no auth. Ported from OSINT-Global-OS.
 *
 * Road types fetched (with preference weights for route planning):
 *  - motorway/trunk/primary/secondary/tertiary  (0.15 — strong preference)
 *  - residential/unclassified/service            (0.25 — moderate preference)
 *  - road/construction                           (0.50 — mild preference)
 *  - path/footway/cycleway/track                 (0.20 — strong for hikers)
 *  - bridleway                                   (0.30 — moderate for hikers)
 *  - steps                                       (0.40 — mild, but passable)
 */

import type { LngLat, RoadSegment, RoadResponse } from '@shared/types'
import { featureCache } from './feature-cache'

export type { RoadSegment, RoadResponse }

const OVERPASS_URLS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.openstreetmap.ru/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
]

/** Overpass servers reject requests without a proper User-Agent (return 406). */
const USER_AGENT = 'OSINTSentinelWorkstation/0.1 (https://github.com/harrythebear18-lab/OSint-Sentinal-Workstation)'

/**
 * Map OSM highway types to cost multipliers.
 * Lower = cheaper to walk on = stronger preference.
 * 1.0 = no preference (same as off-road terrain).
 */
const HIGHWAY_COST: Record<string, number> = {
  motorway: 0.15,
  trunk: 0.15,
  primary: 0.15,
  secondary: 0.18,
  tertiary: 0.20,
  unclassified: 0.25,
  residential: 0.25,
  service: 0.30,
  road: 0.50,
  construction: 0.50,
  path: 0.20,
  footway: 0.20,
  cycleway: 0.20,
  track: 0.20,
  bridleway: 0.30,
  steps: 0.40,
  pedestrian: 0.25,
  living_street: 0.25,
  raceway: 1.0, // don't follow raceways
  busway: 1.0,
  corridor: 0.30,
}

/**
 * Query Overpass for roads, paths, and trails within a bounding box.
 * Tries multiple Overpass servers for reliability.
 */
export async function fetchRoads(bounds: [LngLat, LngLat]): Promise<RoadResponse> {
  const [sw, ne] = bounds
  const bboxNums: [number, number, number, number] = [sw.lng, sw.lat, ne.lng, ne.lat]

  // Check disk cache first
  const cached = await featureCache.get<RoadResponse>('roads', bboxNums)
  if (cached) {
    console.log('[roads] cache hit')
    return cached
  }

  const bbox = `${sw.lat},${sw.lng},${ne.lat},${ne.lng}`

  const query = `
    [out:json][timeout:30];
    (
      way["highway"](${bbox});
    );
    out geom 15000;
  `

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
        signal: AbortSignal.timeout(25000),
      })

      if (!res.ok) {
        lastError = new Error(`Overpass ${res.status}: ${res.statusText}`)
        continue
      }

      const text = await res.text()
      if (!text.startsWith('{')) {
        lastError = new Error(`Overpass ${url} returned non-JSON response`)
        continue
      }

      const data = JSON.parse(text)
      const segments: RoadSegment[] = []

      for (const el of data.elements || []) {
        if (el.type !== 'way' || !el.geometry) continue
        const highwayType = el.tags?.highway || 'road'
        const costMultiplier = HIGHWAY_COST[highwayType] ?? 1.0

        // Skip roads that shouldn't be followed (raceways, busways, etc.)
        if (costMultiplier >= 1.0) continue

        const coords: LngLat[] = el.geometry.map((g: { lon: number; lat: number }) => ({
          lng: g.lon,
          lat: g.lat,
        }))

        if (coords.length < 2) continue

        segments.push({
          id: `road-${el.id}`,
          highwayType,
          costMultiplier,
          coords,
          name: el.tags?.name,
        })
      }

      const result = { segments, bounds }
      // Write to disk cache (async, don't block)
      featureCache.set('roads', bboxNums, result).catch(() => {})
      return result
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e))
      continue
    }
  }

  throw lastError ?? new Error('All Overpass servers failed')
}

/**
 * Rasterize road segments onto a grid.
 * Returns a Float32Array (width * height) where each cell contains the
 * minimum cost multiplier from any road passing through it.
 * A value of 1.0 means no road (normal terrain cost).
 * A value < 1.0 means a road passes through (cheaper to walk).
 */
export function rasterizeRoads(
  segments: RoadSegment[],
  width: number,
  height: number,
  swLng: number,
  neLat: number,
  lngStep: number,
  latStep: number,
): Float32Array {
  const roadGrid = new Float32Array(width * height).fill(1.0)

  for (const seg of segments) {
    // For each consecutive pair of coordinates, mark all cells the line
    // passes through using a simple DDA (digital differential analyzer)
    for (let i = 0; i < seg.coords.length - 1; i++) {
      const c1 = seg.coords[i]
      const c2 = seg.coords[i + 1]

      // Convert lng/lat to grid cell coordinates
      const x1 = Math.floor((c1.lng - swLng) / lngStep)
      const y1 = Math.floor((neLat - c1.lat) / latStep)
      const x2 = Math.floor((c2.lng - swLng) / lngStep)
      const y2 = Math.floor((neLat - c2.lat) / latStep)

      // DDA line algorithm — mark all cells between (x1,y1) and (x2,y2)
      const dx = Math.abs(x2 - x1)
      const dy = Math.abs(y2 - y1)
      const steps = Math.max(dx, dy)
      if (steps === 0) {
        const idx = y1 * width + x1
        if (x1 >= 0 && x1 < width && y1 >= 0 && y1 < height) {
          if (seg.costMultiplier < roadGrid[idx]) {
            roadGrid[idx] = seg.costMultiplier
          }
        }
        continue
      }
      const xInc = (x2 - x1) / steps
      const yInc = (y2 - y1) / steps
      let x = x1
      let y = y1
      for (let s = 0; s <= steps; s++) {
        const xi = Math.round(x)
        const yi = Math.round(y)
        if (xi >= 0 && xi < width && yi >= 0 && yi < height) {
          const idx = yi * width + xi
          if (seg.costMultiplier < roadGrid[idx]) {
            roadGrid[idx] = seg.costMultiplier
          }
        }
        x += xInc
        y += yInc
      }
    }
  }

  // Expand road influence by 1 cell in each direction (dilate) so that
  // the A* can "find" the road even if the rasterization missed by one cell
  const dilated = new Float32Array(roadGrid)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x
      if (roadGrid[idx] < 1.0) {
        // Spread to neighbors with a slightly higher cost (so being
        // exactly on the road is still cheapest)
        const spreadCost = Math.min(1.0, roadGrid[idx] + 0.15)
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue
            const nx = x + dx
            const ny = y + dy
            if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue
            const nIdx = ny * width + nx
            if (spreadCost < dilated[nIdx]) {
              dilated[nIdx] = spreadCost
            }
          }
        }
      }
    }
  }

  return dilated
}
