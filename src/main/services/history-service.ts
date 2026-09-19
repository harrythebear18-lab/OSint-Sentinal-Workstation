/**
 * History Service — fetches historic sites from OpenStreetMap via Overpass API
 * (historic=* tag), classifies them into era buckets, and carries Wikipedia /
 * Wikidata linkage through to the renderer for on-demand enrichment.
 * Free, no key, no auth.
 */

import type { HistoricEra, HistoricSite, HistoryResponse, LngLat } from '@shared/types'
import { featureCache } from './feature-cache'

export type { HistoricSite }

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

export interface HistoryFetchOpts {
  includePost1945?: boolean
}

export async function fetchHistoricSites(
  bounds: [LngLat, LngLat],
  opts: HistoryFetchOpts = {},
): Promise<HistoryResponse> {
  const [sw, ne] = bounds
  const bboxNums: [number, number, number, number] = [sw.lng, sw.lat, ne.lng, ne.lat]

  // Cache holds the unfiltered set; post-1945 filtering is applied per-request.
  const cached = await featureCache.get<HistoryResponse>('history', bboxNums)
  if (cached) {
    console.log('[history] cache hit')
    return filterSites(cached, opts)
  }

  const bbox = `${sw.lat},${sw.lng},${ne.lat},${ne.lng}`

  const query = `
    [out:json][timeout:45];
    (
      node["historic"](${bbox});
      way["historic"](${bbox});
      relation["historic"](${bbox});
    );
    out geom 5000;
  `

  let lastError: Error | null = null

  for (const url of OVERPASS_URLS) {
    try {
      console.log(`[history] trying ${url}...`)
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': USER_AGENT,
        },
        body: 'data=' + encodeURIComponent(query),
        signal: AbortSignal.timeout(40000),
      })

      if (!res.ok) {
        lastError = new Error(`Overpass ${url} returned ${res.status}`)
        console.warn(`[history] ${url} returned ${res.status}`)
        continue
      }

      const text = await res.text()
      // Some mirrors return HTML error pages instead of JSON
      if (!text.startsWith('{')) {
        lastError = new Error(`Overpass ${url} returned non-JSON response`)
        console.warn(`[history] ${url} returned non-JSON: ${text.slice(0, 100)}`)
        continue
      }

      const data = JSON.parse(text)
      const sites = parseOverpassResponse(data)
      const result = { sites, bounds }
      featureCache.set('history', bboxNums, result).catch(() => {})
      console.log(`[history] ${url} OK: ${sites.length} sites`)
      return filterSites(result, opts)
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e))
      console.warn(`[history] ${url} failed: ${lastError.message}`)
      continue
    }
  }

  console.error('[history] All Overpass servers failed:', lastError?.message)
  return { sites: [], bounds, error: lastError?.message ?? 'All Overpass servers failed' }
}

function filterSites(resp: HistoryResponse, opts: HistoryFetchOpts): HistoryResponse {
  if (opts.includePost1945) return resp
  return { ...resp, sites: resp.sites.filter((s) => s.era !== 'modern') }
}

function parseOverpassResponse(data: { elements?: OverpassElement[] }): HistoricSite[] {
  const sites: HistoricSite[] = []
  if (!data.elements) return sites

  for (const el of data.elements) {
    const tags = el.tags ?? {}
    if (!tags.historic) continue

    let lng: number | undefined
    let lat: number | undefined
    let coords: LngLat[] | undefined

    if (el.type === 'node') {
      lng = el.lon
      lat = el.lat
    } else if (el.type === 'way' && el.geometry?.length) {
      coords = el.geometry.map((g) => ({ lng: g.lon, lat: g.lat }))
      const c = centroid(coords)
      lng = c.lng
      lat = c.lat
    } else if (el.type === 'relation' && el.members) {
      // Use the first outer member's geometry for a representative point.
      const outer = el.members.find((m) => m.role === 'outer' && m.geometry?.length)
      if (outer?.geometry) {
        const c = centroid(outer.geometry.map((g) => ({ lng: g.lon, lat: g.lat })))
        lng = c.lng
        lat = c.lat
      }
    }

    if (lng === undefined || lat === undefined) continue

    const { era, eraLabel } = classifyEra(tags)
    const historicType = tags.historic

    sites.push({
      id: `${el.type}-${el.id}`,
      name: tags.name ?? tags['name:en'] ?? prettifyType(historicType),
      historicType,
      era,
      eraLabel,
      lng,
      lat,
      coords,
      wikipedia: tags.wikipedia,
      wikidata: tags.wikidata,
      startDate: tags.start_date ?? tags['year_of_construction'],
      heritage: tags.heritage,
      description: tags.description,
    })
  }

  return sites
}

const ERA_LABELS: Record<HistoricEra, string> = {
  prehistoric: 'Prehistoric',
  roman: 'Roman',
  medieval: 'Medieval',
  'early-modern': 'Early Modern',
  industrial: 'Industrial',
  ww1: 'WW1',
  ww2: 'WW2',
  modern: 'Post-1945',
  unknown: 'Undated',
}

/**
 * Era classification. A parseable start_date wins (most reliable signal);
 * otherwise keyword matching over name/type/description; otherwise unknown.
 */
export function classifyEra(tags: Record<string, string>): { era: HistoricEra; eraLabel: string } {
  const year = parseStartYear(tags.start_date ?? tags['year_of_construction'])
  const era = year !== null ? eraFromYear(year) : eraFromKeywords(tags)
  return { era, eraLabel: ERA_LABELS[era] }
}

function eraFromYear(year: number): HistoricEra {
  if (year < 43) return 'prehistoric'
  if (year < 500) return 'roman'
  if (year < 1500) return 'medieval'
  if (year < 1850) return 'early-modern'
  if (year < 1914) return 'industrial'
  if (year <= 1918) return 'ww1'
  if (year < 1939) return 'industrial'
  if (year <= 1945) return 'ww2'
  return 'modern'
}

function eraFromKeywords(tags: Record<string, string>): HistoricEra {
  const h = (tags.historic ?? '').toLowerCase()
  const haystack = [
    tags.name,
    tags['name:en'],
    tags.historic,
    tags.site_type,
    tags['archaeological_site'],
    tags.castle_type,
    tags.military,
    tags.description,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()

  // 20th-century conflicts first — most specific keywords
  if (
    /ww2|world war (2|ii|two)|second world war|pillbox|bunker|raf |airfield|anti-?aircraft|radar station|searchlight|pow camp|prisoner.of.war|blitz|d-?day|1939|1940|1941|1942|1943|1944|1945/.test(haystack) ||
    h === 'pillbox' ||
    h === 'bunker' ||
    h === 'aircraft_wreck'
  )
    return 'ww2'

  if (/ww1|world war (1|i|one)|first world war|great war|1914|1915|1916|1917|1918/.test(haystack)) return 'ww1'

  if (
    /henge|stone (circle|row)|barrow|tumulus|cairn|dolmen|menhir|hillfort|hill fort|standing stone|cup mark|bronze age|iron age|neolithic|mesolithic|palaeolithic|paleolithic|megalith|roundhouse|broch|crannog|ring ditch|causewayed|long barrow/.test(
      haystack,
    )
  )
    return 'prehistoric'

  if (/roman|amphitheat|aqueduct|castra|milecastle|hadrian|antonine|thermae|villa\b|pharos/.test(haystack)) return 'roman'

  if (
    /medieval|mediaeval|castle|keep|motte|bailey|abbey|priory|monastery|friary|cathedral|minster|moat|manor|guildhall|city gate|town wall|dungeon|tithe barn|market cross|village cross|norman|saxon|anglo-saxon/.test(
      haystack,
    ) ||
    h === 'castle' ||
    h === 'city_gate' ||
    h === 'monastery' ||
    h === 'church' ||
    h === 'wayside_cross' ||
    h === 'manor'
  )
    return 'medieval'

  if (
    /mill|mine|colliery|factory|dockyard|workhouse|railway|canal|viaduct|forge|ironworks|brickworks|gasworks|warehouse|wharf|quarry|lime ?kiln|windmill|watermill|engine house|pump(ing)? house|victorian|industrial/.test(
      haystack,
    ) ||
    h === 'mine' ||
    h === 'mine_shaft' ||
    h === 'industrial'
  )
    return 'industrial'

  if (/memorial|monument|war memorial/.test(haystack) && /war|boer|crimea|napoleon/.test(haystack)) return 'early-modern'

  return 'unknown'
}

/** Parse OSM start_date variants: "1918", "~1200", "-2500", "2500 BC", "C13", "1200-01-01". */
function parseStartYear(raw: string | undefined): number | null {
  if (!raw) return null
  const s = raw.trim().toLowerCase()

  const bcMatch = s.match(/(\d{1,4})\s*(bc|bce)/)
  if (bcMatch) return -parseInt(bcMatch[1], 10)

  const centuryMatch = s.match(/^c\.?\s*(\d{1,2})/)
  if (centuryMatch) return parseInt(centuryMatch[1], 10) * 100 - 50

  const numMatch = s.match(/(-?\d{3,4})/)
  if (numMatch) return parseInt(numMatch[1], 10)

  return null
}

function centroid(coords: LngLat[]): LngLat {
  let lng = 0
  let lat = 0
  for (const c of coords) {
    lng += c.lng
    lat += c.lat
  }
  return { lng: lng / coords.length, lat: lat / coords.length }
}

function prettifyType(t: string): string {
  return t.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}
