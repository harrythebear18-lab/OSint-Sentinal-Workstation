import * as satellite from 'satellite.js'
import { promises as fsp } from 'node:fs'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import type { LiveFeature } from '@shared/types'

const TLE_SOURCES = [
  'https://celestrak.org/NORAD/elements/gp.php?GROUP=visual&FORMAT=tle',
  'https://celestrak.org/NORAD/elements/gp.php?GROUP=stations&FORMAT=tle',
  'https://www.amsat.org/tle/current/nasabare.txt',
]
const MAX_SATELLITES = 50
const TLE_CACHE_FILE = path.join(os.tmpdir(), 'osint-sentinel-workstation', 'tle-cache.json')
const TLE_CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000 // TLEs stay usable ~2 weeks

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

function parseTleText(text: string): SatRecord[] {
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
  return records
}

function adoptRecords(records: SatRecord[]): void {
  satRecords = records
  tleStrings = records.map((r) => ({ name: r.name, satnum: r.satnum, line1: r.line1, line2: r.line2 }))
  tleLoaded = true
}

/** Persist last-good TLEs so offline starts don't fall back to a stale bundled set. */
async function persistTleCache(records: SatRecord[]): Promise<void> {
  try {
    await fsp.mkdir(path.dirname(TLE_CACHE_FILE), { recursive: true })
    await fsp.writeFile(
      TLE_CACHE_FILE,
      JSON.stringify({
        cachedAt: Date.now(),
        tles: records.map((r) => ({ name: r.name, line1: r.line1, line2: r.line2 })),
      }),
    )
  } catch {}
}

async function loadTleCache(): Promise<SatRecord[] | null> {
  try {
    if (!fs.existsSync(TLE_CACHE_FILE)) return null
    const data = JSON.parse(await fsp.readFile(TLE_CACHE_FILE, 'utf8')) as {
      cachedAt: number
      tles: { name: string; line1: string; line2: string }[]
    }
    if (Date.now() - data.cachedAt > TLE_CACHE_TTL_MS) return null
    const records: SatRecord[] = []
    for (const t of data.tles ?? []) {
      const satrec = satellite.twoline2satrec(t.line1, t.line2)
      if (satrec) records.push({ name: t.name, satnum: Number(t.line1.slice(2, 7)), satrec, line1: t.line1, line2: t.line2 })
    }
    return records.length > 0 ? records : null
  } catch {
    return null
  }
}

async function loadTle(): Promise<void> {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    'Accept': 'text/plain,*/*',
    'Accept-Language': 'en-US,en;q=0.9',
  }

  for (const url of TLE_SOURCES) {
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(10000) })
      if (!res.ok) throw new Error(`TLE ${res.status}`)
      const records = parseTleText(await res.text())
      if (records.length === 0) throw new Error('no records parsed')
      adoptRecords(records)
      console.log(`[satellites] loaded ${records.length} TLE records from ${new URL(url).hostname}`)
      persistTleCache(records).catch(() => {})
      return
    } catch (err) {
      console.warn(`[satellites] ${url} failed:`, err instanceof Error ? err.message : err)
    }
  }

  // All sources failed — try the disk cache before the bundled fallback.
  const cached = await loadTleCache()
  if (cached) {
    adoptRecords(cached)
    console.log(`[satellites] using cached TLE set (${cached.length} records)`)
    return
  }

  if (!tleLoaded) {
    console.warn('[satellites] all sources + cache failed, using ISS fallback')
    const satrec = satellite.twoline2satrec(ISS_TLE_FALLBACK.line1, ISS_TLE_FALLBACK.line2)
    if (satrec) {
      adoptRecords([{ name: ISS_TLE_FALLBACK.name, satnum: 25544, satrec, line1: ISS_TLE_FALLBACK.line1, line2: ISS_TLE_FALLBACK.line2 }])
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
