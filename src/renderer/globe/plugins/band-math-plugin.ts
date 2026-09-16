/**
 * Band Math Plugin — Sentinel-2 spectral index computation (NDVI, NDWI, NBR).
 * Tier 1, Priority 4. The headline Sentinel-2 analysis feature.
 *
 * Fetches individual spectral bands from the public Element84 Earth Search
 * STAC/COG API, computes spectral indices using the compute dispatcher
 * (WebGPU → WASM SIMD → CPU worker → inline), and renders the result as a
 * color-mapped Cesium imagery layer over the selection bbox.
 *
 * Indices:
 *   NDVI = (NIR - Red) / (NIR + Red)  — vegetation health
 *   NDWI = (Green - NIR) / (Green + NIR) — water bodies
 *   NBR  = (NIR - SWIR) / (NIR + SWIR) — burn severity
 *
 * The compute dispatcher routes to:
 *   1. WebGPU `ndvi`/`ndwi`/`nbr` kernel (GPU — thousands of cores)
 *   2. WASM SIMD (f32x4)
 *   3. CPU worker (worker_threads)
 *   4. CPU inline (fallback)
 *
 * Data source: https://earth-search.aws.element84.com/v1/ (keyless)
 * Collection: sentinel-2-l2a
 */

import * as Cesium from 'cesium'
import type { EarthEnginePlugin, PluginContext, PluginStats, PluginControlSpec } from './plugin-manager'
import { computeDispatcher } from '../hal/compute-dispatcher'
import type { ComputeTask } from '@shared/compute-contract'

type BandIndex = 'ndvi' | 'ndwi' | 'nbr'

interface BandSpec {
  id: BandIndex
  label: string
  bandA: string  // numerator band asset name
  bandB: string  // denominator band asset name
  task: ComputeTask
  // Color ramp: [value, r, g, b]
  ramp: [number, number, number, number][]
}

const BAND_SPECS: BandSpec[] = [
  {
    id: 'ndvi',
    label: 'NDVI (Vegetation)',
    bandA: 'nir',
    bandB: 'red',
    task: 'ndvi',
    ramp: [
      [-1.0, 0, 0, 80],     // Deep water
      [-0.2, 0, 0, 120],    // Shallow water
      [0.0, 180, 120, 40], // Bare soil
      [0.3, 200, 200, 50], // Sparse vegetation
      [0.6, 80, 180, 50],  // Moderate vegetation
      [0.8, 40, 140, 40],  // Dense vegetation
      [1.0, 20, 100, 20],  // Very dense
    ],
  },
  {
    id: 'ndwi',
    label: 'NDWI (Water)',
    bandA: 'green',
    bandB: 'nir',
    task: 'ndwi',
    ramp: [
      [-1.0, 200, 200, 200], // Land
      [-0.2, 150, 150, 180], // Dry land
      [0.0, 100, 150, 200],  // Moist
      [0.2, 50, 100, 200],   // Water edge
      [0.5, 20, 60, 180],    // Water
      [1.0, 0, 20, 120],     // Deep water
    ],
  },
  {
    id: 'nbr',
    label: 'NBR (Burn Severity)',
    bandA: 'nir',
    bandB: 'swir16',
    task: 'nbr',
    ramp: [
      [-1.0, 180, 0, 0],     // High severity burn
      [-0.3, 220, 100, 0],   // Moderate burn
      [0.0, 200, 180, 50],   // Low burn
      [0.3, 150, 200, 80],   // Unburned
      [0.6, 80, 180, 50],    // Healthy veg
      [1.0, 20, 100, 20],    // Very healthy
    ],
  },
]

interface StacCogBandsResult {
  bandA: number[]
  bandB: number[]
  width: number
  height: number
  bbox: { west: number; south: number; east: number; north: number }
  sceneId: string
  date: string
  cloudCover: number
  durationMs: number
  error?: string
}

export class BandMathPlugin implements EarthEnginePlugin {
  id = 'band-math'
  name = 'Sentinel-2 Band Math (NDVI/NDWI/NBR)'
  category = 'imagery' as const

  private viewer: Cesium.Viewer | null = null
  private imageryLayer: Cesium.ImageryLayer | null = null
  private status: PluginStats = { count: 0, status: 'disabled' }
  private ipc: typeof window.api | null = null
  private lastBbox: string | null = null
  private lastBboxParsed: { west: number; south: number; east: number; north: number } | null = null
  private currentIndex: BandIndex = 'ndvi'
  private opacity = 0.7
  private startDate = this.defaultDate(-30)
  private endDate = this.defaultDate(0)
  private maxCloud = 20

  private defaultDate(offsetDays: number): string {
    const d = new Date()
    d.setDate(d.getDate() + offsetDays)
    return d.toISOString().split('T')[0]
  }

  async register(ctx: PluginContext): Promise<void> {
    this.viewer = ctx.viewer
    this.ipc = ctx.ipc
    this.status = { count: 0, status: 'nominal' }
  }

  unregister(): void {
    this.removeLayer()
    this.viewer = null
    this.status = { count: 0, status: 'disabled' }
  }

  update(ctx: PluginContext): void {
    const sceneCtx = ctx.sceneContext as any
    const bbox = sceneCtx?.selectionBbox
    if (!bbox) return

    this.lastBboxParsed = bbox
    const bboxKey = `${bbox.west.toFixed(2)},${bbox.south.toFixed(2)},${bbox.east.toFixed(2)},${bbox.north.toFixed(2)}`
    if (bboxKey === this.lastBbox) return
    this.lastBbox = bboxKey

    const height = sceneCtx?.camera?.height
    if (height && height > 500_000) return

    this.runAnalysis(bbox)
  }

  getStats(): PluginStats {
    return this.status
  }

  getControls(): PluginControlSpec[] {
    return [
      { type: 'select', id: 'index', label: 'Index', value: this.currentIndex, options: BAND_SPECS.map((b) => ({ label: b.label, value: b.id })) },
      { type: 'slider', id: 'opacity', label: 'Opacity', value: this.opacity, min: 0, max: 1, step: 0.1 },
      { type: 'slider', id: 'maxCloud', label: 'Max Cloud %', value: this.maxCloud, min: 0, max: 100, step: 5 },
      { type: 'button', id: 'run', label: 'Compute Index', variant: 'primary' },
      { type: 'button', id: 'clear', label: 'Clear', variant: 'danger', disabled: !this.imageryLayer },
      { type: 'separator', id: 'sep1' },
      { type: 'display', id: 'backend', label: 'Backend', value: this.status.error ? 'error' : (this.imageryLayer ? 'active' : 'idle'), color: '#4aff8a' },
    ]
  }

  onControl(id: string, value?: unknown): void {
    if (id === 'index' && typeof value === 'string') {
      this.currentIndex = value as BandIndex
      if (this.lastBboxParsed) { this.lastBbox = null; this.runAnalysis(this.lastBboxParsed) }
    } else if (id === 'opacity' && typeof value === 'number') {
      this.opacity = value
      if (this.imageryLayer) this.imageryLayer.alpha = value
    } else if (id === 'maxCloud' && typeof value === 'number') {
      this.maxCloud = value
    } else if (id === 'run') {
      if (this.lastBboxParsed) { this.lastBbox = null; this.runAnalysis(this.lastBboxParsed) }
    } else if (id === 'clear') {
      this.removeLayer()
      this.lastBbox = null
      this.status = { count: 0, status: 'nominal' }
    }
  }

  clear(): void {
    this.removeLayer()
    this.lastBbox = null
    this.status = { count: 0, status: 'nominal' }
  }

  private async runAnalysis(bbox: { west: number; south: number; east: number; north: number }): Promise<void> {
    if (!this.viewer || !this.ipc) return
    this.status = { ...this.status, status: 'loading' }

    try {
      const spec = BAND_SPECS.find((b) => b.id === this.currentIndex)!

      // Fetch real Sentinel-2 L2A band reflectance from COGs
      const raw = await this.ipc.invoke('stac:cog:bands', {
        west: bbox.west,
        south: bbox.south,
        east: bbox.east,
        north: bbox.north,
        startDate: this.startDate,
        endDate: this.endDate,
        maxCloudCover: this.maxCloud,
        formula: spec.id,
      }) as StacCogBandsResult | null

      if (!raw || raw.error || raw.bandA.length === 0) {
        console.warn('[band-math] failed to fetch STAC/COG bands:', raw?.error)
        this.status = { count: 0, status: 'degraded' }
        return
      }

      const bandAFloat = new Float32Array(raw.bandA)
      const bandBFloat = new Float32Array(raw.bandB)

      // Dispatch band math to compute dispatcher (WebGPU → WASM → CPU)
      const result = await computeDispatcher.dispatch(spec.task, {
        width: raw.width,
        height: raw.height,
        input: bandAFloat,
        input2: bandBFloat,
      })

      if (result.backend === 'noop' || result.output.length === 0) {
        this.status = { count: 0, status: 'degraded' }
        return
      }

      // Color-map the index values to RGBA
      const canvas = this.colorMapToCanvas(result.output, raw.width, raw.height, spec.ramp)
      const blobUrl = await this.canvasToBlobUrl(canvas)

      this.removeLayer()

      const rectangle = Cesium.Rectangle.fromDegrees(raw.bbox.west, raw.bbox.south, raw.bbox.east, raw.bbox.north)
      const provider = new Cesium.SingleTileImageryProvider({
        url: blobUrl,
        rectangle,
        tileWidth: raw.width,
        tileHeight: raw.height,
      })

      this.imageryLayer = this.viewer.imageryLayers.addImageryProvider(provider)
      this.imageryLayer.alpha = this.opacity

      console.log(`[band-math] ${spec.id} computed on ${result.backend} — scene ${raw.sceneId}, ${raw.cloudCover.toFixed(0)}% cloud, ${raw.width}x${raw.height} in ${result.durationMs.toFixed(1)}ms`)
      this.status = { count: 1, status: 'nominal' }
    } catch (err) {
      console.warn('[band-math] analysis failed:', err)
      this.status = { ...this.status, status: 'error', error: String(err) }
    }
  }

  /** Color-map index values (-1 to 1) to RGBA using a color ramp. */
  private colorMapToCanvas(
    data: Float32Array,
    width: number,
    height: number,
    ramp: [number, number, number, number][],
  ): OffscreenCanvas {
    const canvas = new OffscreenCanvas(width, height)
    const ctx = canvas.getContext('2d')!
    const imageData = ctx.createImageData(width, height)

    for (let i = 0; i < data.length; i++) {
      const val = Math.max(-1, Math.min(1, data[i]))
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

  /** Linear interpolation between color ramp stops. */
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

  private async canvasToBlobUrl(canvas: OffscreenCanvas): Promise<string> {
    const blob = await canvas.convertToBlob({ type: 'image/png' })
    return URL.createObjectURL(blob)
  }

  private removeLayer(): void {
    if (this.imageryLayer && this.viewer && !this.viewer.isDestroyed?.()) {
      this.viewer.imageryLayers.remove(this.imageryLayer)
    }
    this.imageryLayer = null
  }
}

export const bandMathPlugin = new BandMathPlugin()
