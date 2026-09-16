/**
 * Rest Points Plugin — Behavior-model rest-point scoring.
 * Tier 5, Priority 16. From OGOS.
 *
 * Scores potential rest points based on slope, water, shelter, distance, trails.
 * Renders as colored points with score-based sizing.
 */

import * as Cesium from 'cesium'
import type { EarthEnginePlugin, PluginContext, PluginStats, PluginControlSpec } from './plugin-manager'
import type { RestPoint, RestPointsResponse } from '@shared/types'

export class RestPointsPlugin implements EarthEnginePlugin {
  id = 'rest-points'
  name = 'Rest Points (Shelter Scoring)'
  category = 'mission' as const

  private viewer: Cesium.Viewer | null = null
  private dataSource: Cesium.CustomDataSource | null = null
  private ipc: typeof window.api | null = null
  private status: PluginStats = { count: 0, status: 'disabled' }
  private points: RestPoint[] = []
  private lastBbox: string | null = null
  private lastBboxParsed: { west: number; south: number; east: number; north: number } | null = null

  async register(ctx: PluginContext): Promise<void> {
    this.viewer = ctx.viewer
    this.ipc = ctx.ipc
    this.dataSource = new Cesium.CustomDataSource('rest-points')
    ctx.viewer.dataSources.add(this.dataSource)
    this.status = { count: 0, status: 'nominal' }
  }

  unregister(): void {
    if (this.dataSource && this.viewer && !this.viewer.isDestroyed?.()) {
      this.viewer.dataSources.remove(this.dataSource)
    }
    this.dataSource = null
    this.points = []
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
      { type: 'button', id: 'run', label: 'Run Analysis', variant: 'primary' },
      { type: 'button', id: 'clear', label: 'Clear', variant: 'danger', disabled: this.points.length === 0 },
      { type: 'separator', id: 'sep1' },
      { type: 'display', id: 'points', label: 'Candidates', value: String(this.points.length), color: '#4aff8a' },
    ]
  }

  onControl(id: string): void {
    if (id === 'run') {
      if (this.lastBboxParsed) {
        this.lastBbox = null  // force re-run
        this.runAnalysis(this.lastBboxParsed)
      }
    } else if (id === 'clear') {
      this.dataSource?.entities.removeAll()
      this.points = []
      this.lastBbox = null
      this.status = { count: 0, status: 'nominal' }
    }
  }

  getPoints(): RestPoint[] {
    return this.points
  }

  private async runAnalysis(bbox: { west: number; south: number; east: number; north: number }): Promise<void> {
    if (!this.ipc || !this.dataSource) return
    this.status = { ...this.status, status: 'loading' }

    try {
      // Service requires lkp for scoring — use bbox center as LKP
      const lkp = {
        lng: (bbox.west + bbox.east) / 2,
        lat: (bbox.south + bbox.north) / 2,
      }
      const result = await this.ipc.invoke('terrain:rest:points', {
        lkp,
        bounds: [{ lng: bbox.west, lat: bbox.south }, { lng: bbox.east, lat: bbox.north }],
      }) as RestPointsResponse | null

      if (!result?.points) {
        this.status = { count: 0, status: 'nominal' }
        return
      }

      this.points = result.points
      this.dataSource.entities.removeAll()

      for (const p of result.points) {
        this.addPointEntity(p)
      }

      this.status = { count: result.points.length, status: 'nominal' }
    } catch (err) {
      this.status = { ...this.status, status: 'error', error: String(err) }
    }
  }

  private addPointEntity(p: RestPoint): void {
    if (!this.dataSource) return

    // Score color: 1.0 = green (good), 0.5 = yellow, 0.0 = red (poor)
    const t = p.score
    const color = Cesium.Color.fromBytes(
      Math.round(255 * (1 - t)),
      Math.round(200 * t),
      Math.round(74 * t),
      255,
    )

    const pixelSize = Math.max(6, Math.min(14, 6 + t * 8))

    this.dataSource.entities.add({
      id: `rest:${p.id}`,
      position: Cesium.Cartesian3.fromDegrees(p.lng, p.lat),
      point: {
        pixelSize,
        color: new Cesium.ConstantProperty(color),
        outlineColor: new Cesium.ConstantProperty(Cesium.Color.WHITE.withAlpha(0.6)),
        outlineWidth: new Cesium.ConstantProperty(1),
      },
      properties: {
        score: p.score,
        reasons: p.reasons,
      },
    } as any)
  }
}

export const restPointsPlugin = new RestPointsPlugin()
