/**
 * Canopy Service — vegetation analysis using GIBS NDVI tiles + DEM roughness.
 *
 * Improvements:
 *  - Fetches a single GIBS NDVI tile covering the bbox (not per-pixel requests)
 *  - Shows ALL vegetation zones, not just defoliation
 *  - Estimates canopy height from DEM local roughness (pseudo-LiDAR)
 *  - Grid-based spatial clustering (O(n) instead of O(n²))
 *  - Falls back to last 8-day composite if daily is unavailable
 *  - Classifies zones: dense forest, open forest, shrubland, grassland, barren, water
 */

import type { LngLat, CanopyAnalysisRequest, CanopyAnalysisResponse } from '@shared/types'
import { loadTile } from './dem-service'
import { lngLatToTile } from './dem-tiles'
import { computeOptimalZoom } from './dem-zoom'

const DEM_ZOOM = 12

/**
 * Fetch a GIBS NDVI tile covering the bbox and extract NDVI values.
 * Uses MODIS Terra 8-Day NDVI which has reliable availability.
 * Returns a 2D grid of NDVI values (-1 to 1).
 */
async function fetchNdviTile(
  sw: LngLat,
  ne: LngLat,
  width: number,
  height: number,
): Promise<(number | null)[][]> {
  // Try multiple dates: yesterday, 3 days ago, 7 days ago, 14 days ago
  const dates: string[] = []
  for (let back = 1; back <= 14; back++) {
    const d = new Date()
    d.setDate(d.getDate() - back)
    dates.push(d.toISOString().split('T')[0])
  }

  // GIBS WMS request — fetch a small tile covering the bbox
  // Use 256x256 to keep it fast, we'll sample from it
  const reqWidth = Math.min(512, Math.max(64, width))
  const reqHeight = Math.min(512, Math.max(64, height))
  const bbox = `${sw.lng},${sw.lat},${ne.lng},${ne.lat}`

  for (const date of dates) {
    // CRS:84 keeps BBOX in lon,lat order (EPSG:4326 in WMS 1.3.0 is lat-first,
    // which silently returns a fully transparent tile)
    const url = `https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi?SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0&LAYERS=MODIS_Terra_NDVI_8Day&CRS=CRS:84&BBOX=${bbox}&WIDTH=${reqWidth}&HEIGHT=${reqHeight}&FORMAT=image/png&TIME=${date}`

    try {
      // Use HAL streaming I/O for backpressure-aware download
      const { streamingIO } = await import('./hal/streaming-io')
      const buf = await streamingIO.fetchToBuffer(url, { timeoutMs: 15000 })
      if (!buf || buf.length < 100) continue

      // Try WebCodecs hardware decode via renderer bridge
      let pixelData: Uint8Array | null = null
      let pngWidth = 0
      let pngHeight = 0
      try {
        const { decodeImageViaRenderer } = await import('./image-decode-bridge')
        const decoded = await decodeImageViaRenderer(buf, 'image/png')
        if (decoded && decoded.data.length > 0) {
          pixelData = decoded.data
          pngWidth = decoded.width
          pngHeight = decoded.height
        }
      } catch {
        // Bridge not ready — fall through to pngjs
      }

      if (!pixelData) {
        // Fallback: pngjs pure JS decode
        const { PNG } = await import('pngjs')
        const png = PNG.sync.read(buf)
        pixelData = png.data as unknown as Uint8Array
        pngWidth = png.width
        pngHeight = png.height
      }

      // Build NDVI grid from the decoded pixels
      // GIBS NDVI palette: dark brown (low) → green (high)
      // We approximate NDVI from the green/red ratio
      const ndviGrid: (number | null)[][] = []
      for (let y = 0; y < height; y++) {
        const row: (number | null)[] = []
        // Map our grid coords to the PNG pixels
        const py = Math.min(pngHeight - 1, Math.floor((y / height) * pngHeight))
        for (let x = 0; x < width; x++) {
          const px = Math.min(pngWidth - 1, Math.floor((x / width) * pngWidth))
          const idx = (py * pngWidth + px) * 4
          const r = pixelData[idx]
          const g = pixelData[idx + 1]
          const b = pixelData[idx + 2]
          const a = pixelData[idx + 3]

          if (a < 10) {
            row.push(null)
            continue
          }

          // GIBS NDVI color palette approximation
          // The palette goes: brown (low NDVI) → tan → yellow-green → dark green (high NDVI)
          // Green dominance = high NDVI, red dominance = low NDVI
          const ndvi = (g - r) / 255 * 0.5 + 0.3  // scaled to roughly 0-0.8 range
          row.push(Math.max(-0.2, Math.min(0.9, ndvi)))
        }
        ndviGrid.push(row)
      }
      return ndviGrid
    } catch {
      continue
    }
  }

  // All dates failed — return null grid
  return Array.from({ length: height }, () => Array(width).fill(null))
}

/**
 * Estimate canopy height from DEM local roughness.
 * Forest canopies create surface roughness in DEM data.
 * Returns a 2D grid of estimated canopy height in meters.
 */
function estimateCanopyHeight(
  grid: (number | null)[][],
  width: number,
  height: number,
  windowSize = 5,
): (number | null)[][] {
  const canopyGrid: (number | null)[][] = []
  const half = Math.floor(windowSize / 2)

  for (let y = 0; y < height; y++) {
    const row: (number | null)[] = []
    for (let x = 0; x < width; x++) {
      const center = grid[y]?.[x]
      if (center == null) {
        row.push(null)
        continue
      }

      // Compute local elevation variance as roughness proxy
      let sum = 0
      let sumSq = 0
      let count = 0
      for (let dy = -half; dy <= half; dy++) {
        for (let dx = -half; dx <= half; dx++) {
          const ny = y + dy
          const nx = x + dx
          if (ny < 0 || ny >= height || nx < 0 || nx >= width) continue
          const e = grid[ny]?.[nx]
          if (e == null) continue
          sum += e
          sumSq += e * e
          count++
        }
      }

      if (count < 4) {
        row.push(0)
        continue
      }

      const mean = sum / count
      const variance = sumSq / count - mean * mean
      const roughness = Math.sqrt(Math.max(0, variance))

      // Roughness in meters → canopy height estimate
      // Typical forest: 5-30m roughness, shrubland: 2-5m, grassland: <2m
      // Cap at 40m
      row.push(Math.min(40, roughness * 1.5))
    }
    canopyGrid.push(row)
  }

  return canopyGrid
}

/**
 * Classify a zone by NDVI value.
 */
function classifyZone(ndvi: number): { type: string; severity: number } {
  if (ndvi < 0) return { type: 'water', severity: 0 }
  if (ndvi < 0.1) return { type: 'barren', severity: 0.8 }
  if (ndvi < 0.2) return { type: 'grassland', severity: 0.4 }
  if (ndvi < 0.35) return { type: 'shrubland', severity: 0.2 }
  if (ndvi < 0.5) return { type: 'open-forest', severity: 0.1 }
  if (ndvi < 0.7) return { type: 'forest', severity: 0 }
  return { type: 'dense-forest', severity: 0 }
}

export async function analyzeCanopy(req: CanopyAnalysisRequest): Promise<CanopyAnalysisResponse> {
  const { bounds } = req
  const effectiveZoom = computeOptimalZoom(bounds, DEM_ZOOM, 32)
  const [sw, ne] = bounds
  const minTile = lngLatToTile(sw.lng, ne.lat, effectiveZoom)
  const maxTile = lngLatToTile(ne.lng, sw.lat, effectiveZoom)
  const tilesX = maxTile.x - minTile.x + 1
  const tilesY = maxTile.y - minTile.y + 1

  // ── Load DEM tiles ──
  const tileGrids: (number | null)[][][][] = []
  for (let ty = 0; ty < tilesY; ty++) {
    tileGrids[ty] = []
    for (let tx = 0; tx < tilesX; tx++) {
      const tile = await loadTile(minTile.x + tx, minTile.y + ty, effectiveZoom)
      tileGrids[ty][tx] = tile.grid
    }
  }

  const grid: (number | null)[][] = []
  for (let ty = 0; ty < tilesY; ty++) {
    for (let row = 0; row < tileGrids[ty][0].length; row++) {
      const mergedRow: (number | null)[] = []
      for (let tx = 0; tx < tilesX; tx++) {
        const tileRow = tileGrids[ty][tx][row]
        if (tileRow) mergedRow.push(...tileRow)
      }
      grid.push(mergedRow)
    }
  }

  const height = grid.length
  const width = grid[0]?.length ?? 0
  if (width === 0 || height === 0) {
    return { zones: [], bounds }
  }

  const lngStep = (ne.lng - sw.lng) / width
  const latStep = (ne.lat - sw.lat) / height

  // ── Fetch NDVI tile covering the bbox ──
  // Sample on a coarser grid to keep rendering manageable
  const sampleStep = Math.max(4, Math.floor(width / 30))
  const sampleWidth = Math.floor(width / sampleStep)
  const sampleHeight = Math.floor(height / sampleStep)

  const ndviGrid = await fetchNdviTile(sw, ne, sampleWidth, sampleHeight)

  // ── Estimate canopy height from DEM roughness ──
  const canopyGrid = estimateCanopyHeight(grid, width, height, 7)

  // ── Build sample cells with NDVI + canopy height ──
  interface SampleCell {
    lng: number
    lat: number
    ndvi: number
    canopyM: number
    x: number
    y: number
  }

  const cells: SampleCell[] = []
  for (let sy = 0; sy < sampleHeight; sy++) {
    for (let sx = 0; sx < sampleWidth; sx++) {
      const ndvi = ndviGrid[sy]?.[sx]
      if (ndvi == null) continue

      // Map sample coords back to full grid
      const gx = sx * sampleStep
      const gy = sy * sampleStep
      const canopyM = canopyGrid[gy]?.[gx] ?? 0

      const lng = sw.lng + gx * lngStep
      const lat = ne.lat - gy * latStep

      cells.push({ lng, lat, ndvi, canopyM, x: sx, y: sy })
    }
  }

  if (cells.length === 0) {
    return { zones: [], bounds }
  }

  // ── Grid-based spatial clustering by NDVI class ──
  // Group cells into contiguous zones of similar vegetation type
  const cellMap = new Map<string, SampleCell>()
  for (const c of cells) cellMap.set(`${c.x},${c.y}`, c)

  const visited = new Set<string>()
  const zones: CanopyAnalysisResponse['zones'] = []
  let zoneId = 0

  for (const cell of cells) {
    const key = `${cell.x},${cell.y}`
    if (visited.has(key)) continue

    const { type } = classifyZone(cell.ndvi)

    // BFS to find connected cells of the same vegetation class
    const cluster: SampleCell[] = []
    const stack = [cell]
    let ndviSum = 0
    let canopySum = 0

    while (stack.length > 0) {
      const c = stack.pop()!
      const ckey = `${c.x},${c.y}`
      if (visited.has(ckey)) continue
      visited.add(ckey)
      cluster.push(c)
      ndviSum += c.ndvi
      canopySum += c.canopyM

      // Check 4-connected neighbors
      const neighbors = [
        { x: c.x + 1, y: c.y },
        { x: c.x - 1, y: c.y },
        { x: c.x, y: c.y + 1 },
        { x: c.x, y: c.y - 1 },
      ]
      for (const n of neighbors) {
        const nkey = `${n.x},${n.y}`
        if (visited.has(nkey)) continue
        const nc = cellMap.get(nkey)
        if (!nc) continue
        const nClass = classifyZone(nc.ndvi).type
        if (nClass === type) stack.push(nc)
      }
    }

    if (cluster.length < 1) continue

    const avgNdvi = ndviSum / cluster.length
    const avgCanopyM = canopySum / cluster.length
    const { type: zoneType, severity } = classifyZone(avgNdvi)

    // Build polygon from cluster (convex hull)
    const points = cluster.map((c) => ({ lng: c.lng, lat: c.lat }))
    const hull = convexHull(points)

    zones.push({
      id: `canopy-${zoneId++}`,
      coords: hull.length >= 3 ? hull : points.slice(0, 4),
      type: zoneType as any,
      avgNdvi,
      severity,
    })
  }

  // Sort by area (largest first) and limit
  zones.sort((a, b) => b.coords.length - a.coords.length)
  return { zones: zones.slice(0, 100), bounds }
}

/**
 * Convex hull (Andrew's monotone chain).
 */
function convexHull(points: LngLat[]): LngLat[] {
  if (points.length < 3) return points

  const sorted = points.slice().sort((a, b) => a.lng - b.lng || a.lat - b.lat)

  const cross = (o: LngLat, a: LngLat, b: LngLat): number =>
    (a.lng - o.lng) * (b.lat - o.lat) - (a.lat - o.lat) * (b.lng - o.lng)

  const lower: LngLat[] = []
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop()
    }
    lower.push(p)
  }

  const upper: LngLat[] = []
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i]
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop()
    }
    upper.push(p)
  }

  return lower.slice(0, -1).concat(upper.slice(0, -1))
}
