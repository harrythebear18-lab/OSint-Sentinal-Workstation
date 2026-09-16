/**
 * Anomaly Plugin — terrain anomaly detection (depressions, prominences).
 * Tier 2, Priority 7. From OGOS.
 *
 * Detects terrain features that deviate significantly from the local average
 * (box-blur residuals). Useful for finding:
 *  - Caves, sinkholes, mineshafts, craters (depressions)
 *  - Rock spires, towers, peaks, buildings (prominences)
 *
 * Uses the compute dispatcher for hardware-accelerated anomaly computation.
 * Tries WebGPU first, falls back to CPU worker pool, then legacy IPC.
 */

import * as Cesium from 'cesium'
import type { EarthEnginePlugin, PluginContext, PluginStats, PluginControlSpec } from './plugin-manager'
import type { AnomalyAnalysisResponse, AnomalyZone } from '@shared/types'
import { computeDispatcher } from '../hal/compute-dispatcher'

export class AnomalyPlugin implements EarthEnginePlugin {
  id = 'anomaly'
  name = 'Anomaly Detection (Terrain)'
  category = 'terrain' as const

  private viewer: Cesium.Viewer | null = null
  private dataSource: Cesium.CustomDataSource | null = null
  private ipc: typeof window.api | null = null
  private status: PluginStats = { count: 0, status: 'disabled' }
  private zones: AnomalyZone[] = []
  private lastBbox: string | null = null
  private lastBboxParsed: { west: number; south: number; east: number; north: number } | null = null
  private show = true

  async register(ctx: PluginContext): Promise<void> {
    this.viewer = ctx.viewer
    this.ipc = ctx.ipc
    this.dataSource = new Cesium.CustomDataSource('anomaly')
    ctx.viewer.dataSources.add(this.dataSource)
    this.status = { count: 0, status: 'nominal' }
  }

  unregister(): void {
    if (this.dataSource && this.viewer && !this.viewer.isDestroyed?.()) {
      this.viewer.dataSources.remove(this.dataSource)
    }
    this.dataSource = null
    this.zones = []
    this.lastBbox = null
    this.viewer = null
    this.ipc = null
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
      { type: 'toggle', id: 'visible', label: 'Visible', value: this.show },
      { type: 'button', id: 'run', label: 'Run Analysis', variant: 'primary' },
      { type: 'button', id: 'clear', label: 'Clear', variant: 'danger', disabled: this.zones.length === 0 },
      { type: 'separator', id: 'sep1' },
      { type: 'display', id: 'depressions', label: 'Depressions', value: String(this.zones.filter((z) => z.type === 'depression').length), color: '#4a8aff' },
      { type: 'display', id: 'prominences', label: 'Prominences', value: String(this.zones.filter((z) => z.type === 'prominence').length), color: '#ff8a4a' },
    ]
  }

  onControl(id: string, value?: unknown): void {
    if (id === 'visible' && typeof value === 'boolean') {
      this.show = value
      if (this.dataSource) this.dataSource.show = value
    } else if (id === 'run') {
      if (this.lastBboxParsed) {
        this.lastBbox = null
        this.runAnalysis(this.lastBboxParsed)
      }
    } else if (id === 'clear') {
      this.dataSource?.entities.removeAll()
      this.zones = []
      this.lastBbox = null
      this.status = { count: 0, status: 'nominal' }
    }
  }

  getZones(): AnomalyZone[] {
    return this.zones
  }

  private async runAnalysis(bbox: { west: number; south: number; east: number; north: number }): Promise<void> {
    if (!this.ipc || !this.dataSource) return
    this.status = { ...this.status, status: 'loading' }

    try {
      // ── Path 1: Compute dispatcher (WebGPU → CPU worker → fallback) ──
      const demData = await this.ipc.invoke('terrain:dem:raw', {
        bounds: [{ lng: bbox.west, lat: bbox.south }, { lng: bbox.east, lat: bbox.north }],
      }) as { elev: number[]; width: number; height: number; cellSizeX: number; cellSizeY: number; swLng: number; neLat: number; lngStep: number; latStep: number } | null

      if (demData && demData.elev.length > 0) {
        // Dispatch anomaly computation to best available backend
        const result = await computeDispatcher.dispatch('anomaly', {
          width: demData.width,
          height: demData.height,
          input: new Float32Array(demData.elev),
          params: new Float32Array([5]), // blur radius
        })

        if (result.backend !== 'noop' && result.output.length > 0) {
          // Cluster anomaly zones in the renderer
          const zones = this.clusterAnomalyZones(
            result.output,
            demData.width,
            demData.height,
            demData.cellSizeX,
            demData.swLng,
            demData.neLat,
            demData.lngStep,
            demData.latStep,
          )

          console.log(`[anomaly] computed on ${result.backend} — ${demData.width}x${demData.height} in ${result.durationMs.toFixed(1)}ms, ${zones.length} zones`)

          if (!this.dataSource) { this.status = { count: 0, status: 'nominal' }; return }
          this.dataSource.entities.removeAll()
          this.zones = zones
          for (const zone of zones) this.addZoneEntity(zone)
          this.status = { count: zones.length, status: 'nominal' }
          return
        }
      }

      // ── Path 2: Legacy full-analysis IPC fallback ──
      console.warn('[anomaly] dispatcher path failed, falling back to legacy IPC')
      const result = await this.ipc.invoke('terrain:anomaly:analysis', {
        bounds: [{ lng: bbox.west, lat: bbox.south }, { lng: bbox.east, lat: bbox.north }],
      }) as AnomalyAnalysisResponse | null

      if (!result?.zones) {
        this.status = { count: 0, status: 'nominal' }
        return
      }

      this.zones = result.zones
      if (!this.dataSource) { this.status = { count: 0, status: 'nominal' }; return }
      this.dataSource.entities.removeAll()

      for (const zone of result.zones) {
        this.addZoneEntity(zone)
      }

      this.status = { count: result.zones.length, status: 'nominal' }
    } catch (err) {
      console.warn('[anomaly] analysis failed:', err)
      this.status = { ...this.status, status: 'error', error: String(err) }
    }
  }

  /** Cluster anomaly residuals into zones — pure computation, runs in renderer. */
  private clusterAnomalyZones(
    residuals: Float32Array,
    width: number,
    height: number,
    cellSizeM: number,
    swLng: number,
    neLat: number,
    lngStep: number,
    latStep: number,
  ): AnomalyZone[] {
    // Compute std dev of residuals
    let mean = 0
    for (let i = 0; i < residuals.length; i++) mean += residuals[i]
    mean /= residuals.length
    let variance = 0
    for (let i = 0; i < residuals.length; i++) variance += (residuals[i] - mean) ** 2
    variance /= residuals.length
    const stdDev = Math.sqrt(variance)

    if (stdDev < 0.1) return []

    const threshold = 2.5 * stdDev
    const visited = new Uint8Array(width * height)
    const zones: AnomalyZone[] = []
    let zoneId = 0

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = y * width + x
        if (visited[idx] || Math.abs(residuals[idx]) <= threshold) continue

        const cluster: { x: number; y: number; residual: number }[] = []
        const stack = [{ x, y }]
        while (stack.length > 0) {
          const p = stack.pop()!
          if (p.x < 0 || p.x >= width || p.y < 0 || p.y >= height) continue
          const pidx = p.y * width + p.x
          if (visited[pidx] || Math.abs(residuals[pidx]) <= threshold) continue
          visited[pidx] = 1
          cluster.push({ x: p.x, y: p.y, residual: residuals[pidx] })
          stack.push({ x: p.x + 1, y: p.y }, { x: p.x - 1, y: p.y }, { x: p.x, y: p.y + 1 }, { x: p.x, y: p.y - 1 })
        }

        if (cluster.length < 5) continue
        const minX = Math.min(...cluster.map((c) => c.x))
        const maxX = Math.max(...cluster.map((c) => c.x))
        const minY = Math.min(...cluster.map((c) => c.y))
        const maxY = Math.max(...cluster.map((c) => c.y))
        const avgResidual = cluster.reduce((a, c) => a + c.residual, 0) / cluster.length
        const strength = Math.abs(avgResidual) / stdDev
        const sizeM = Math.max(maxX - minX, maxY - minY) * cellSizeM

        zones.push({
          id: `anomaly-zone-${zoneId++}`,
          coords: [
            { lng: swLng + minX * lngStep, lat: neLat - minY * latStep },
            { lng: swLng + maxX * lngStep, lat: neLat - minY * latStep },
            { lng: swLng + maxX * lngStep, lat: neLat - maxY * latStep },
            { lng: swLng + minX * lngStep, lat: neLat - maxY * latStep },
          ],
          strength,
          type: avgResidual < 0 ? 'depression' : 'prominence',
          sizeM,
        })
      }
    }
    return zones
  }

  private addZoneEntity(zone: AnomalyZone): void {
    if (!this.dataSource || zone.coords.length < 3) return
    const positions = zone.coords.map((c) => Cesium.Cartesian3.fromDegrees(c.lng, c.lat))

    // Depressions = blue (holes, caves, craters)
    // Prominences = orange (spires, towers, peaks)
    const color = zone.type === 'depression'
      ? Cesium.Color.fromBytes(74, 138, 255, 255)
      : Cesium.Color.fromBytes(255, 138, 74, 255)

    // Outline ring only — no fill, so terrain stays visible
    this.dataSource.entities.add({
      id: `anomaly-ring:${zone.id}`,
      polyline: {
        positions: new Cesium.ConstantProperty([...positions, positions[0]]),
        width: new Cesium.ConstantProperty(2.5),
        material: new Cesium.ColorMaterialProperty(color.withAlpha(0.9)),
        clampToGround: true,
      },
      properties: { type: zone.type, strength: zone.strength, sizeM: zone.sizeM },
    } as any)

    // Center marker — small crosshair point so the anomaly is easy to spot
    let cx = 0, cy = 0
    for (const c of zone.coords) { cx += c.lng; cy += c.lat }
    cx /= zone.coords.length
    cy /= zone.coords.length

    this.dataSource.entities.add({
      id: `anomaly-marker:${zone.id}`,
      position: Cesium.Cartesian3.fromDegrees(cx, cy),
      point: {
        pixelSize: new Cesium.ConstantProperty(6),
        color: new Cesium.ConstantProperty(color),
        outlineColor: new Cesium.ConstantProperty(Cesium.Color.WHITE),
        outlineWidth: new Cesium.ConstantProperty(2),
      },
      label: {
        text: zone.type === 'depression' ? 'DEP' : 'PRO',
        font: '9px monospace',
        fillColor: new Cesium.ConstantProperty(color),
        outlineColor: new Cesium.ConstantProperty(Cesium.Color.BLACK),
        outlineWidth: new Cesium.ConstantProperty(2),
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        pixelOffset: new Cesium.Cartesian2(0, -14),
      },
      properties: { type: zone.type, strength: zone.strength, sizeM: zone.sizeM },
    } as any)
  }
}

export const anomalyPlugin = new AnomalyPlugin()
