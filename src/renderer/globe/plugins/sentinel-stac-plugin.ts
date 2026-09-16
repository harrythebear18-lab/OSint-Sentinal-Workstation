/**
 * Sentinel-2 STAC/COG Plugin — real Sentinel-2 data ingestion.
 *
 * Searches the public Element84 Earth Search STAC API for Sentinel-2 L2A
 * scenes, selects the least-cloudy scene, and reads real COG band assets
 * from the main process. Computes NDVI, NDWI, or NBR from actual band
 * reflectance values and overlays the result on Cesium.
 *
 * This is the replacement for GIBS browse imagery — real data, real bands.
 *
 * Data source: https://earth-search.aws.element84.com/v1/ (keyless)
 */

import * as Cesium from 'cesium'
import type { EarthEnginePlugin, PluginContext, PluginStats, PluginControlSpec } from './plugin-manager'

// NDVI color ramp: red (-1) → yellow (0) → green (0.3) → dark green (1)
const NDVI_RAMP: [number, number, number, number][] = [
  [-1.0, 120, 0, 0],
  [-0.2, 200, 100, 0],
  [0.0, 255, 255, 0],
  [0.2, 150, 220, 0],
  [0.5, 0, 180, 0],
  [1.0, 0, 80, 0],
]

// NDWI color ramp: brown (-1) → white (0) → blue (1)
const NDWI_RAMP: [number, number, number, number][] = [
  [-1.0, 120, 80, 0],
  [-0.2, 200, 180, 120],
  [0.0, 255, 255, 255],
  [0.2, 0, 150, 220],
  [0.6, 0, 80, 180],
  [1.0, 0, 0, 120],
]

// NBR color ramp: green (-1) → black (0) → red (1)
const NBR_RAMP: [number, number, number, number][] = [
  [-1.0, 0, 180, 0],
  [0.0, 0, 0, 0],
  [0.2, 180, 0, 0],
  [0.6, 255, 0, 0],
  [1.0, 255, 255, 0],
]

interface StacResult {
  output: number[]
  width: number
  height: number
  bbox: { west: number; south: number; east: number; north: number }
  sceneId: string
  date: string
  cloudCover: number
  formula: string
  durationMs: number
  backend: string
  error?: string
}

export class SentinelStacPlugin implements EarthEnginePlugin {
  id = 'sentinel-stac'
  name = 'Sentinel-2 STAC/COG (real S2 bands)'
  category = 'imagery' as const

  private viewer: Cesium.Viewer | null = null
  private ipc: typeof window.api | null = null
  private imageryLayer: Cesium.ImageryLayer | null = null
  private status: PluginStats = { count: 0, status: 'disabled' }

  private formula: 'ndvi' | 'ndwi' | 'nbr' = 'ndvi'
  private startDate = this.defaultDate(-30)
  private endDate = this.defaultDate(0)
  private maxCloud = 20
  private resolution = 1024
  private lastResult: StacResult | null = null
  private useViewBbox = true

  async register(ctx: PluginContext): Promise<void> {
    this.viewer = ctx.viewer
    this.ipc = ctx.ipc
    this.status = { count: 0, status: 'nominal' }
    console.log('[sentinel-stac] STAC/COG plugin ready')
  }

  unregister(): void {
    this.removeLayer()
    this.viewer = null
    this.status = { count: 0, status: 'disabled' }
  }

  update(_ctx: PluginContext): void {}

  getStats(): PluginStats {
    return this.status
  }

  getControls(): PluginControlSpec[] {
    const hasResult = this.lastResult !== null

    return [
      { type: 'select', id: 'formula', label: 'Index', value: this.formula, options: [
        { label: 'NDVI (B08/B04)', value: 'ndvi' },
        { label: 'NDWI (B03/B08)', value: 'ndwi' },
        { label: 'NBR (B08/B11)', value: 'nbr' },
      ]},
      { type: 'input', id: 'startDate', label: 'Start Date', value: this.startDate },
      { type: 'input', id: 'endDate', label: 'End Date', value: this.endDate },
      { type: 'slider', id: 'maxCloud', label: 'Max Cloud', value: this.maxCloud, min: 0, max: 100, step: 5, unit: '%' },
      { type: 'select', id: 'resolution', label: 'Resolution', value: String(this.resolution), options: [
        { label: '512 px (fast)', value: '512' },
        { label: '1024 px', value: '1024' },
        { label: '2048 px (max)', value: '2048' },
      ]},
      { type: 'toggle', id: 'useView', label: 'Use Viewport BBox', value: this.useViewBbox },
      { type: 'separator', id: 'sep1' },
      { type: 'button', id: 'compute', label: 'Fetch S2 COG', variant: 'primary' },
      { type: 'button', id: 'clear', label: 'Clear', variant: 'danger', disabled: !hasResult },
      { type: 'separator', id: 'sep2' },
      { type: 'display', id: 'scene', label: 'Scene', value: this.lastResult ? this.lastResult.sceneId : '—', color: hasResult ? '#4aff8a' : '#6b7d92' },
      { type: 'display', id: 'date', label: 'Date', value: this.lastResult ? this.lastResult.date.split('T')[0] : '—', color: hasResult ? '#4affd4' : '#6b7d92' },
      { type: 'display', id: 'cloud', label: 'Cloud', value: this.lastResult ? `${this.lastResult.cloudCover.toFixed(0)}%` : '—', color: hasResult ? '#4aff8a' : '#6b7d92' },
      { type: 'display', id: 'time', label: 'Compute', value: this.lastResult ? `${this.lastResult.durationMs.toFixed(0)}ms` : '—', color: hasResult ? '#ffaa00' : '#6b7d92' },
    ]
  }

  onControl(id: string, value?: unknown): void {
    if (id === 'formula' && typeof value === 'string') {
      this.formula = value as any
    } else if (id === 'startDate' && typeof value === 'string') {
      this.startDate = value
    } else if (id === 'endDate' && typeof value === 'string') {
      this.endDate = value
    } else if (id === 'maxCloud' && typeof value === 'number') {
      this.maxCloud = value
    } else if (id === 'resolution' && typeof value === 'string') {
      this.resolution = Number(value)
    } else if (id === 'useView' && typeof value === 'boolean') {
      this.useViewBbox = value
    } else if (id === 'compute') {
      this.compute()
    } else if (id === 'clear') {
      this.clear()
    }
  }

  clear(): void {
    this.removeLayer()
    this.lastResult = null
    this.status = { count: 0, status: 'nominal' }
  }

  // ── Compute real Sentinel-2 index from STAC/COG ──

  private async compute(): Promise<void> {
    if (!this.viewer || !this.ipc) return

    let west = -10, south = 35, east = 10, north = 55
    if (this.useViewBbox) {
      const rect = this.viewer.camera.computeViewRectangle?.()
      if (rect) {
        west = Cesium.Math.toDegrees(rect.west)
        south = Cesium.Math.toDegrees(rect.south)
        east = Cesium.Math.toDegrees(rect.east)
        north = Cesium.Math.toDegrees(rect.north)
      }
    }

    // Clamp to reasonable area (Sentinel-2 tile size ~100x100km)
    if ((east - west) * (north - south) > 4) {
      const centerLon = (west + east) / 2
      const centerLat = (south + north) / 2
      west = centerLon - 1
      east = centerLon + 1
      south = centerLat - 1
      north = centerLat + 1
    }

    this.status = { count: 0, status: 'loading' }

    try {
      const result = await this.ipc.invoke('stac:cog:compute', {
        west,
        south,
        east,
        north,
        startDate: this.startDate,
        endDate: this.endDate,
        maxCloudCover: this.maxCloud,
        formula: this.formula,
        resolution: this.resolution,
      }) as StacResult

      if (result.error) {
        throw new Error(result.error)
      }

      this.lastResult = result
      this.renderResult(result)
      this.status = { count: 0, status: 'nominal' }
      console.log(`[sentinel-stac] computed ${this.formula} — scene ${result.sceneId}, ${result.cloudCover.toFixed(0)}% cloud, ${result.durationMs.toFixed(0)}ms`)
    } catch (e) {
      console.error('[sentinel-stac] compute failed:', e)
      this.status = { count: 0, status: 'error', error: String(e) }
    }
  }

  // ── Render the COG result as a Cesium imagery overlay ──

  private renderResult(result: StacResult): void {
    if (!this.viewer) return
    this.removeLayer()

    const ramp = this.formula === 'ndvi' ? NDVI_RAMP : this.formula === 'ndwi' ? NDWI_RAMP : NBR_RAMP
    const canvas = this.indexToCanvas(result.output, result.width, result.height, ramp)

    // Convert canvas to blob URL synchronously
    canvas.convertToBlob({ type: 'image/png' }).then((blob) => {
      const url = URL.createObjectURL(blob)
      const rectangle = Cesium.Rectangle.fromDegrees(
        result.bbox.west, result.bbox.south, result.bbox.east, result.bbox.north,
      )
      const provider = new Cesium.SingleTileImageryProvider({ url, rectangle, tileWidth: result.width, tileHeight: result.height })
      if (!this.viewer) return
      this.imageryLayer = this.viewer.imageryLayers.addImageryProvider(provider)
      if (this.imageryLayer) {
        this.imageryLayer.alpha = 0.8
      }
    })
  }

  private indexToCanvas(data: number[], width: number, height: number, ramp: [number, number, number, number][]): OffscreenCanvas {
    const canvas = new OffscreenCanvas(width, height)
    const ctx = canvas.getContext('2d')!
    const imageData = ctx.createImageData(width, height)

    for (let i = 0; i < data.length; i++) {
      const val = data[i]
      const [r, g, b] = this.interpolateRamp(ramp, val)
      const idx = i * 4
      imageData.data[idx] = r
      imageData.data[idx + 1] = g
      imageData.data[idx + 2] = b
      imageData.data[idx + 3] = 255
    }

    ctx.putImageData(imageData, 0, 0)
    return canvas
  }

  private interpolateRamp(ramp: [number, number, number, number][], val: number): [number, number, number] {
    if (val <= ramp[0][0]) return [ramp[0][1], ramp[0][2], ramp[0][3]]
    if (val >= ramp[ramp.length - 1][0]) return [ramp[ramp.length - 1][1], ramp[ramp.length - 1][2], ramp[ramp.length - 1][3]]

    for (let i = 0; i < ramp.length - 1; i++) {
      if (val >= ramp[i][0] && val <= ramp[i + 1][0]) {
        const t = (val - ramp[i][0]) / (ramp[i + 1][0] - ramp[i][0])
        return [
          Math.round(ramp[i][1] + t * (ramp[i + 1][1] - ramp[i][1])),
          Math.round(ramp[i][2] + t * (ramp[i + 1][2] - ramp[i][2])),
          Math.round(ramp[i][3] + t * (ramp[i + 1][3] - ramp[i][3])),
        ]
      }
    }
    return [0, 0, 0]
  }

  private removeLayer(): void {
    if (this.imageryLayer && this.viewer && !this.viewer.isDestroyed?.()) {
      this.viewer.imageryLayers.remove(this.imageryLayer)
    }
    this.imageryLayer = null
  }

  private defaultDate(offsetDays: number): string {
    const d = new Date()
    d.setDate(d.getDate() + offsetDays)
    return d.toISOString().split('T')[0]
  }
}

export const sentinelStacPlugin = new SentinelStacPlugin()
