/**
 * Roads Plugin — OSM vector road/trail network overlay.
 * Tier 1, Priority 5. From OGOS.
 *
 * Fetches roads, paths, and trails from OpenStreetMap via Overpass and
 * renders them as colored polylines on the globe. Road type determines
 * color and width:
 *  - motorway/trunk/primary/secondary/tertiary  → thick yellow (roads)
 *  - residential/unclassified/service           → medium orange (streets)
 *  - path/footway/cycleway/track/bridleway      → thin green (trails)
 *  - steps/pedestrian                           → thin white (paths)
 *
 * Viewport culling: only segments within the current camera view are
 * rendered as Cesium entities. As the camera pans/zooms, entities are
 * dynamically added/removed. This keeps GPU memory bounded regardless
 * of bbox size — 50k roads in data, only ~1-2k rendered at any time.
 */

import * as Cesium from 'cesium'
import type { EarthEnginePlugin, PluginContext, PluginStats, PluginControlSpec } from './plugin-manager'
import type { RoadResponse, RoadSegment, BBox } from '@shared/types'

const MIN_VISIBLE_ENTITIES = 2000
const MAX_VISIBLE_ENTITIES = 50000

export class RoadsPlugin implements EarthEnginePlugin {
  id = 'roads'
  name = 'Roads (OSM Vector Network)'
  category = 'mapping' as const

  private viewer: Cesium.Viewer | null = null
  private dataSource: Cesium.CustomDataSource | null = null
  private ipc: typeof window.api | null = null
  private status: PluginStats = { count: 0, status: 'disabled' }
  private allSegments: RoadSegment[] = []
  private lastBbox: string | null = null
  private lastBboxParsed: { west: number; south: number; east: number; north: number } | null = null
  private lastViewBbox: string | null = null
  private visible = true

  async register(ctx: PluginContext): Promise<void> {
    this.viewer = ctx.viewer
    this.ipc = ctx.ipc
    this.dataSource = new Cesium.CustomDataSource('roads')
    ctx.viewer.dataSources.add(this.dataSource)
    this.status = { count: 0, status: 'nominal' }
  }

  unregister(): void {
    if (this.dataSource && this.viewer && !this.viewer.isDestroyed?.()) {
      this.viewer.dataSources.remove(this.dataSource)
    }
    this.dataSource = null
    this.allSegments = []
    this.lastBbox = null
    this.lastViewBbox = null
    this.viewer = null
    this.ipc = null
    this.status = { count: 0, status: 'disabled' }
  }

  update(ctx: PluginContext): void {
    const sceneCtx = ctx.sceneContext as any

    // ── Fetch roads when selection bbox changes ──
    const selBbox = sceneCtx?.selectionBbox
    if (selBbox) {
      this.lastBboxParsed = selBbox
      const bboxKey = `${selBbox.west.toFixed(2)},${selBbox.south.toFixed(2)},${selBbox.east.toFixed(2)},${selBbox.north.toFixed(2)}`
      if (bboxKey !== this.lastBbox) {
        this.lastBbox = bboxKey
        const height = sceneCtx?.camera?.height
        if (!height || height <= 500_000) {
          this.fetchRoads(selBbox)
        }
      }
    }

    // ── Viewport culling: update visible entities on camera move ──
    const viewBbox = sceneCtx?.bbox as BBox | undefined
    if (viewBbox && this.allSegments.length > 0) {
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
    this.allSegments = []
    this.lastBbox = null
    this.lastViewBbox = null
    this.status = { count: 0, status: 'nominal' }
  }

  getControls(): PluginControlSpec[] {
    const rendered = this.dataSource?.entities.values.length ?? 0
    return [
      { type: 'toggle', id: 'visible', label: 'Visible', value: this.visible },
      { type: 'button', id: 'run', label: 'Fetch Roads', variant: 'primary' },
      { type: 'button', id: 'clear', label: 'Clear', variant: 'danger', disabled: this.allSegments.length === 0 },
      { type: 'separator', id: 'sep1' },
      { type: 'display', id: 'total', label: 'Total Segments', value: String(this.allSegments.length), color: '#ffd24a' },
      { type: 'display', id: 'rendered', label: 'Rendered', value: String(rendered), color: '#4aff8a' },
    ]
  }

  onControl(id: string, value?: unknown): void {
    if (id === 'visible' && typeof value === 'boolean') {
      this.visible = value
      if (this.dataSource) this.dataSource.show = value
    } else if (id === 'run') {
      if (this.lastBboxParsed) {
        this.lastBbox = null
        this.fetchRoads(this.lastBboxParsed)
      }
    } else if (id === 'clear') {
      this.dataSource?.entities.removeAll()
      this.allSegments = []
      this.lastBbox = null
      this.lastViewBbox = null
      this.status = { count: 0, status: 'nominal' }
    }
  }

  getSegments(): RoadSegment[] {
    return this.allSegments
  }

  private async fetchRoads(bbox: { west: number; south: number; east: number; north: number }): Promise<void> {
    if (!this.ipc || !this.dataSource) return
    this.status = { ...this.status, status: 'loading' }

    try {
      const result = await this.ipc.invoke('terrain:road:fetch', {
        bounds: [{ lng: bbox.west, lat: bbox.south }, { lng: bbox.east, lat: bbox.north }],
      }) as RoadResponse | null

      if (!result?.segments) {
        this.status = { count: 0, status: 'nominal' }
        return
      }

      this.allSegments = result.segments.slice(0, MAX_VISIBLE_ENTITIES)
      this.dataSource.entities.removeAll()
      this.lastViewBbox = null  // force re-cull

      // Initial cull — if we have a viewport bbox, use it; else render a capped subset
      if (this.lastBboxParsed) {
        this.cullToViewport({
          west: bbox.west, south: bbox.south, east: bbox.east, north: bbox.north,
        })
      }

      this.status = { count: result.segments.length, status: 'nominal' }
    } catch (err) {
      console.warn('[roads] fetch failed:', err)
      this.status = { ...this.status, status: 'error', error: String(err) }
    }
  }

  /** Cull segments to viewport bbox — diff-based to avoid flicker. */
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

    // Build set of segment IDs that should be visible
    const visibleIds = new Set<string>()
    const toAdd: RoadSegment[] = []
    let count = 0

    for (const seg of this.allSegments) {
      if (count >= maxEntities) break
      if (this.segmentIntersectsBbox(seg, viewBbox)) {
        visibleIds.add(seg.id)
        // Only add if not already rendered
        if (!this.dataSource.entities.getById(`road:${seg.id}`)) {
          toAdd.push(seg)
        }
        count++
      }
    }

    // Remove entities that are no longer visible
    const toRemove: string[] = []
    const existing = this.dataSource.entities.values
    for (let i = 0; i < existing.length; i++) {
      const e = existing[i]
      const segId = e.id.startsWith('road:') ? e.id.slice(5) : e.id
      if (!visibleIds.has(segId)) {
        toRemove.push(e.id)
      }
    }
    for (const id of toRemove) {
      this.dataSource.entities.removeById(id)
    }

    // Add new entities
    for (const seg of toAdd) {
      this.addRoadEntity(seg)
    }

    this.dataSource.show = this.visible
    if (toAdd.length > 0 || toRemove.length > 0) {
      try { this.viewer?.scene.requestRender() } catch {}
    }
  }

  /** Quick bbox intersection test — check if any coord falls within the bbox. */
  private segmentIntersectsBbox(seg: RoadSegment, bbox: BBox): boolean {
    for (const c of seg.coords) {
      if (c.lng >= bbox.west && c.lng <= bbox.east && c.lat >= bbox.south && c.lat <= bbox.north) {
        return true
      }
    }
    return false
  }

  private addRoadEntity(seg: RoadSegment): void {
    if (!this.dataSource || seg.coords.length < 2) return
    const positions = seg.coords.map((c) => Cesium.Cartesian3.fromDegrees(c.lng, c.lat))

    const { color, width } = this.roadStyle(seg.highwayType)

    this.dataSource.entities.add({
      id: `road:${seg.id}`,
      polyline: {
        positions: new Cesium.ConstantProperty(positions),
        width: new Cesium.ConstantProperty(width),
        material: new Cesium.ColorMaterialProperty(color),
        clampToGround: true,
      },
      properties: { highwayType: seg.highwayType, name: seg.name },
    } as any)
  }

  private roadStyle(highwayType: string): { color: Cesium.Color; width: number } {
    const t = highwayType
    if (['motorway', 'trunk', 'primary', 'secondary', 'tertiary'].includes(t)) {
      return { color: Cesium.Color.fromBytes(255, 210, 74, 230), width: 4 }   // yellow — roads
    }
    if (['residential', 'unclassified', 'service', 'living_street', 'pedestrian'].includes(t)) {
      return { color: Cesium.Color.fromBytes(255, 160, 74, 200), width: 2.5 } // orange — streets
    }
    if (['path', 'footway', 'cycleway', 'track', 'bridleway'].includes(t)) {
      return { color: Cesium.Color.fromBytes(120, 220, 120, 200), width: 2 } // green — trails
    }
    if (['steps', 'corridor'].includes(t)) {
      return { color: Cesium.Color.fromBytes(220, 220, 220, 180), width: 1.5 } // white — paths
    }
    return { color: Cesium.Color.fromBytes(180, 180, 180, 160), width: 1.5 }   // gray — other
  }
}

export const roadsPlugin = new RoadsPlugin()
