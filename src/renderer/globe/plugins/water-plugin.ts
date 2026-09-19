/**
 * Water Plugin — OSM water features (streams, rivers, lakes, springs).
 * Tier 1, Priority 4. From OGOS.
 *
 * Fetches water bodies and waterways from OpenStreetMap via Overpass and
 * renders them on the globe:
 *  - Rivers/streams/canals → blue polylines (width scales with type)
 *  - Lakes/ponds/reservoirs → translucent blue polygons
 *  - Springs → point markers
 *  - Wetlands → green-blue polygons
 *
 * Uses the selection bbox as the fetch area. Runs automatically when the
 * bbox changes, or manually via the Fetch button.
 */

import * as Cesium from 'cesium'
import type { EarthEnginePlugin, PluginContext, PluginStats, PluginControlSpec } from './plugin-manager'
import type { WaterResponse, WaterFeature, BBox } from '@shared/types'

const MIN_VISIBLE_ENTITIES = 2000
const MAX_VISIBLE_ENTITIES = 50000

export class WaterPlugin implements EarthEnginePlugin {
  id = 'water'
  name = 'Water (OSM Hydrology)'
  category = 'mapping' as const

  private viewer: Cesium.Viewer | null = null
  private dataSource: Cesium.CustomDataSource | null = null
  private ipc: typeof window.api | null = null
  private status: PluginStats = { count: 0, status: 'disabled' }
  private allFeatures: WaterFeature[] = []
  private lastBbox: string | null = null
  private lastBboxParsed: { west: number; south: number; east: number; north: number } | null = null
  private lastViewBbox: string | null = null
  private show = true
  private lastError: string | null = null

  async register(ctx: PluginContext): Promise<void> {
    this.viewer = ctx.viewer
    this.ipc = ctx.ipc
    this.dataSource = new Cesium.CustomDataSource('water')
    ctx.viewer.dataSources.add(this.dataSource)
    this.status = { count: 0, status: 'nominal' }
  }

  unregister(): void {
    if (this.dataSource && this.viewer && !this.viewer.isDestroyed?.()) {
      this.viewer.dataSources.remove(this.dataSource)
    }
    this.dataSource = null
    this.allFeatures = []
    this.lastBbox = null
    this.lastViewBbox = null
    this.viewer = null
    this.ipc = null
    this.status = { count: 0, status: 'disabled' }
  }

  update(ctx: PluginContext): void {
    const sceneCtx = ctx.sceneContext as any

    // ── Fetch water when selection bbox changes ──
    const selBbox = sceneCtx?.selectionBbox
    if (selBbox) {
      this.lastBboxParsed = selBbox
      const bboxKey = `${selBbox.west.toFixed(2)},${selBbox.south.toFixed(2)},${selBbox.east.toFixed(2)},${selBbox.north.toFixed(2)}`
      if (bboxKey !== this.lastBbox) {
        this.lastBbox = bboxKey
        const height = sceneCtx?.camera?.height
        if (!height || height <= 500_000) {
          this.fetchWater(selBbox)
        }
      }
    }

    // ── Viewport culling: update visible entities on camera move ──
    const viewBbox = sceneCtx?.bbox as BBox | undefined
    if (viewBbox && this.allFeatures.length > 0) {
      const viewKey = `${viewBbox.west.toFixed(3)},${viewBbox.south.toFixed(3)},${viewBbox.east.toFixed(3)},${viewBbox.north.toFixed(3)}`
      if (viewKey !== this.lastViewBbox) {
        this.lastViewBbox = viewKey
        this.cullToViewport(viewBbox)
      }
    }
  }

  getStats(): PluginStats {
    return this.status
  }

  clear(): void {
    this.dataSource?.entities.removeAll()
    this.allFeatures = []
    this.lastBbox = null
    this.lastViewBbox = null
    this.status = { count: 0, status: 'nominal' }
  }

  getControls(): PluginControlSpec[] {
    const rendered = this.dataSource?.entities.values.length ?? 0
    return [
      { type: 'toggle', id: 'visible', label: 'Visible', value: this.show },
      { type: 'button', id: 'run', label: 'Fetch Water', variant: 'primary' },
      { type: 'button', id: 'clear', label: 'Clear', variant: 'danger', disabled: this.allFeatures.length === 0 },
      { type: 'separator', id: 'sep1' },
      { type: 'display', id: 'rivers', label: 'Rivers/Streams', value: String(this.allFeatures.filter((f) => f.type === 'river' || f.type === 'stream').length), color: '#4a8aff' },
      { type: 'display', id: 'lakes', label: 'Lakes/Ponds', value: String(this.allFeatures.filter((f) => f.type === 'lake' || f.type === 'pond' || f.type === 'reservoir').length), color: '#4affd4' },
      { type: 'display', id: 'springs', label: 'Springs', value: String(this.allFeatures.filter((f) => f.type === 'spring').length), color: '#4aff8a' },
      { type: 'display', id: 'rendered', label: 'Rendered', value: String(rendered), color: '#4affd4' },
      ...(this.lastError ? [{ type: 'display' as const, id: 'error', label: 'Error', value: this.lastError.slice(0, 60), color: '#ff4a4a' }] : []),
    ]
  }

  onControl(id: string, value?: unknown): void {
    if (id === 'visible' && typeof value === 'boolean') {
      this.show = value
      if (this.dataSource) this.dataSource.show = value
    } else if (id === 'run') {
      if (this.lastBboxParsed) {
        this.lastBbox = null
        this.fetchWater(this.lastBboxParsed)
      }
    } else if (id === 'clear') {
      this.dataSource?.entities.removeAll()
      this.allFeatures = []
      this.lastBbox = null
      this.lastViewBbox = null
      this.status = { count: 0, status: 'nominal' }
    }
  }

  getFeatures(): WaterFeature[] {
    return this.allFeatures
  }

  private async fetchWater(bbox: { west: number; south: number; east: number; north: number }): Promise<void> {
    if (!this.ipc || !this.dataSource) return
    this.status = { ...this.status, status: 'loading' }

    try {
      const result = await this.ipc.invoke('terrain:water:fetch', {
        bounds: [{ lng: bbox.west, lat: bbox.south }, { lng: bbox.east, lat: bbox.north }],
      }) as WaterResponse | null

      if (!result?.features) {
        this.status = { count: 0, status: 'nominal' }
        return
      }

      this.allFeatures = result.features.slice(0, MAX_VISIBLE_ENTITIES)
      this.lastError = result.error ?? null
      this.dataSource.entities.removeAll()
      this.lastViewBbox = null  // force re-cull

      // Initial cull using the fetch bbox as viewport
      this.cullToViewport({
        west: bbox.west, south: bbox.south, east: bbox.east, north: bbox.north,
      })

      this.status = { count: result.features.length, status: 'nominal' }
    } catch (err) {
      console.warn('[water] fetch failed:', err)
      this.status = { ...this.status, status: 'error', error: String(err) }
    }
  }

  /** Cull features to viewport bbox — diff-based to avoid flicker. */
  private cullToViewport(viewBbox: BBox): void {
    if (!this.dataSource) return

    // Dynamic cap: more entities when zoomed out (large viewport shows
    // more area, needs higher cap), fewer when zoomed in (small viewport
    // naturally limits count via bbox intersection). The cap is just a
    // safety valve — the viewport culling does the real limiting.
    const camHeight = this.viewer?.camera?.positionCartographic?.height ?? 50000
    const maxEntities = camHeight > 1_000_000 ? MAX_VISIBLE_ENTITIES
      : camHeight > 200_000 ? 20000
      : camHeight > 50_000 ? 12000
      : 8000

    const visibleIds = new Set<string>()
    const toAdd: WaterFeature[] = []
    let count = 0

    for (const f of this.allFeatures) {
      if (count >= maxEntities) break
      if (this.featureIntersectsBbox(f, viewBbox)) {
        visibleIds.add(f.id)
        if (!this.dataSource.entities.getById(`water:${f.id}`)) {
          toAdd.push(f)
        }
        count++
      }
    }

    // Remove entities no longer visible
    const toRemove: string[] = []
    const existing = this.dataSource.entities.values
    for (let i = 0; i < existing.length; i++) {
      const e = existing[i]
      const featId = e.id.startsWith('water:') ? e.id.slice(6) : e.id
      if (!visibleIds.has(featId)) {
        toRemove.push(e.id)
      }
    }
    for (const id of toRemove) {
      this.dataSource.entities.removeById(id)
    }

    // Add new entities
    for (const f of toAdd) {
      this.addWaterEntity(f)
    }

    this.dataSource.show = this.show
    if (toAdd.length > 0 || toRemove.length > 0) {
      try { this.viewer?.scene.requestRender() } catch {}
    }
  }

  /** Quick bbox intersection test. */
  private featureIntersectsBbox(f: WaterFeature, bbox: BBox): boolean {
    for (const c of f.coords) {
      if (c.lng >= bbox.west && c.lng <= bbox.east && c.lat >= bbox.south && c.lat <= bbox.north) {
        return true
      }
    }
    return false
  }

  private addWaterEntity(f: WaterFeature): void {
    if (!this.dataSource || f.coords.length === 0) return

    if (f.type === 'stream' || f.type === 'river') {
      // Linear waterways → polylines
      if (f.coords.length < 2) return
      const positions = f.coords.map((c) => Cesium.Cartesian3.fromDegrees(c.lng, c.lat))
      const width = f.type === 'river' ? 3 : 1.5
      const color = f.type === 'river'
        ? Cesium.Color.fromBytes(74, 138, 255, 220)
        : Cesium.Color.fromBytes(74, 180, 255, 200)

      this.dataSource.entities.add({
        id: `water:${f.id}`,
        polyline: {
          positions: new Cesium.ConstantProperty(positions),
          width: new Cesium.ConstantProperty(width),
          material: new Cesium.ColorMaterialProperty(color),
          clampToGround: true,
        },
        properties: { type: f.type, name: f.name },
      } as any)
    } else if (f.type === 'lake' || f.type === 'pond' || f.type === 'reservoir' || f.type === 'wetland') {
      // Area water bodies → polygons
      if (f.coords.length < 3) return
      const positions = f.coords.map((c) => Cesium.Cartesian3.fromDegrees(c.lng, c.lat))
      const color = f.type === 'wetland'
        ? Cesium.Color.fromBytes(74, 200, 120, 120)
        : Cesium.Color.fromBytes(74, 138, 255, 140)

      this.dataSource.entities.add({
        id: `water:${f.id}`,
        polygon: {
          hierarchy: new Cesium.PolygonHierarchy(positions),
          material: new Cesium.ColorMaterialProperty(color),
          outline: true,
          outlineColor: new Cesium.ConstantProperty(color.withAlpha(0.8)),
        },
        properties: { type: f.type, name: f.name },
      } as any)
    } else if (f.type === 'spring') {
      // Point water feature → point marker
      const c = f.coords[0]
      this.dataSource.entities.add({
        id: `water:${f.id}`,
        position: Cesium.Cartesian3.fromDegrees(c.lng, c.lat),
        point: {
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          pixelSize: 8,
          color: new Cesium.ConstantProperty(Cesium.Color.fromBytes(74, 255, 138, 255)),
          outlineColor: new Cesium.ConstantProperty(Cesium.Color.WHITE),
          outlineWidth: new Cesium.ConstantProperty(2),
        },
        label: f.name ? {
          text: f.name,
          font: '10px sans-serif',
          fillColor: new Cesium.ConstantProperty(Cesium.Color.fromBytes(74, 255, 138, 255)),
          outlineColor: new Cesium.ConstantProperty(Cesium.Color.BLACK),
          outlineWidth: new Cesium.ConstantProperty(2),
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          pixelOffset: new Cesium.Cartesian2(0, -14),
        } : undefined,
        properties: { type: f.type, name: f.name },
      } as any)
    }
  }
}

export const waterPlugin = new WaterPlugin()
