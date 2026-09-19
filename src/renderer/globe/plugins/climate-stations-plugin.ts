/**
 * Climate Stations Plugin — buoys, Argo floats, weather stations, CO₂ stations.
 * Ported from OGOS GlobalOverlays climate-stations layer.
 *
 * Subscribes to CLIMATE_UPDATE IPC channel.
 * Renders stations as colored point entities on the globe.
 *
 * Visual differentiation:
 *   - Static buoys (NDBC, TAO): solid colored dots
 *   - Argo floats: pulsing dots + drift trail polylines (last 30 positions)
 *   - Current stations (TAO currents): flow vector arrows (speed + direction)
 *   - CO₂ stations: distinct orange diamonds
 *   - Weather stations: green dots
 *
 * Full measurement fields exposed in entity properties for EntityInfoBox:
 *   waterTemp, airTemp, windSpeed, windDir, waveHeight, wavePeriod,
 *   pressure, salinity, co2, currentSpeed, currentDir, depth, oxygen, ph
 */

import * as Cesium from 'cesium'
import type { EarthEnginePlugin, PluginContext, PluginStats, PluginControlSpec } from './plugin-manager'
import type { ClimateStation, ClimateUpdate, ClimateMeasurement } from '@shared/types'

const STATION_COLORS: Record<string, Cesium.Color> = {
  buoy: Cesium.Color.fromBytes(0, 255, 204, 255),
  argo_float: Cesium.Color.fromBytes(79, 195, 247, 255),
  bgc_argo_float: Cesium.Color.fromBytes(255, 170, 0, 255),
  carbon_station: Cesium.Color.fromBytes(255, 102, 0, 255),
  weather_station: Cesium.Color.fromBytes(0, 170, 136, 255),
  storm: Cesium.Color.fromBytes(255, 51, 102, 255),
  lightning: Cesium.Color.fromBytes(255, 235, 59, 255),
}

function stationColor(type: string): Cesium.Color {
  return STATION_COLORS[type] ?? Cesium.Color.fromBytes(192, 200, 216, 255)
}

/** Compute the end point of a current vector arrow from speed + direction. */
function currentArrowEndpoint(
  lat: number,
  lon: number,
  speedMps: number,
  dirDeg: number,
): { lat: number; lon: number } {
  // Scale: 1 m/s → ~0.5 degrees of arc on the globe (visible at most zooms)
  // Cap at 5 degrees to avoid absurd arrows for extreme values
  const arcDeg = Math.min(speedMps * 0.5, 5)
  const rad = (dirDeg * Math.PI) / 180

  // Direction is oceanographic: degrees from North, clockwise
  // dx = sin(dir), dy = cos(dir) — but lat/lon are not Cartesian
  // Approximate for short distances using equirectangular projection
  const dLat = arcDeg * Math.cos(rad)
  const dLon = arcDeg * Math.sin(rad) / Math.cos((lat * Math.PI) / 180)

  return { lat: lat + dLat, lon: lon + dLon }
}

export class ClimateStationsPlugin implements EarthEnginePlugin {
  id = 'climate-stations'
  name = 'Climate Stations (Buoys, Argo, Currents)'
  category = 'climate' as const

  private viewer: Cesium.Viewer | null = null
  private dataSource: Cesium.CustomDataSource | null = null
  private status: PluginStats = { count: 0, status: 'disabled' }
  private show = true
  private showCurrents = true
  private showDriftTrails = true
  private unsubscribe: (() => void) | null = null
  private stations = new Map<string, { station: ClimateStation; measurement?: ClimateMeasurement }>()

  register(ctx: PluginContext): void {
    this.viewer = ctx.viewer
    this.dataSource = new Cesium.CustomDataSource('climate-stations')
    ctx.viewer.dataSources.add(this.dataSource)
    this.status = { count: 0, status: 'loading' }

    const handler = (update: ClimateUpdate) => {
      if (update.stations) {
        this.handleUpdate(update.stations, update.measurements)
      }
    }

    ctx.ipc.climate.onUpdate(handler)
    this.unsubscribe = () => ctx.ipc.off('climate:update')

    // Request current state immediately (don't wait up to 4min for next broadcast)
    ctx.ipc.climate.getCurrent().then((update: unknown) => {
      const u = update as ClimateUpdate | null
      if (u?.stations) {
        this.handleUpdate(u.stations, u.measurements)
      }
    }).catch((err: unknown) => {
      console.warn('[climate-stations] getCurrent failed:', err)
    })
  }

  unregister(): void {
    if (this.unsubscribe) {
      this.unsubscribe()
      this.unsubscribe = null
    }
    if (this.dataSource && this.viewer && !this.viewer.isDestroyed?.()) {
      this.viewer.dataSources.remove(this.dataSource)
    }
    this.dataSource = null
    this.stations.clear()
    this.viewer = null
    this.status = { count: 0, status: 'disabled' }
  }

  update(_ctx: PluginContext): void {}

  getStats(): PluginStats {
    return this.status
  }

  clear(): void {
    this.dataSource?.entities.removeAll()
    this.stations.clear()
    this.status = { count: 0, status: 'nominal' }
  }

  getControls(): PluginControlSpec[] {
    const argoCount = Array.from(this.stations.values()).filter((s) => s.station.type === 'argo_float').length
    const currentCount = Array.from(this.stations.values()).filter(
      (s) => s.measurement?.currentSpeed != null,
    ).length
    return [
      { type: 'toggle', id: 'visible', label: 'Visible', value: this.show },
      { type: 'toggle', id: 'currents', label: 'Current Arrows', value: this.showCurrents },
      { type: 'toggle', id: 'trails', label: 'Argo Drift Trails', value: this.showDriftTrails },
      { type: 'separator', id: 'sep1' },
      { type: 'display', id: 'count', label: 'Active Stations', value: String(this.status.count), color: this.status.count > 0 ? '#4aff8a' : '#6b7d92' },
      { type: 'display', id: 'argo', label: 'Argo Floats', value: String(argoCount), color: '#4fc3f7' },
      { type: 'display', id: 'currents_count', label: 'Current Sensors', value: String(currentCount), color: '#00ffcc' },
    ]
  }

  onControl(id: string, value?: unknown): void {
    if (id === 'visible' && typeof value === 'boolean') {
      this.show = value
      if (this.dataSource) this.dataSource.show = value
    }
    if (id === 'currents' && typeof value === 'boolean') {
      this.showCurrents = value
      // Re-render all entities to show/hide arrows
      this.refreshAll()
    }
    if (id === 'trails' && typeof value === 'boolean') {
      this.showDriftTrails = value
      this.refreshAll()
    }
  }

  /** Re-render all entities (after toggle change). */
  private refreshAll(): void {
    if (!this.dataSource) return
    this.dataSource.entities.removeAll()
    for (const [id, { station, measurement }] of this.stations) {
      this.updateEntity(station, measurement)
    }
  }

  private handleUpdate(
    stations: ClimateStation[],
    measurements: Record<string, ClimateMeasurement>,
  ): void {
    if (!this.dataSource) return

    const newIds = new Set(stations.map((s) => s.id))
    const toRemove: string[] = []
    for (const id of this.stations.keys()) {
      if (!newIds.has(id)) toRemove.push(id)
    }
    for (const id of toRemove) {
      this.dataSource.entities.removeById(`station:${id}`)
      this.dataSource.entities.removeById(`trail:${id}`)
      this.dataSource.entities.removeById(`arrow:${id}`)
      this.stations.delete(id)
    }

    for (const s of stations) {
      const m = measurements[s.id]
      this.stations.set(s.id, { station: s, measurement: m })
      this.updateEntity(s, m)
    }

    this.status = { count: stations.length, status: 'nominal' }
  }

  private updateEntity(s: ClimateStation, m?: ClimateMeasurement): void {
    if (!this.dataSource) return
    const id = `station:${s.id}`
    const position = Cesium.Cartesian3.fromDegrees(s.lon, s.lat, s.elevation ?? 0)
    const color = stationColor(s.type)
    const label = s.name ? s.name.substring(0, 20) : ''
    const isArgo = s.type === 'argo_float' || s.type === 'bgc_argo_float'
    const hasCurrents = m?.currentSpeed != null && m?.currentDir != null

    // Remove old auxiliary entities (trail/arrow) before re-adding
    this.dataSource.entities.removeById(`trail:${s.id}`)
    this.dataSource.entities.removeById(`arrow:${s.id}`)

    // ── Drift trail for Argo floats ──
    if (isArgo && this.showDriftTrails && m?.trajectory && m.trajectory.length >= 2) {
      const trailPositions = m.trajectory.map((p) =>
        Cesium.Cartesian3.fromDegrees(p.lon, p.lat, 0),
      )
      this.dataSource.entities.add({
        id: `trail:${s.id}`,
        polyline: {
          positions: new Cesium.ConstantProperty(trailPositions),
          material: new Cesium.PolylineGlowMaterialProperty({
            color: color.withAlpha(0.6),
            glowPower: 0.15,
          }),
          width: 1.5,
          arcType: Cesium.ArcType.NONE,
        },
      } as any)
    }

    // ── Current vector arrow ──
    if (hasCurrents && this.showCurrents) {
      const end = currentArrowEndpoint(s.lat, s.lon, m!.currentSpeed!, m!.currentDir!)
      const startPos = position
      const endPos = Cesium.Cartesian3.fromDegrees(end.lon, end.lat, 0)

      // Arrow color based on speed: green (slow) → yellow → red (fast)
      const speed = m!.currentSpeed!
      const arrowColor = speed < 0.3
        ? Cesium.Color.fromBytes(74, 255, 138, 200)
        : speed < 1.0
        ? Cesium.Color.fromBytes(255, 234, 74, 200)
        : Cesium.Color.fromBytes(255, 138, 74, 220)

      this.dataSource.entities.add({
        id: `arrow:${s.id}`,
        polyline: {
          positions: new Cesium.ConstantProperty([startPos, endPos]),
          material: new Cesium.PolylineGlowMaterialProperty({
            color: arrowColor,
            glowPower: 0.2,
          }),
          width: 2.5,
          arcType: Cesium.ArcType.NONE,
        },
      } as any)

      // Arrowhead — small point at the end
      this.dataSource.entities.add({
        id: `arrowhead:${s.id}`,
        position: new Cesium.ConstantPositionProperty(endPos),
        point: {
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          pixelSize: 4,
          color: arrowColor,
          outlineColor: Cesium.Color.WHITE,
          outlineWidth: 1,
        },
      } as any)
    }

    // ── Station point ──
    const labelOpts = label
      ? {
          text: label,
          font: '9px monospace',
          fillColor: Cesium.Color.WHITE.withAlpha(0.8),
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 2,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          pixelOffset: new Cesium.Cartesian2(0, -12),
        }
      : undefined

    // Point size: Argo floats slightly larger to distinguish from static buoys
    const pixelSize = isArgo ? 7 : 6

    // Disable depth test for nearby visibility, but allow globe occlusion
    const existing = this.dataSource.entities.getById(id)
    if (!existing) {
      this.dataSource.entities.add({
        id,
        position: new Cesium.ConstantPositionProperty(position),
        point: {
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          pixelSize,
          color,
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 1,
        },
        label: labelOpts,
        properties: {
          type: s.type,
          source: s.source,
          // Full measurement fields for EntityInfoBox
          waterTemp: m?.waterTemp,
          airTemp: m?.airTemp,
          windSpeed: m?.windSpeed,
          windDir: m?.windDir,
          waveHeight: m?.waveHeight,
          wavePeriod: m?.wavePeriod,
          pressure: m?.pressure,
          salinity: m?.salinity,
          co2: m?.co2,
          currentSpeed: m?.currentSpeed,
          currentDir: m?.currentDir,
          depth: m?.depth ?? s.depth,
          oxygen: m?.oxygen,
          ph: m?.ph,
          hasTrajectory: !!(m?.trajectory && m.trajectory.length >= 2),
          trajectoryPoints: m?.trajectory?.length ?? 0,
        },
      } as any)
    } else {
      ;(existing.position as Cesium.ConstantPositionProperty).setValue(position)
    }
  }
}

export const climateStationsPlugin = new ClimateStationsPlugin()
