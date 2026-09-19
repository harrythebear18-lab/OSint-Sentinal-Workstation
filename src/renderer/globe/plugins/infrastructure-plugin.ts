/**
 * Infrastructure Plugin — airports, power plants, substations, generators,
 * transformers, monitoring stations, lighthouses, navigation buoys, weather
 * stations, and transmission towers from OpenStreetMap via Overpass.
 *
 * Bbox-scoped fetch (like water/roads), not push-based. Fetches automatically
 * when the viewport bbox changes at a reasonable zoom, or manually via the
 * Fetch button. Renders:
 *  - Airports / power plants → polygon footprint + centroid point + label
 *  - Substations / generators / transformers / towers → colored points
 *  - Monitoring stations / lighthouses / buoys / weather stations → points
 *
 * All entities are clickable and surface their OSM tags in the inspector.
 */

import * as Cesium from 'cesium'
import type { EarthEnginePlugin, PluginContext, PluginStats, PluginControlSpec } from './plugin-manager'
import type { WorldOverlay } from '../WorldOverlay'
import type { InfrastructureFeature, InfrastructureResponse, InfrastructureType, BBox, LngLat } from '@shared/types'

const MAX_VISIBLE_ENTITIES = 20000

const TYPE_COLORS: Record<InfrastructureType, Cesium.Color> = {
  airport: Cesium.Color.fromBytes(74, 158, 255, 255),
  helipad: Cesium.Color.fromBytes(120, 180, 255, 255),
  power_plant: Cesium.Color.fromBytes(245, 158, 11, 255),
  substation: Cesium.Color.fromBytes(0, 255, 204, 255),
  generator: Cesium.Color.fromBytes(251, 191, 36, 255),
  transformer: Cesium.Color.fromBytes(59, 130, 246, 255),
  tower: Cesium.Color.fromBytes(100, 116, 139, 255),
  monitoring_station: Cesium.Color.fromBytes(167, 139, 250, 255),
  lighthouse: Cesium.Color.fromBytes(254, 240, 138, 255),
  navigation_buoy: Cesium.Color.fromBytes(45, 212, 191, 255),
  weather_station: Cesium.Color.fromBytes(34, 197, 94, 255),
}

const TYPE_PIXEL_SIZE: Record<InfrastructureType, number> = {
  airport: 9,
  power_plant: 9,
  helipad: 6,
  substation: 7,
  generator: 6,
  transformer: 5,
  tower: 4,
  monitoring_station: 6,
  lighthouse: 6,
  navigation_buoy: 5,
  weather_station: 6,
}

/** Types that should render a polygon footprint when coords has ≥3 points. */
const FOOTPRINT_TYPES: Set<InfrastructureType> = new Set(['airport', 'power_plant', 'substation'])

/** Compute the centroid of a coordinate ring (simple average — fine for OSM polygons). */
function centroid(coords: LngLat[]): LngLat | null {
  if (coords.length === 0) return null
  if (coords.length === 1) return coords[0]
  let lng = 0, lat = 0
  for (const c of coords) { lng += c.lng; lat += c.lat }
  return { lng: lng / coords.length, lat: lat / coords.length }
}

export class InfrastructurePlugin implements EarthEnginePlugin {
  id = 'infrastructure'
  name = 'Infrastructure (Airports, Power, Sensors)'
  category = 'infrastructure' as const

  private viewer: Cesium.Viewer | null = null
  private dataSource: Cesium.CustomDataSource | null = null
  private worldOverlay: WorldOverlay | null = null
  private ipc: typeof window.api | null = null
  private status: PluginStats = { count: 0, status: 'disabled' }
  private allFeatures: InfrastructureFeature[] = []
  private lastFetchBbox: string | null = null
  private lastViewBbox: string | null = null
  private show = true
  private lastError: string | null = null
  private fetching = false

  async register(ctx: PluginContext): Promise<void> {
    this.viewer = ctx.viewer
    this.worldOverlay = ctx.worldOverlay ?? null
    this.ipc = ctx.ipc
    this.dataSource = new Cesium.CustomDataSource('infrastructure')
    ctx.viewer.dataSources.add(this.dataSource)
    this.status = { count: 0, status: 'nominal' }
  }

  unregister(): void {
    if (this.worldOverlay) {
      this.worldOverlay.clearCategory('infrastructure')
    }
    if (this.dataSource && this.viewer && !this.viewer.isDestroyed?.()) {
      this.viewer.dataSources.remove(this.dataSource)
    }
    this.dataSource = null
    this.worldOverlay = null
    this.allFeatures = []
    this.lastFetchBbox = null
    this.lastViewBbox = null
    this.viewer = null
    this.ipc = null
    this.status = { count: 0, status: 'disabled' }
  }

  update(ctx: PluginContext): void {
    const sceneCtx = ctx.sceneContext as any

    // ── Auto-fetch when viewport bbox changes at a reasonable zoom ──
    const viewBbox = sceneCtx?.bbox as BBox | undefined
    const camHeight = sceneCtx?.camera?.height as number | undefined

    if (viewBbox) {
      // Only auto-fetch when zoomed in close enough that the bbox is
      // reasonably small (sub-continent or finer). At very high altitudes
      // the Overpass query would be huge and slow. Default camera height
      // is ~2,500,000m, so we allow fetching up to ~5,000,000m.
      if (camHeight != null && camHeight <= 5_000_000) {
        const fetchKey = `${viewBbox.west.toFixed(2)},${viewBbox.south.toFixed(2)},${viewBbox.east.toFixed(2)},${viewBbox.north.toFixed(2)}`
        if (fetchKey !== this.lastFetchBbox && !this.fetching) {
          this.lastFetchBbox = fetchKey
          this.fetchInfrastructure(viewBbox)
        }
      }

      // ── Viewport culling on every bbox change ──
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
    this.worldOverlay?.clearCategory('infrastructure')
    this.allFeatures = []
    this.lastViewBbox = null
    this.lastError = null
    this.status = { count: 0, status: 'nominal' }
  }

  getControls(): PluginControlSpec[] {
    const rendered = this.dataSource?.entities.values.length ?? 0
    const airports = this.allFeatures.filter((f) => f.type === 'airport' || f.type === 'helipad').length
    const power = this.allFeatures.filter((f) => f.type === 'power_plant' || f.type === 'generator').length
    const subs = this.allFeatures.filter((f) => f.type === 'substation' || f.type === 'transformer').length
    const sensors = this.allFeatures.filter((f) => f.type === 'monitoring_station' || f.type === 'lighthouse' || f.type === 'navigation_buoy' || f.type === 'weather_station').length
    return [
      { type: 'toggle', id: 'visible', label: 'Visible', value: this.show },
      { type: 'button', id: 'run', label: 'Fetch Infrastructure', variant: 'primary', disabled: this.fetching },
      { type: 'button', id: 'clear', label: 'Clear', variant: 'danger', disabled: this.allFeatures.length === 0 },
      { type: 'separator', id: 'sep1' },
      { type: 'display', id: 'airports', label: 'Airports', value: String(airports), color: '#4a9eff' },
      { type: 'display', id: 'power', label: 'Power Plants', value: String(power), color: '#f59e0b' },
      { type: 'display', id: 'subs', label: 'Substations', value: String(subs), color: '#00ffcc' },
      { type: 'display', id: 'sensors', label: 'Sensors/Buoys', value: String(sensors), color: '#a78bfa' },
      { type: 'display', id: 'rendered', label: 'Rendered', value: String(rendered), color: '#4affd4' },
      ...(this.lastError ? [{ type: 'display' as const, id: 'error', label: 'Error', value: this.lastError.slice(0, 60), color: '#ff4a4a' }] : []),
    ]
  }

  onControl(id: string, value?: unknown): void {
    if (id === 'visible' && typeof value === 'boolean') {
      this.show = value
      if (this.dataSource) this.dataSource.show = value
    } else if (id === 'run') {
      // Re-fetch using the last known viewport bbox
      const viewBbox = this.lastViewBbox
        ? this.parseBboxKey(this.lastViewBbox)
        : null
      if (viewBbox) {
        this.lastFetchBbox = null
        this.fetchInfrastructure(viewBbox)
      }
    } else if (id === 'clear') {
      this.dataSource?.entities.removeAll()
      this.allFeatures = []
      this.lastFetchBbox = null
      this.lastViewBbox = null
      this.lastError = null
      this.status = { count: 0, status: 'nominal' }
    }
  }

  getFeatures(): InfrastructureFeature[] {
    return this.allFeatures
  }

  private parseBboxKey(key: string): BBox | null {
    const [w, s, e, n] = key.split(',').map(parseFloat)
    if ([w, s, e, n].some((v) => !Number.isFinite(v))) return null
    return { west: w, south: s, east: e, north: n }
  }

  private async fetchInfrastructure(bbox: BBox): Promise<void> {
    if (!this.ipc || !this.dataSource || this.fetching) return
    this.fetching = true
    this.status = { ...this.status, status: 'loading' }

    try {
      const result = await this.ipc.infrastructure.fetch([
        { lng: bbox.west, lat: bbox.south },
        { lng: bbox.east, lat: bbox.north },
      ]) as InfrastructureResponse | null

      if (!result) {
        this.status = { ...this.status, status: 'nominal' }
        return
      }

      this.allFeatures = result.features.slice(0, MAX_VISIBLE_ENTITIES)
      this.lastError = result.error ?? null
      this.dataSource.entities.removeAll()
      this.worldOverlay?.clearCategory('infrastructure')
      this.lastViewBbox = null // force re-cull

      // Initial cull using the fetch bbox as viewport
      this.cullToViewport(bbox)

      this.status = { count: result.features.length, status: 'nominal' }
    } catch (err) {
      console.warn('[infrastructure] fetch failed:', err)
      this.lastError = String(err)
      this.status = { ...this.status, status: 'error', error: String(err) }
    } finally {
      this.fetching = false
    }
  }

  /** Cull features to viewport bbox — diff-based to avoid flicker. */
  private cullToViewport(viewBbox: BBox): void {
    if (!this.dataSource) return

    const camHeight = this.viewer?.camera?.positionCartographic?.height ?? 50000
    const maxEntities = camHeight > 1_000_000 ? MAX_VISIBLE_ENTITIES
      : camHeight > 200_000 ? 10000
      : camHeight > 50_000 ? 8000
      : 5000

    const visibleIds = new Set<string>()
    const toAdd: InfrastructureFeature[] = []
    let count = 0

    for (const f of this.allFeatures) {
      if (count >= maxEntities) break
      if (this.featureIntersectsBbox(f, viewBbox)) {
        visibleIds.add(f.id)
        if (!this.dataSource.entities.getById(f.id)) {
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
      if (!visibleIds.has(e.id)) {
        toRemove.push(e.id)
      }
    }
    for (const id of toRemove) {
      this.dataSource.entities.removeById(id)
      this.worldOverlay?.removeCard(id)
    }

    // Add new entities
    for (const f of toAdd) {
      this.addInfrastructureEntity(f)
    }

    this.dataSource.show = this.show
    if (toAdd.length > 0 || toRemove.length > 0) {
      try { this.viewer?.scene.requestRender() } catch {}
    }
  }

  private featureIntersectsBbox(f: InfrastructureFeature, bbox: BBox): boolean {
    for (const c of f.coords) {
      if (c.lng >= bbox.west && c.lng <= bbox.east && c.lat >= bbox.south && c.lat <= bbox.north) {
        return true
      }
    }
    return false
  }

  private addInfrastructureEntity(f: InfrastructureFeature): void {
    if (!this.dataSource || f.coords.length === 0) return

    const center = centroid(f.coords)
    if (!center) return

    const color = TYPE_COLORS[f.type] ?? Cesium.Color.ORANGE
    const size = TYPE_PIXEL_SIZE[f.type] ?? 6
    const label = f.name ? f.name.substring(0, 24) : (f.icao || f.iata || '')

    // Register card through WorldOverlay for high-value types only
    // (airports, power plants, helipads — named, low-volume, high-interest)
    if (this.worldOverlay && (f.type === 'airport' || f.type === 'power_plant' || f.type === 'helipad')) {
      const colorHex = f.type === 'airport' ? '#4a9eff' : f.type === 'power_plant' ? '#f59e0b' : '#78b4ff'
      const subtitle = [
        f.type === 'airport' ? (f.icao || f.iata || 'Airport') : f.type === 'power_plant' ? (f.outputMw ? `${f.outputMw} MW` : 'Power Plant') : 'Helipad',
        f.fuel,
        f.operator,
      ].filter(Boolean).join(' • ')
      this.worldOverlay.registerCard({
        id: f.id,
        lat: center.lat,
        lon: center.lng,
        title: label || f.id,
        subtitle,
        category: 'infrastructure',
        priority: f.type === 'airport' ? 8 : f.type === 'power_plant' ? 7 : 4,
        color: colorHex,
      })
    }

    // Polygon footprint for airports / power plants / large substations
    if (FOOTPRINT_TYPES.has(f.type) && f.coords.length >= 3) {
      const positions = f.coords.map((c) => Cesium.Cartesian3.fromDegrees(c.lng, c.lat, 1))
      this.dataSource.entities.add({
        id: f.id,
        position: Cesium.Cartesian3.fromDegrees(center.lng, center.lat, 1),
        polygon: {
          hierarchy: new Cesium.PolygonHierarchy(positions),
          material: new Cesium.ColorMaterialProperty(color.withAlpha(0.18)),
          outline: true,
          outlineColor: new Cesium.ConstantProperty(color.withAlpha(0.9)),
        },
        point: {
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          pixelSize: size,
          color: new Cesium.ConstantProperty(color),
          outlineColor: new Cesium.ConstantProperty(Cesium.Color.WHITE),
          outlineWidth: new Cesium.ConstantProperty(1),
        },
        // No label here — managed by WorldOverlay for collision
        properties: {
          type: f.type,
          osmType: f.osmType,
          subtype: f.subtype,
          icao: f.icao,
          iata: f.iata,
          outputMw: f.outputMw,
          voltageKv: f.voltageKv,
          fuel: f.fuel,
          operator: f.operator,
          name: f.name,
        },
      } as any)
      return
    }

    // Point feature
    this.dataSource.entities.add({
      id: f.id,
      position: Cesium.Cartesian3.fromDegrees(center.lng, center.lat),
      point: {
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        pixelSize: size,
        color: new Cesium.ConstantProperty(color),
        outlineColor: new Cesium.ConstantProperty(Cesium.Color.WHITE.withAlpha(0.6)),
        outlineWidth: new Cesium.ConstantProperty(1),
      },
      // No label here — managed by WorldOverlay for collision
      properties: {
        type: f.type,
        osmType: f.osmType,
        subtype: f.subtype,
        icao: f.icao,
        iata: f.iata,
        outputMw: f.outputMw,
        voltageKv: f.voltageKv,
        fuel: f.fuel,
        operator: f.operator,
        name: f.name,
      },
    } as any)
  }
}

export const infrastructurePlugin = new InfrastructurePlugin()
