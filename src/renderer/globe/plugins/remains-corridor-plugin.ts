/**
 * Remains Corridor Plugin — downhill-only flow from a fall point.
 * Tier 5, Priority 18. From OGOS "Fall → Flow → Find" pipeline.
 *
 * From the LKP/fall point, traces where remains would move under gravity
 * (or rainfall-assisted flow). Renders:
 *  - Primary + secondary corridor paths (downhill gullies)
 *  - Deposition zones (shelves, basins, snags, fans, confluences)
 *  - Choke points (narrow constrictions)
 *  - Terminal zone (fan/outlet where corridor ends)
 *
 * Requires both a selection bbox and an LKP pin (the fall point).
 */

import * as Cesium from 'cesium'
import type { EarthEnginePlugin, PluginContext, PluginStats, PluginControlSpec } from './plugin-manager'
import type { RemainsCorridorResponse, CorridorPath, DepositionZone, ChokePoint } from '@shared/types'

export class RemainsCorridorPlugin implements EarthEnginePlugin {
  id = 'remains-corridor'
  name = 'Remains Corridor (Fall → Flow)'
  category = 'mission' as const

  private viewer: Cesium.Viewer | null = null
  private dataSource: Cesium.CustomDataSource | null = null
  private ipc: typeof window.api | null = null
  private status: PluginStats = { count: 0, status: 'disabled' }
  private paths: CorridorPath[] = []
  private depositionZones: DepositionZone[] = []
  private chokePoints: ChokePoint[] = []
  private lastBbox: string | null = null
  private lastBboxParsed: { west: number; south: number; east: number; north: number } | null = null
  private lastFallKey: string | null = null
  private lastFallPoint: { lng: number; lat: number } | null = null
  private rainfallMm = 0

  async register(ctx: PluginContext): Promise<void> {
    this.viewer = ctx.viewer
    this.ipc = ctx.ipc
    this.dataSource = new Cesium.CustomDataSource('remains-corridor')
    ctx.viewer.dataSources.add(this.dataSource)
    this.status = { count: 0, status: 'nominal' }
  }

  unregister(): void {
    if (this.dataSource && this.viewer && !this.viewer.isDestroyed?.()) {
      this.viewer.dataSources.remove(this.dataSource)
    }
    this.dataSource = null
    this.paths = []
    this.depositionZones = []
    this.chokePoints = []
    this.lastBbox = null
    this.lastFallKey = null
    this.viewer = null
    this.ipc = null
    this.status = { count: 0, status: 'disabled' }
  }

  update(ctx: PluginContext): void {
    const sceneCtx = ctx.sceneContext as any
    const bbox = sceneCtx?.selectionBbox
    const lkp = sceneCtx?.lkp
    if (!bbox || !lkp) return

    this.lastBboxParsed = bbox
    this.lastFallPoint = lkp

    const bboxKey = `${bbox.west.toFixed(2)},${bbox.south.toFixed(2)},${bbox.east.toFixed(2)},${bbox.north.toFixed(2)}`
    const fallKey = `${lkp.lng.toFixed(4)},${lkp.lat.toFixed(4)}`
    if (bboxKey === this.lastBbox && fallKey === this.lastFallKey) return
    this.lastBbox = bboxKey
    this.lastFallKey = fallKey

    const height = sceneCtx?.camera?.height
    if (height && height > 500_000) return

    this.runAnalysis(bbox, lkp)
  }

  getStats(): PluginStats {
    return this.status
  }

  getControls(): PluginControlSpec[] {
    return [
      { type: 'button', id: 'run', label: 'Run Analysis', variant: 'primary' },
      { type: 'button', id: 'clear', label: 'Clear', variant: 'danger', disabled: this.paths.length === 0 },
      { type: 'separator', id: 'sep1' },
      { type: 'display', id: 'paths', label: 'Corridors', value: String(this.paths.length), color: '#ff8a4a' },
      { type: 'display', id: 'deposition', label: 'Deposition', value: String(this.depositionZones.length), color: '#ffd24a' },
      { type: 'display', id: 'chokes', label: 'Choke Points', value: String(this.chokePoints.length), color: '#ff4a8a' },
      { type: 'display', id: 'rainfall', label: 'Rainfall', value: `${this.rainfallMm.toFixed(1)} mm`, color: this.rainfallMm > 10 ? '#ff8a4a' : '#4a8aff' },
    ]
  }

  onControl(id: string): void {
    if (id === 'run') {
      if (this.lastBboxParsed && this.lastFallPoint) {
        this.lastBbox = null
        this.lastFallKey = null
        this.runAnalysis(this.lastBboxParsed, this.lastFallPoint)
      }
    } else if (id === 'clear') {
      this.dataSource?.entities.removeAll()
      this.paths = []
      this.depositionZones = []
      this.chokePoints = []
      this.lastBbox = null
      this.lastFallKey = null
      this.status = { count: 0, status: 'nominal' }
    }
  }

  getPaths(): CorridorPath[] {
    return this.paths
  }

  getDepositionZones(): DepositionZone[] {
    return this.depositionZones
  }

  getChokePoints(): ChokePoint[] {
    return this.chokePoints
  }

  private async runAnalysis(
    bbox: { west: number; south: number; east: number; north: number },
    fallPoint: { lng: number; lat: number },
  ): Promise<void> {
    if (!this.ipc || !this.dataSource) return
    this.status = { ...this.status, status: 'loading' }

    try {
      // Fetch rainfall for the bbox center (used for rainfall-assisted flow)
      let rainfall = 0
      try {
        const r = await this.ipc.invoke('weather:rainfall', {
          bounds: [{ lng: bbox.west, lat: bbox.south }, { lng: bbox.east, lat: bbox.north }],
        }) as number | null
        rainfall = r ?? 0
      } catch {
        // rainfall is optional — dry fall is valid
      }
      this.rainfallMm = rainfall

      const result = await this.ipc.invoke('terrain:remains-corridor', {
        fallPoint,
        bounds: [{ lng: bbox.west, lat: bbox.south }, { lng: bbox.east, lat: bbox.north }],
        rainfallMm: rainfall,
      }) as RemainsCorridorResponse | null

      if (!result?.paths) {
        this.status = { count: 0, status: 'nominal' }
        return
      }

      this.paths = result.paths
      this.depositionZones = result.depositionZones ?? []
      this.chokePoints = result.chokePoints ?? []
      this.dataSource.entities.removeAll()

      // Fall point marker
      this.addFallPointEntity(fallPoint)

      // Corridor paths
      for (const path of result.paths) {
        this.addPathEntity(path)
      }

      // Deposition zones
      for (const zone of result.depositionZones) {
        this.addDepositionEntity(zone)
      }

      // Choke points
      for (const choke of result.chokePoints) {
        this.addChokeEntity(choke)
      }

      // Terminal zone
      if (result.terminalZone) {
        this.addTerminalEntity(result.terminalZone)
      }

      const total = result.paths.length + result.depositionZones.length + result.chokePoints.length + (result.terminalZone ? 1 : 0)
      this.status = { count: total, status: 'nominal' }
    } catch (err) {
      console.warn('[remains-corridor] analysis failed:', err)
      this.status = { ...this.status, status: 'error', error: String(err) }
    }
  }

  private addFallPointEntity(fall: { lng: number; lat: number }): void {
    if (!this.dataSource) return
    this.dataSource.entities.add({
      id: 'remains:fall-point',
      position: Cesium.Cartesian3.fromDegrees(fall.lng, fall.lat),
      point: {
        pixelSize: new Cesium.ConstantProperty(14),
        color: new Cesium.ConstantProperty(Cesium.Color.fromBytes(255, 74, 74, 255)),
        outlineColor: new Cesium.ConstantProperty(Cesium.Color.WHITE),
        outlineWidth: new Cesium.ConstantProperty(2),
      },
      label: {
        text: new Cesium.ConstantProperty('FALL POINT'),
        font: new Cesium.ConstantProperty('12px sans-serif'),
        fillColor: new Cesium.ConstantProperty(Cesium.Color.WHITE),
        outlineColor: new Cesium.ConstantProperty(Cesium.Color.BLACK),
        outlineWidth: new Cesium.ConstantProperty(2),
        style: new Cesium.ConstantProperty(Cesium.LabelStyle.FILL_AND_OUTLINE),
        pixelOffset: new Cesium.ConstantProperty(new Cesium.Cartesian2(0, -18)),
      },
    } as any)
  }

  private addPathEntity(path: CorridorPath): void {
    if (!this.dataSource || path.coords.length < 2) return
    const positions = path.coords.map((c) => Cesium.Cartesian3.fromDegrees(c.lng, c.lat))

    const width = path.primary ? 5 : 2.5
    const color = path.primary
      ? Cesium.Color.fromBytes(255, 138, 74, 230)   // primary = orange
      : Cesium.Color.fromBytes(255, 200, 120, 180)  // secondary = light amber

    this.dataSource.entities.add({
      id: `corridor:${path.id}`,
      polyline: {
        positions: new Cesium.ConstantProperty(positions),
        width: new Cesium.ConstantProperty(width),
        material: new Cesium.PolylineGlowMaterialProperty({
          glowPower: new Cesium.ConstantProperty(0.2),
          color: new Cesium.ConstantProperty(color),
        }),
        clampToGround: true,
      },
      properties: { primary: path.primary, accumulation: path.accumulation },
    } as any)
  }

  private depositionColor(type: DepositionZone['type']): Cesium.Color {
    switch (type) {
      case 'basin': return Cesium.Color.fromBytes(74, 138, 255, 160)   // blue — collects
      case 'fan': return Cesium.Color.fromBytes(255, 210, 74, 160)      // yellow — terminal fan
      case 'shelf': return Cesium.Color.fromBytes(120, 220, 120, 140)   // green — flat catch
      case 'snag': return Cesium.Color.fromBytes(180, 100, 220, 140)    // purple — rough
      case 'confluence': return Cesium.Color.fromBytes(255, 138, 74, 160) // orange — merge
      default: return Cesium.Color.GRAY
    }
  }

  private addDepositionEntity(zone: DepositionZone): void {
    if (!this.dataSource || zone.coords.length < 3) return
    const positions = zone.coords.map((c) => Cesium.Cartesian3.fromDegrees(c.lng, c.lat))
    const color = this.depositionColor(zone.type)
    const alpha = Math.round((0.3 + zone.priority * 0.4) * 255)

    this.dataSource.entities.add({
      id: `deposition:${zone.id}`,
      polygon: {
        hierarchy: new Cesium.PolygonHierarchy(positions),
        material: new Cesium.ColorMaterialProperty(color.withAlpha(alpha / 255)),
      },
      properties: { type: zone.type, priority: zone.priority, reason: zone.reason },
    } as any)
  }

  private addChokeEntity(choke: ChokePoint): void {
    if (!this.dataSource) return
    this.dataSource.entities.add({
      id: `choke:${choke.id}`,
      position: Cesium.Cartesian3.fromDegrees(choke.coord.lng, choke.coord.lat),
      point: {
        pixelSize: new Cesium.ConstantProperty(10),
        color: new Cesium.ConstantProperty(Cesium.Color.fromBytes(255, 74, 138, 255)),
        outlineColor: new Cesium.ConstantProperty(Cesium.Color.WHITE),
        outlineWidth: new Cesium.ConstantProperty(2),
      },
      label: {
        text: new Cesium.ConstantProperty('CHOKE'),
        font: new Cesium.ConstantProperty('10px sans-serif'),
        fillColor: new Cesium.ConstantProperty(Cesium.Color.fromBytes(255, 200, 220, 255)),
        outlineColor: new Cesium.ConstantProperty(Cesium.Color.BLACK),
        outlineWidth: new Cesium.ConstantProperty(2),
        style: new Cesium.ConstantProperty(Cesium.LabelStyle.FILL_AND_OUTLINE),
        pixelOffset: new Cesium.ConstantProperty(new Cesium.Cartesian2(0, -14)),
      },
      properties: { reason: choke.reason },
    } as any)
  }

  private addTerminalEntity(zone: { coords: { lng: number; lat: number }[]; areaKm2: number }): void {
    if (!this.dataSource || zone.coords.length < 3) return
    const positions = zone.coords.map((c) => Cesium.Cartesian3.fromDegrees(c.lng, c.lat))

    this.dataSource.entities.add({
      id: 'remains:terminal-zone',
      polygon: {
        hierarchy: new Cesium.PolygonHierarchy(positions),
        material: new Cesium.ColorMaterialProperty(Cesium.Color.fromBytes(255, 210, 74, 80)),
      },
      properties: { areaKm2: zone.areaKm2, terminal: true },
    } as any)
  }
}

export const remainsCorridorPlugin = new RemainsCorridorPlugin()
