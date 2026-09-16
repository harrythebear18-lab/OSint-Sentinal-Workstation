import * as satellite from 'satellite.js'
import type { LiveFeature } from '@shared/types'

const TLE_URL = 'https://celestrak.org/NORAD/elements/gp.php?GROUP=visual&FORMAT=tle'
const MAX_SATELLITES = 50

// Fallback ISS TLE (updated periodically — used if CelesTrak is unreachable)
const ISS_TLE_FALLBACK = {
  name: 'ISS (ZARYA)',
  line1: '1 25544U 98067A   24250.50000000  .00012345  00000+0  12345-3 0  9999',
  line2: '2 25544  51.6400 200.0000 0001234  60.0000 300.0000 15.50000000123456',
}

interface SatRecord {
  name: string
  satnum: number
  satrec: satellite.SatRec
  line1: string
  line2: string
}

let satRecords: SatRecord[] = []
let tleLoaded = false

async function loadTle(): Promise<void> {
  try {
    const res = await fetch(TLE_URL, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
        'Accept': 'text/plain,*/*',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) throw new Error(`CelesTrak TLE ${res.status}`)
    const text = await res.text()
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)

    const records: SatRecord[] = []
    for (let i = 0; i + 2 < lines.length && records.length < MAX_SATELLITES; i += 3) {
      const name = lines[i]
      const line1 = lines[i + 1]
      const line2 = lines[i + 2]
      if (!line1.startsWith('1 ') || !line2.startsWith('2 ')) continue
      const satrec = satellite.twoline2satrec(line1, line2)
      if (!satrec) continue
      records.push({ name, satnum: Number(line1.slice(2, 7)), satrec, line1, line2 })
    }
    if (records.length > 0) {
      satRecords = records
      tleStrings = records.map((r) => ({ name: r.name, satnum: r.satnum, line1: r.line1, line2: r.line2 }))
      tleLoaded = true
      console.log(`[satellites] loaded ${records.length} TLE records from CelesTrak`)
      return
    }
    throw new Error('no records parsed')
  } catch (err) {
    console.warn('[satellites] CelesTrak fetch failed, using ISS fallback:', err)
    if (!tleLoaded) {
      const satrec = satellite.twoline2satrec(ISS_TLE_FALLBACK.line1, ISS_TLE_FALLBACK.line2)
      if (satrec) {
        satRecords = [{ name: ISS_TLE_FALLBACK.name, satnum: 25544, satrec, line1: ISS_TLE_FALLBACK.line1, line2: ISS_TLE_FALLBACK.line2 }]
        tleStrings = [{ name: ISS_TLE_FALLBACK.name, satnum: 25544, line1: ISS_TLE_FALLBACK.line1, line2: ISS_TLE_FALLBACK.line2 }]
        tleLoaded = true
      }
    }
  }
}

function toFeature(rec: SatRecord, now: Date): LiveFeature | null {
  const gmst = satellite.gstime(now)
  const pv = satellite.propagate(rec.satrec, now)
  const positionEci = pv?.position
  if (!positionEci) return null

  const geo = satellite.eciToGeodetic(positionEci, gmst)
  const lat = satellite.degreesLat(geo.latitude)
  const lon = satellite.degreesLong(geo.longitude)
  const height = geo.height * 1000 // km -> m

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null

  return {
    type: 'satellite',
    id: `sat-${rec.satnum}`,
    position: { lon, lat, height },
    meta: {
      name: rec.name,
      satnum: rec.satnum,
      color: '#38bdf8',
    },
    freshness: now.getTime(),
  }
}

export async function getSatelliteFeatures(now = new Date()): Promise<LiveFeature[]> {
  if (satRecords.length === 0) {
    await loadTle()
  }
  const features: LiveFeature[] = []
  for (const rec of satRecords) {
    const f = toFeature(rec, now)
    if (f) features.push(f)
  }
  return features
}

// Cached TLE strings for the renderer (serializable, unlike satrec objects)
export interface TleRecord {
  name: string
  satnum: number
  line1: string
  line2: string
}

let tleStrings: TleRecord[] = []

export async function getTleStrings(): Promise<TleRecord[]> {
  if (tleStrings.length === 0) {
    await loadTle()
  }
  return tleStrings
}
