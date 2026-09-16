/**
 * Hillshade Plugin — DEM-derived hillshade overlay.
 * Tier 1, Priority 3b. Computes terrain hillshade and renders it as
 * a Cesium imagery layer over the selection bbox.
 *
 * Uses the compute dispatcher for hardware-accelerated hillshade:
 *   1. WebGPU `dem-hillshade` kernel (GPU — thousands of cores)
 *   2. CPU worker pool (`dem-hillshade.worker.js` — real OS thread)
 *   3. Fallback to Cesium's built-in scene lighting
 *
 * The hillshade is computed from the same DEM Terrarium tiles used by
 * the slope plugin. The result is a grayscale image (0-255) overlaid
 * semi-transparently on the globe.
 */

import * as Cesium from 'cesium'
import type { EarthEnginePlugin, PluginContext, PluginStats, PluginControlSpec } from './plugin-manager'
import { computeDispatcher } from '../hal/compute-dispatcher'

export class HillshadePlugin implements EarthEnginePlugin {
  id = 'hillshade'
  name = 'Hillshade (DEM Compute)'
  category = 'terrain' as const

  private viewer: Cesium.Viewer | null = null
  private imageryLayer: Cesium.ImageryLayer | null = null
  private status: PluginStats = { count: 0, status: 'disabled' }
  private lastBbox: string | null = null
  private lastBboxParsed: { west: number; south: number; east: number; north: number } | null = null
  private ipc: typeof window.api | null = null
  private azimuth = 315 // sun azimuth in degrees
  private altitude = 45  // sun altitude in degrees
  private opacity = 0.6

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

    // Only run when zoomed in enough
    const height = sceneCtx?.camera?.height
    if (height && height > 500_000) return

    this.runAnalysis(bbox)
  }

  getStats(): PluginStats {
    return this.status
  }

  getControls(): PluginControlSpec[] {
    return [
      { type: 'slider', id: 'azimuth', label: 'Sun Azimuth', value: this.azimuth, min: 0, max: 360, step: 5, unit: '°' },
      { type: 'slider', id: 'altitude', label: 'Sun Altitude', value: this.altitude, min: 0, max: 90, step: 5, unit: '°' },
      { type: 'slider', id: 'opacity', label: 'Opacity', value: this.opacity, min: 0, max: 1, step: 0.1 },
      { type: 'button', id: 'run', label: 'Run Hillshade', variant: 'primary' },
      { type: 'button', id: 'clear', label: 'Clear', variant: 'danger', disabled: !this.imageryLayer },
      { type: 'separator', id: 'sep1' },
      { type: 'display', id: 'backend', label: 'Backend', value: this.status.error ? 'error' : (this.imageryLayer ? 'active' : 'idle'), color: '#4aff8a' },
    ]
  }

  onControl(id: string, value?: unknown): void {
    if (id === 'azimuth' && typeof value === 'number') {
      this.azimuth = value
      if (this.lastBboxParsed) { this.lastBbox = null; this.runAnalysis(this.lastBboxParsed) }
    } else if (id === 'altitude' && typeof value === 'number') {
      this.altitude = value
      if (this.lastBboxParsed) { this.lastBbox = null; this.runAnalysis(this.lastBboxParsed) }
    } else if (id === 'opacity' && typeof value === 'number') {
      this.opacity = value
      if (this.imageryLayer) this.imageryLayer.alpha = value
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
      // Fetch raw DEM data
      const demData = await this.ipc.invoke('terrain:dem:raw', {
        bounds: [{ lng: bbox.west, lat: bbox.south }, { lng: bbox.east, lat: bbox.north }],
      }) as { elev: number[]; width: number; height: number; cellSizeX: number; cellSizeY: number } | null

      if (!demData || !demData.elev.length) {
        this.status = { count: 0, status: 'nominal' }
        return
      }

      // Dispatch hillshade computation
      // Dispatcher converts degrees → radians for WebGPU and CPU worker backends
      const result = await computeDispatcher.dispatch('hillshade', {
        width: demData.width,
        height: demData.height,
        input: new Float32Array(demData.elev),
        cellSizeX: demData.cellSizeX,
        cellSizeY: demData.cellSizeY,
        params: new Float32Array([this.azimuth, this.altitude]),
      })

      if (result.backend === 'noop' || result.output.length === 0) {
        console.warn('[hillshade] no compute backend available')
        this.status = { count: 0, status: 'degraded' }
        return
      }

      // Convert hillshade Float32Array (0-255) to canvas → imagery layer
      const canvas = this.hillshadeToCanvas(result.output, demData.width, demData.height)
      const blobUrl = await this.canvasToBlobUrl(canvas)

      // Remove old layer
      this.removeLayer()

      // Add new imagery layer positioned over the bbox
      const rectangle = Cesium.Rectangle.fromDegrees(bbox.west, bbox.south, bbox.east, bbox.north)
      const provider = new Cesium.SingleTileImageryProvider({
        url: blobUrl,
        rectangle,
        tileWidth: demData.width,
        tileHeight: demData.height,
      })

      this.imageryLayer = this.viewer.imageryLayers.addImageryProvider(provider)
      this.imageryLayer.alpha = this.opacity

      console.log(`[hillshade] computed on ${result.backend} — ${demData.width}x${demData.height} in ${result.durationMs.toFixed(1)}ms`)
      this.status = { count: 1, status: 'nominal' }
    } catch (err) {
      console.warn('[hillshade] analysis failed:', err)
      this.status = { ...this.status, status: 'error', error: String(err) }
    }
  }

  /** Convert hillshade Float32Array (0-255) to an OffscreenCanvas. */
  private hillshadeToCanvas(data: Float32Array, width: number, height: number): OffscreenCanvas {
    const canvas = new OffscreenCanvas(width, height)
    const ctx = canvas.getContext('2d')!
    const imageData = ctx.createImageData(width, height)

    for (let i = 0; i < data.length; i++) {
      const v = Math.max(0, Math.min(255, data[i]))
      const idx = i * 4
      imageData.data[idx] = v      // R
      imageData.data[idx + 1] = v  // G
      imageData.data[idx + 2] = v  // B
      imageData.data[idx + 3] = 255 // A
    }

    ctx.putImageData(imageData, 0, 0)
    return canvas
  }

  /** Convert OffscreenCanvas to a blob URL for Cesium SingleTileImageryProvider. */
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

export const hillshadePlugin = new HillshadePlugin()
