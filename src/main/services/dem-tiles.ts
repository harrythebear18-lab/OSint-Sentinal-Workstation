/**
 * SRTM DEM tile resolver + fetcher with on-disk cache.
 * Ported from OSINT-Global-OS. Uses AWS Terrarium tiles (free, no key).
 *
 * Terrarium encoding: elevation = (R * 256 + G + B / 256) - 32768
 * URL: https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png
 */

import { join, dirname } from 'path'
import { homedir } from 'os'
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, rmSync } from 'fs'

const CACHE_DIR = join(homedir(), '.osint-sentinel-workstation', 'cache', 'dem')
const MAX_CACHE_BYTES = 256 * 1024 * 1024

let evictScheduled = false
let writesSinceEvict = 0

/** LRU-evict the DEM tile cache down to maxBytes (oldest mtime first). */
export function evictDemCache(maxBytes = MAX_CACHE_BYTES): void {
  if (!existsSync(CACHE_DIR)) return
  const files: { path: string; size: number; mtime: number }[] = []
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        walk(full)
      } else {
        const st = statSync(full)
        files.push({ path: full, size: st.size, mtime: st.mtimeMs })
      }
    }
  }
  walk(CACHE_DIR)

  let total = files.reduce((s, f) => s + f.size, 0)
  if (total <= maxBytes) return

  files.sort((a, b) => a.mtime - b.mtime)
  let removed = 0
  for (const f of files) {
    if (total <= maxBytes) break
    try {
      rmSync(f.path)
      total -= f.size
      removed++
    } catch { /* file in use — skip */ }
  }
  console.log(`[dem] cache evicted ${removed} tiles — ${(total / 1048576).toFixed(0)} MB remaining`)
}

const TILE_URL = (z: number, x: number, y: number) =>
  `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`

export const DEFAULT_ZOOM = 12

export interface DemTileData {
  grid: (number | null)[][]
  width: number
  height: number
  x: number
  y: number
  z: number
  bounds: [{ lng: number; lat: number }, { lng: number; lat: number }]
}

function ensureCacheDir(): void {
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true })
}

function tilePath(z: number, x: number, y: number): string {
  return join(CACHE_DIR, `${z}`, `${x}`, `${y}.png`)
}

async function fetchTilePng(z: number, x: number, y: number): Promise<Buffer | null> {
  ensureCacheDir()
  const local = tilePath(z, x, y)

  if (existsSync(local)) return readFileSync(local)

  const url = TILE_URL(z, x, y)
  try {
    // Use HAL streaming I/O for backpressure-aware download
    const { streamingIO } = await import('./hal/streaming-io')
    const buf = await streamingIO.fetchToBuffer(url, { timeoutMs: 20000 })
    if (!buf) return null

    mkdirSync(dirname(local), { recursive: true })
    writeFileSync(local, buf)

    // Bound the cache — evict oldest tiles every 500 writes
    if (++writesSinceEvict >= 500) {
      writesSinceEvict = 0
      try { evictDemCache() } catch { /* eviction is best-effort */ }
    }

    return buf
  } catch (e) {
    console.error(`[dem] Failed to fetch tile ${z}/${x}/${y}:`, e)
    return null
  }
}

async function decodeTerrariumPng(pngBuf: Buffer): Promise<number[][]> {
  // Try WebCodecs hardware decode via renderer bridge first
  try {
    const { decodeImageViaRenderer } = await import('./image-decode-bridge')
    const decoded = await decodeImageViaRenderer(pngBuf, 'image/png')
    if (decoded && decoded.data.length > 0) {
      const { data, width, height } = decoded
      const grid: number[][] = []
      for (let y = 0; y < height; y++) {
        const row: number[] = []
        for (let x = 0; x < width; x++) {
          const idx = (y * width + x) * 4
          const r = data[idx]
          const g = data[idx + 1]
          const b = data[idx + 2]
          const elev = r * 256 + g + b / 256 - 32768
          row.push(elev)
        }
        grid.push(row)
      }
      console.log(`[dem] decoded ${width}x${height} Terrarium PNG via WebCodecs hardware`)
      return grid
    }
  } catch {
    // Bridge not ready or unavailable — fall through to pngjs
  }

  // Fallback: pngjs pure JS decode
  const { PNG } = await import('pngjs')
  const png = PNG.sync.read(pngBuf)
  const { width, height, data } = png

  const grid: number[][] = []
  for (let y = 0; y < height; y++) {
    const row: number[] = []
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4
      const r = data[idx]
      const g = data[idx + 1]
      const b = data[idx + 2]
      const elev = r * 256 + g + b / 256 - 32768
      row.push(elev)
    }
    grid.push(row)
  }
  return grid
}

function tileToBounds(z: number, x: number, y: number): [{ lng: number; lat: number }, { lng: number; lat: number }] {
  const n = Math.pow(2, z)
  const lngWest = (x / n) * 360 - 180
  const lngEast = ((x + 1) / n) * 360 - 180
  const latNorth = (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI
  const latSouth = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 1)) / n))) * 180) / Math.PI
  return [
    { lng: lngWest, lat: latSouth },
    { lng: lngEast, lat: latNorth },
  ]
}

export async function loadDemTile(z: number, x: number, y: number): Promise<DemTileData | null> {
  const pngBuf = await fetchTilePng(z, x, y)
  if (!pngBuf) return null

  const grid = await decodeTerrariumPng(pngBuf)
  const bounds = tileToBounds(z, x, y)

  return {
    grid,
    width: grid[0]?.length ?? 0,
    height: grid.length,
    x,
    y,
    z,
    bounds,
  }
}

export function lngLatToTile(lng: number, lat: number, z: number): { x: number; y: number } {
  const n = Math.pow(2, z)
  const x = Math.floor(((lng + 180) / 360) * n)
  const latRad = (lat * Math.PI) / 180
  const y = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n)
  return { x, y }
}

export function lngLatToTilePixel(
  lng: number,
  lat: number,
  tileZ: number,
  tileX: number,
  tileY: number,
  tileSize: number,
): { px: number; py: number } {
  const n = Math.pow(2, tileZ)
  const px = ((lng + 180) / 360) * n * tileSize - tileX * tileSize
  const latRad = (lat * Math.PI) / 180
  const py =
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n * tileSize -
    tileY * tileSize
  return { px: Math.floor(px), py: Math.floor(py) }
}

export { CACHE_DIR }
