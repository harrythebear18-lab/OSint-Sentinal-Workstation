/**
 * Water Service — fetches water bodies from OpenStreetMap via Overpass API.
 * Ported from OSINT-Global-OS. Free, no key, no auth.
 */

import type { LngLat, WaterFeature, WaterResponse } from '@shared/types'
import { featureCache } from './feature-cache'

export type { WaterFeature }

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
  members?: { ref: number; role: string; type: string; geometry: { lat: number; lon: number }[] }[]
}

export async function fetchWaterFeatures(bounds: [LngLat, LngLat]): Promise<WaterResponse> {
  const [sw, ne] = bounds
  const bboxNums: [number, number, number, number] = [sw.lng, sw.lat, ne.lng, ne.lat]

  // Check disk cache first
  const cached = await featureCache.get<WaterResponse>('water', bboxNums)
  if (cached) {
    console.log('[water] cache hit')
    return cached
  }

  const bbox = `${sw.lat},${sw.lng},${ne.lat},${ne.lng}`

  const query = `
    [out:json][timeout:30];
    (
      way["natural"="water"](${bbox});
      relation["natural"="water"](${bbox});
      way["waterway"](${bbox});
      node["natural"="spring"](${bbox});
      way["natural"="wetland"](${bbox});
    );
    out geom 10000;
  `

  let lastError: Error | null = null

  for (const url of OVERPASS_URLS) {
    try {
      console.log(`[water] trying ${url}...`)
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
        lastError = new Error(`Overpass ${url} returned ${res.status}`)
        console.warn(`[water] ${url} returned ${res.status}`)
        continue
      }

      const text = await res.text()
      // Some mirrors return HTML error pages instead of JSON
      if (!text.startsWith('{')) {
        lastError = new Error(`Overpass ${url} returned non-JSON response`)
        console.warn(`[water] ${url} returned non-JSON: ${text.slice(0, 100)}`)
        continue
      }

      const data = JSON.parse(text)
      const features = parseOverpassResponse(data)
      const result = { features, bounds }
      featureCache.set('water', bboxNums, result).catch(() => {})
      console.log(`[water] ${url} OK: ${features.length} features`)
      return result
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e))
      console.warn(`[water] ${url} failed: ${lastError.message}`)
      continue
    }
  }

  console.error('[water] All Overpass servers failed:', lastError?.message)
  return { features: [], bounds, error: lastError?.message ?? 'All Overpass servers failed' }
}

function parseOverpassResponse(data: { elements?: OverpassElement[] }): WaterFeature[] {
  const features: WaterFeature[] = []
  if (!data.elements) return features

  for (const el of data.elements) {
    if (el.type === 'node') {
      if (el.tags?.natural === 'spring') {
        features.push({
          id: `spring-${el.id}`,
          type: 'spring',
          coords: [{ lng: el.lon ?? 0, lat: el.lat ?? 0 }],
          name: el.tags?.name,
        })
      }
      continue
    }

    if (el.type === 'way' && el.geometry) {
      const coords: LngLat[] = el.geometry.map((g) => ({ lng: g.lon, lat: g.lat }))
      const tags = el.tags || {}
      let type: WaterFeature['type'] = 'stream'

      if (tags.waterway === 'river') type = 'river'
      else if (tags.waterway === 'stream') type = 'stream'
      else if (tags.waterway === 'canal') type = 'stream'
      else if (tags.natural === 'water') {
        type = tags.water === 'lake' ? 'lake' : tags.water === 'pond' ? 'pond' : tags.water === 'reservoir' ? 'reservoir' : 'lake'
      } else if (tags.natural === 'wetland') type = 'wetland'

      features.push({ id: `${el.type}-${el.id}`, type, coords, name: tags.name })
    }

    if (el.type === 'relation' && el.members) {
      for (const member of el.members) {
        if (member.role === 'outer' && member.geometry) {
          const coords: LngLat[] = member.geometry.map((g) => ({ lng: g.lon, lat: g.lat }))
          features.push({
            id: `rel-${el.id}-${member.ref}`,
            type: 'lake',
            coords,
            name: el.tags?.name,
          })
        }
      }
    }
  }

  return features
}

export function waterProximityScore(point: LngLat, features: WaterFeature[], maxDistanceM: number = 500): number {
  if (features.length === 0) return 0

  let minDist = Infinity
  for (const f of features) {
    if (f.type === 'wetland') continue
    for (const c of f.coords) {
      const dist = haversineMeters(point.lng, point.lat, c.lng, c.lat)
      minDist = Math.min(minDist, dist)
    }
  }

  if (minDist === Infinity) return 0
  if (minDist < 50) return 1.0
  if (minDist > maxDistanceM) return 0
  return 1.0 - (minDist / maxDistanceM) * 0.8
}

function haversineMeters(lng1: number, lat1: number, lng2: number, lat2: number): number {
  const R = 6371000
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLng = toRad(lng2 - lng1)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}
