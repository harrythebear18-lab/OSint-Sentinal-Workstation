/**
 * Hydrology Plugin — Runoff flow paths, pools, flood risk, watershed divides.
 * Tier 1, Priority 4. Terrain + water = core world logic.
 *
 * Renders:
 * - Runoff flow paths from DEM D8 analysis (color-coded by discharge)
 * - Pooling areas (depressions that collect water)
 * - Flood risk zones (high discharge + steep slope)
 * - Watershed divides (ridge lines separating drainage basins)
 *
 * Rainfall is auto-fetched from Open-Meteo (last 24h + next 24h) but can
 * be manually overridden via the slider. This makes the plugin work even
 * when the network is slow or unavailable.
 *
 * Water features (OSM streams/lakes) are handled by the dedicated water-plugin.
 */

import * as Cesium from 'cesium'
import type { EarthEnginePlugin, PluginContext, PluginStats, PluginControlSpec } from './plugin-manager'
import type { RunoffAnalysisResponse, WatershedDivide } from '@shared/types'

export class HydrologyPlugin implements EarthEnginePlugin {
  id = 'hydrology'
  name = 'Hydrology (Runoff + Flood)'
  category = 'terrain' as const

  private viewer: Cesium.Viewer | null = null
  private runoffSource: Cesium.CustomDataSource | null = null
  private status: PluginStats = { count: 0, status: 'disabled' }
  private ipc: typeof window.api | null = null
  private lastBbox: string | null = null
  private lastBboxParsed: { west: number; south: number; east: number; north: number } | null = null
  private showRunoff = true
  private maxDischargeLps = 0

  // Rainfall state
  private autoRainfallMm = 0       // last auto-fetched value
  private manualRainfallMm = 0    // user-set value (0 = use auto)
  private useManualRainfall = false
  private rainfallSource: 'auto' | 'manual' | 'none' = 'none'
  private rainfallError: string | null = null
  private isRunning = false

  async register(ctx: PluginContext): Promise<void> {
    this.viewer = ctx.viewer
    this.ipc = ctx.ipc
    this.runoffSource = new Cesium.CustomDataSource('hydrology-runoff')
    ctx.viewer.dataSources.add(this.runoffSource)
    this.status = { count: 0, status: 'nominal' }
  }

  unregister(): void {
    if (this.runoffSource && this.viewer && !this.viewer.isDestroyed?.()) {
      this.viewer.dataSources.remove(this.runoffSource)
    }
    this.runoffSource = null
    this.viewer = null
    this.ipc = null
    this.lastBbox = null
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

    if (this.showRunoff) this.fetchRunoff(bbox)
  }

  getStats(): PluginStats {
    return this.status
  }

  getControls(): PluginControlSpec[] {
    const effectiveRainfall = this.useManualRainfall ? this.manualRainfallMm : this.autoRainfallMm
    const sourceLabel = this.useManualRainfall ? 'MANUAL' : this.rainfallSource === 'auto' ? 'AUTO' : '—'
    const sourceColor = this.useManualRainfall ? '#ffea4a' : this.rainfallSource === 'auto' ? '#4aff8a' : '#6b7d92'

    return [
      { type: 'toggle', id: 'showRunoff', label: 'Visible', value: this.showRunoff },
      { type: 'button', id: 'run', label: 'Run Analysis', variant: 'primary', disabled: this.isRunning || !this.lastBboxParsed },
      { type: 'button', id: 'clear', label: 'Clear', variant: 'danger', disabled: this.runoffSource?.entities.values.length === 0 },
      { type: 'separator', id: 'sep1' },
      { type: 'display', id: 'rainfall', label: 'Rainfall', value: `${effectiveRainfall.toFixed(1)} mm`, color: effectiveRainfall > 10 ? '#ff8a4a' : effectiveRainfall > 2 ? '#ffea4a' : '#4a8aff' },
      { type: 'display', id: 'rainSource', label: 'Source', value: sourceLabel, color: sourceColor },
      { type: 'toggle', id: 'manualMode', label: 'Manual Override', value: this.useManualRainfall },
      { type: 'slider', id: 'manualRain', label: 'Set Rainfall', min: 0, max: 100, step: 1, value: this.manualRainfallMm, unit: ' mm' },
      { type: 'separator', id: 'sep2' },
      { type: 'display', id: 'flowPaths', label: 'Flow Paths', value: String(this.runoffSource?.entities.values.filter((e) => e.id.startsWith('runoff:')).length ?? 0), color: '#4affd4' },
      { type: 'display', id: 'maxDischarge', label: 'Peak Q', value: `${this.maxDischargeLps.toFixed(0)} L/s`, color: this.maxDischargeLps > 200 ? '#ff4a4a' : this.maxDischargeLps > 50 ? '#ffea4a' : '#4a8aff' },
      { type: 'display', id: 'pools', label: 'Pools', value: String(this.runoffSource?.entities.values.filter((e) => e.id.startsWith('pool:')).length ?? 0), color: '#4a8aff' },
      { type: 'display', id: 'floodZones', label: 'Flood Zones', value: String(this.runoffSource?.entities.values.filter((e) => e.id.startsWith('flood:')).length ?? 0), color: '#ff4a4a' },
      { type: 'display', id: 'watersheds', label: 'Watersheds', value: String(this.runoffSource?.entities.values.filter((e) => e.id.startsWith('watershed-')).length ?? 0), color: '#ffea4a' },
    ]
  }

  onControl(id: string, value?: unknown): void {
    if (id === 'showRunoff' && typeof value === 'boolean') {
      this.showRunoff = value
      if (this.runoffSource) this.runoffSource.show = value
    } else if (id === 'run') {
      if (this.lastBboxParsed) {
        this.lastBbox = null  // force re-run
        this.fetchRunoff(this.lastBboxParsed)
      }
    } else if (id === 'clear') {
      this.runoffSource?.entities.removeAll()
      this.lastBbox = null
      this.status = { count: 0, status: 'nominal' }
    } else if (id === 'manualMode' && typeof value === 'boolean') {
      this.useManualRainfall = value
    } else if (id === 'manualRain' && typeof value === 'number') {
      this.manualRainfallMm = value
      if (this.useManualRainfall) {
        // Re-run with new rainfall value
        if (this.lastBboxParsed) {
          this.lastBbox = null
          this.fetchRunoff(this.lastBboxParsed)
        }
      }
    }
  }

  private get effectiveRainfallMm(): number {
    return this.useManualRainfall ? this.manualRainfallMm : this.autoRainfallMm
  }

  private async fetchRunoff(bbox: { west: number; south: number; east: number; north: number }): Promise<void> {
    if (!this.ipc || !this.runoffSource || this.isRunning) return
    this.isRunning = true
    this.status = { ...this.status, status: 'loading' }

    try {
      // Step 1: Fetch rainfall (unless manual override is on)
      let rainfallMm = 0
      if (this.useManualRainfall) {
        rainfallMm = this.manualRainfallMm
        this.rainfallSource = 'manual'
        this.rainfallError = null
      } else {
        try {
          const result = await this.ipc.weather.rainfall([
            { lng: bbox.west, lat: bbox.south },
            { lng: bbox.east, lat: bbox.north },
          ]) as number | null
          rainfallMm = result ?? 0
          this.autoRainfallMm = rainfallMm
          this.rainfallSource = 'auto'
          this.rainfallError = null
        } catch (err) {
          console.warn('[hydrology] rainfall fetch failed:', err)
          this.autoRainfallMm = 0
          this.rainfallSource = 'none'
          this.rainfallError = 'Rainfall fetch failed — using 0 mm'
          // Continue with 0 rainfall — flow paths will still render, just with 0 discharge
        }
      }

      // Step 2: Run runoff analysis with the effective rainfall
      const result = await this.ipc.terrain.runoff({
        bounds: [{ lng: bbox.west, lat: bbox.south }, { lng: bbox.east, lat: bbox.north }],
        rainfallMm,
      }) as RunoffAnalysisResponse | null

      if (!result?.flowPaths) {
        this.status = { count: 0, status: 'nominal' }
        this.isRunning = false
        return
      }

      if (!this.runoffSource) { this.isRunning = false; return }
      this.runoffSource.entities.removeAll()
      this.maxDischargeLps = 0

      // Render flow paths — width and color scaled by discharge
      for (const path of result.flowPaths) {
        this.maxDischargeLps = Math.max(this.maxDischargeLps, path.dischargeLps)
        this.addRunoffEntity(path)
      }

      // Render pools as semi-transparent blue polygons
      if (result.pools) {
        for (const pool of result.pools) {
          this.addPoolEntity(pool)
        }
      }

      // Render flood risk zones
      if (result.floodZones) {
        for (const zone of result.floodZones) {
          this.addFloodZoneEntity(zone)
        }
      }

      // Render watershed divides
      if (result.watershedDivides) {
        for (const divide of result.watershedDivides) {
          this.addWatershedEntity(divide)
        }
      }

      const totalEntities = result.flowPaths.length + (result.pools?.length ?? 0) + (result.floodZones?.length ?? 0) + (result.watershedDivides?.length ?? 0)
      const errorMsg = this.rainfallError && rainfallMm === 0 ? this.rainfallError : undefined
      this.status = { count: totalEntities, status: 'nominal', error: errorMsg }
    } catch (err) {
      console.warn('[hydrology] runoff analysis failed:', err)
      this.status = { ...this.status, status: 'error', error: String(err) }
      // Clear lastBbox so the next update() call will retry
      this.lastBbox = null
    } finally {
      this.isRunning = false
    }
  }

  private addRunoffEntity(path: { id: string; coords: { lng: number; lat: number }[]; dischargeLps: number }): void {
    if (!this.runoffSource || path.coords.length < 2) return

    const positions = path.coords.map((c) => Cesium.Cartesian3.fromDegrees(c.lng, c.lat))

    // Width and color scale with discharge
    const discharge = path.dischargeLps
    const width = discharge > 200 ? 5 : discharge > 50 ? 3.5 : 2.5
    const color = discharge > 200
      ? Cesium.Color.fromBytes(255, 100, 74, 230)   // high discharge = red-orange
      : discharge > 50
        ? Cesium.Color.fromBytes(255, 180, 74, 220) // medium = orange
        : discharge > 0
          ? Cesium.Color.fromBytes(74, 200, 255, 220) // low = cyan
          : Cesium.Color.fromBytes(100, 130, 160, 180) // no discharge = gray (no rain)

    this.runoffSource.entities.add({
      id: `runoff:${path.id}`,
      polyline: {
        positions: new Cesium.ConstantProperty(positions),
        width: new Cesium.ConstantProperty(width),
        material: new Cesium.PolylineGlowMaterialProperty({
          glowPower: new Cesium.ConstantProperty(0.15),
          color: new Cesium.ConstantProperty(color),
        }),
        clampToGround: true,
      },
      properties: { dischargeLps: discharge },
    } as any)
  }

  private addPoolEntity(pool: { id: string; coords: { lng: number; lat: number }[]; depthM: number; volumeL: number }): void {
    if (!this.runoffSource || pool.coords.length < 3) return
    const positions = pool.coords.map((c) => Cesium.Cartesian3.fromDegrees(c.lng, c.lat))

    // Deeper pools = darker blue
    const alpha = Math.min(0.6, 0.2 + pool.depthM * 0.05)
    this.runoffSource.entities.add({
      id: `pool:${pool.id}`,
      polygon: {
        hierarchy: new Cesium.PolygonHierarchy(positions),
        material: new Cesium.ColorMaterialProperty(Cesium.Color.fromBytes(74, 138, 255, Math.round(alpha * 255))),
      },
      properties: { depthM: pool.depthM, volumeL: pool.volumeL },
    } as any)
  }

  private addFloodZoneEntity(zone: { id: string; coords: { lng: number; lat: number }[]; risk: number; reason: string }): void {
    if (!this.runoffSource || zone.coords.length < 3) return
    const positions = zone.coords.map((c) => Cesium.Cartesian3.fromDegrees(c.lng, c.lat))

    // Risk-based color: high risk = bright red, low = orange
    const r = Math.round(255)
    const g = Math.round(100 + (1 - zone.risk) * 100)
    const b = Math.round(74 + (1 - zone.risk) * 50)
    const alpha = Math.round((0.3 + zone.risk * 0.4) * 255)

    this.runoffSource.entities.add({
      id: `flood:${zone.id}`,
      polyline: {
        positions: new Cesium.ConstantProperty(positions),
        width: new Cesium.ConstantProperty(4),
        material: new Cesium.ColorMaterialProperty(Cesium.Color.fromBytes(r, g, b, alpha)),
        clampToGround: true,
      },
      properties: { risk: zone.risk, reason: zone.reason },
    } as any)
  }

  private addWatershedEntity(divide: WatershedDivide): void {
    if (!this.runoffSource || divide.coords.length < 3) return
    const positions = divide.coords.map((c) => Cesium.Cartesian3.fromDegrees(c.lng, c.lat))

    // Ridge lines: dashed amber outline + filled polygon
    this.runoffSource.entities.add({
      id: `watershed-fill:${divide.id}`,
      polygon: {
        hierarchy: new Cesium.PolygonHierarchy(positions),
        material: new Cesium.ColorMaterialProperty(Cesium.Color.fromBytes(180, 140, 60, 40)),
      },
      properties: { label: divide.label, areaKm2: divide.areaKm2 },
    } as any)

    this.runoffSource.entities.add({
      id: `watershed-line:${divide.id}`,
      polyline: {
        positions: new Cesium.ConstantProperty([...positions, positions[0]]),
        width: new Cesium.ConstantProperty(2.5),
        material: new Cesium.PolylineDashMaterialProperty({
          color: new Cesium.ConstantProperty(Cesium.Color.fromBytes(220, 180, 80, 220)),
          dashLength: new Cesium.ConstantProperty(12),
        }),
        clampToGround: true,
      },
      properties: { label: divide.label, areaKm2: divide.areaKm2 },
    } as any)
  }
}

export const hydrologyPlugin = new HydrologyPlugin()
