/**
 * Canopy Plugin — Vegetation intelligence.
 * Tier 2, Priority 6. NDVI, biome lookup, pseudo-LiDAR ground correction.
 *
 * Renders canopy height/NDVI as colored polygon overlays via IPC.
 * Used for movement prediction, hazard assessment, and SAR visibility.
 */

import * as Cesium from 'cesium'
import type { EarthEnginePlugin, PluginContext, PluginStats, PluginControlSpec } from './plugin-manager'
import type { CanopyAnalysisResponse } from '@shared/types'

type CanopyZone = CanopyAnalysisResponse['zones'][number]

export class CanopyPlugin implements EarthEnginePlugin {
  id = 'canopy'
  name = 'Canopy / Vegetation'
  category = 'imagery' as const

  private viewer: Cesium.Viewer | null = null
  private dataSource: Cesium.CustomDataSource | null = null
  private ipc: typeof window.api | null = null
  private status: PluginStats = { count: 0, status: 'disabled' }
  private lastBbox: string | null = null
  private lastBboxParsed: { west: number; south: number; east: number; north: number } | null = null
  private cells: CanopyZone[] = []
  private showNdvi = true
  private showHeight = false
  private ndviCounts = { denseForest: 0, forest: 0, openForest: 0, shrubland: 0, grassland: 0, barren: 0, water: 0 }

  async register(ctx: PluginContext): Promise<void> {
    this.viewer = ctx.viewer
    this.ipc = ctx.ipc
    this.dataSource = new Cesium.CustomDataSource('canopy')
    ctx.viewer.dataSources.add(this.dataSource)
    this.status = { count: 0, status: 'nominal' }
  }

  unregister(): void {
    if (this.dataSource && this.viewer && !this.viewer.isDestroyed?.()) {
      this.viewer.dataSources.remove(this.dataSource)
    }
    this.dataSource = null
    this.cells = []
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
      { type: 'button', id: 'run', label: 'Run Analysis', variant: 'primary', disabled: !this.lastBboxParsed },
      { type: 'button', id: 'clear', label: 'Clear', variant: 'danger', disabled: this.cells.length === 0 },
      { type: 'separator', id: 'sep1' },
      { type: 'display', id: 'cells', label: 'Zones', value: String(this.cells.length), color: '#4aff8a' },
      { type: 'display', id: 'denseForest', label: 'Dense Forest', value: String(this.ndviCounts.denseForest), color: '#0a4a0a' },
      { type: 'display', id: 'forest', label: 'Forest', value: String(this.ndviCounts.forest), color: '#2a6a2a' },
      { type: 'display', id: 'openForest', label: 'Open Forest', value: String(this.ndviCounts.openForest), color: '#4a8a4a' },
      { type: 'display', id: 'shrubland', label: 'Shrubland', value: String(this.ndviCounts.shrubland), color: '#8a8a4a' },
      { type: 'display', id: 'grassland', label: 'Grassland', value: String(this.ndviCounts.grassland), color: '#caca4a' },
      { type: 'display', id: 'barren', label: 'Barren', value: String(this.ndviCounts.barren), color: '#ca8a4a' },
      { type: 'display', id: 'water', label: 'Water', value: String(this.ndviCounts.water), color: '#4a8aca' },
    ]
  }

  onControl(id: string, value?: unknown): void {
    if (id === 'run') {
      if (this.lastBboxParsed) {
        this.lastBbox = null  // force re-run
        this.runAnalysis(this.lastBboxParsed)
      }
    } else if (id === 'clear') {
      this.dataSource?.entities.removeAll()
      this.cells = []
      this.lastBbox = null
      this.status = { count: 0, status: 'nominal' }
    }
  }

  private rerender(): void {
    if (!this.dataSource) return
    this.dataSource.entities.removeAll()
    for (const zone of this.cells) {
      this.addZoneEntity(zone)
    }
  }

  private async runAnalysis(bbox: { west: number; south: number; east: number; north: number }): Promise<void> {
    if (!this.ipc || !this.dataSource) return
    this.status = { ...this.status, status: 'loading' }

    try {
      const result = await this.ipc.invoke('terrain:canopy:analysis', {
        bounds: [{ lng: bbox.west, lat: bbox.south }, { lng: bbox.east, lat: bbox.north }],
      }) as CanopyAnalysisResponse | null

      if (!result?.zones) {
        this.status = { count: 0, status: 'nominal' }
        return
      }

      this.cells = result.zones
      if (!this.dataSource) { this.status = { count: 0, status: 'nominal' }; return }
      this.dataSource.entities.removeAll()

      // Count zone types
      this.ndviCounts = { denseForest: 0, forest: 0, openForest: 0, shrubland: 0, grassland: 0, barren: 0, water: 0 }
      for (const zone of result.zones) {
        this.addZoneEntity(zone)
        switch (zone.type) {
          case 'dense-forest': this.ndviCounts.denseForest++; break
          case 'forest': this.ndviCounts.forest++; break
          case 'open-forest': this.ndviCounts.openForest++; break
          case 'shrubland': this.ndviCounts.shrubland++; break
          case 'grassland': this.ndviCounts.grassland++; break
          case 'barren': this.ndviCounts.barren++; break
          case 'water': this.ndviCounts.water++; break
        }
      }

      this.status = { count: result.zones.length, status: 'nominal' }
    } catch (err) {
      this.status = { ...this.status, status: 'error', error: String(err) }
      console.warn('[canopy] analysis failed:', err)
    }
  }

  private addZoneEntity(zone: CanopyZone): void {
    if (!this.dataSource || zone.coords.length < 3) return

    const positions = zone.coords.map((c) => Cesium.Cartesian3.fromDegrees(c.lng, c.lat))

    // Color by NDVI: healthy forest = green, defoliation/clearing = red/orange
    const color = this.ndviColor(zone.avgNdvi)

    this.dataSource.entities.add({
      id: `canopy:${zone.id}`,
      polygon: {
        hierarchy: new Cesium.PolygonHierarchy(positions),
        material: new Cesium.ColorMaterialProperty(color.withAlpha(0.5)),
      },
      properties: {
        type: zone.type,
        avgNdvi: zone.avgNdvi,
        severity: zone.severity,
      },
    } as any)
  }

  private ndviColor(ndvi: number): Cesium.Color {
    // NDVI: -1 to 1. Map to vegetation colors.
    const v = Math.max(-1, Math.min(1, ndvi))
    if (v < 0) {
      // Water: deep blue to shallow blue
      const t = (v + 1) / 1 // 0 to 1
      return Cesium.Color.fromBytes(
        Math.round(30 + (74 - 30) * t),
        Math.round(60 + (138 - 60) * t),
        Math.round(160 + (255 - 160) * t),
        255,
      )
    }
    if (v < 0.1) {
      // Barren: brown
      return Cesium.Color.fromBytes(180, 140, 80, 255)
    }
    if (v < 0.2) {
      // Grassland: yellow-green
      return Cesium.Color.fromBytes(200, 190, 80, 255)
    }
    if (v < 0.35) {
      // Shrubland: olive
      return Cesium.Color.fromBytes(140, 150, 60, 255)
    }
    if (v < 0.5) {
      // Open forest: medium green
      return Cesium.Color.fromBytes(80, 140, 60, 255)
    }
    if (v < 0.7) {
      // Forest: dark green
      return Cesium.Color.fromBytes(40, 100, 40, 255)
    }
    // Dense forest: very dark green
    return Cesium.Color.fromBytes(20, 60, 20, 255)
  }
}

export const canopyPlugin = new CanopyPlugin()
