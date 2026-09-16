/**
 * Hiker Profile Plugin — psychological + perceptual calibration.
 * Tier 5, Priority 20. From OGOS.
 *
 * Lets the user input a hiker profile (claimed time, navigation method,
 * risk tolerance, goal orientation, calibration anchors) and renders:
 *  - Reach radius rings (contracted / nominal / expanded)
 *  - Beyond-LKP search cone (bearing + angular spread)
 *  - Calibration summary (actual speed, perception scale, multi-day)
 *
 * The calibrated model can be fed into the route planner and search zone
 * generator to produce more accurate analysis.
 */

import * as Cesium from 'cesium'
import type { EarthEnginePlugin, PluginContext, PluginStats, PluginControlSpec } from './plugin-manager'
import type { HikerProfile, CalibratedHikerModel, TripParams, LngLat } from '@shared/types'

const DEFAULT_TRIP_PARAMS: TripParams = {
  hoursSinceLastSeen: 12,
  day: 1,
  pace: 'normal',
  packWeight: 'medium',
  experience: 'experienced',
  weather: 'clear',
  temperatureC: 20,
  timeOfDay: 'midday',
  ageGroup: 'adult',
  fitness: 'average',
}

interface CalibrationResult {
  model: CalibratedHikerModel
  reachRadius: { nominalM: number; expandedM: number; contractedM: number }
  beyondLkpCone: {
    center: LngLat
    bearing: number
    angularSpreadDeg: number
    minRadiusM: number
    maxRadiusM: number
  } | null
}

export class HikerProfilePlugin implements EarthEnginePlugin {
  id = 'hiker-profile'
  name = 'Hiker Profile (Calibration)'
  category = 'mission' as const

  private viewer: Cesium.Viewer | null = null
  private dataSource: Cesium.CustomDataSource | null = null
  private ipc: typeof window.api | null = null
  private status: PluginStats = { count: 0, status: 'disabled' }
  private lkp: LngLat | null = null
  private result: CalibrationResult | null = null

  async register(ctx: PluginContext): Promise<void> {
    this.viewer = ctx.viewer
    this.ipc = ctx.ipc
    this.dataSource = new Cesium.CustomDataSource('hiker-profile')
    ctx.viewer.dataSources.add(this.dataSource)
    this.status = { count: 0, status: 'nominal' }
  }

  unregister(): void {
    if (this.dataSource && this.viewer && !this.viewer.isDestroyed?.()) {
      this.viewer.dataSources.remove(this.dataSource)
    }
    this.dataSource = null
    this.viewer = null
    this.ipc = null
    this.lkp = null
    this.result = null
    this.status = { count: 0, status: 'disabled' }
  }

  update(ctx: PluginContext): void {
    const sceneCtx = ctx.sceneContext as any
    const lkp = sceneCtx?.lkp
    if (lkp && (!this.lkp || this.lkp.lng !== lkp.lng || this.lkp.lat !== lkp.lat)) {
      this.lkp = lkp
    }
  }

  getStats(): PluginStats {
    return this.status
  }

  getControls(): PluginControlSpec[] {
    return [
      { type: 'button', id: 'run', label: 'Calibrate (Default)', variant: 'primary' },
      { type: 'button', id: 'clear', label: 'Clear', variant: 'danger', disabled: !this.result },
      { type: 'separator', id: 'sep1' },
      { type: 'display', id: 'speed', label: 'Speed', value: this.result ? `${this.result.model.actualWalkSpeedMps.toFixed(2)} m/s` : '—', color: '#4aff8a' },
      { type: 'display', id: 'hours', label: 'Trip Hours', value: this.result ? `${this.result.model.totalTripHours.toFixed(1)}h` : '—', color: '#ffd24a' },
      { type: 'display', id: 'multi', label: 'Multi-day', value: this.result?.model.isMultiDay ? 'yes' : 'no', color: this.result?.model.isMultiDay ? '#ff8a4a' : '#4a8aff' },
      { type: 'display', id: 'risk', label: 'Disorient', value: this.result ? `${(this.result.model.disorientationRisk * 100).toFixed(0)}%` : '—', color: '#ff4a8a' },
      { type: 'display', id: 'reach', label: 'Reach (nom)', value: this.result ? `${(this.result.reachRadius.nominalM / 1000).toFixed(1)}km` : '—', color: '#4a8aff' },
    ]
  }

  onControl(id: string): void {
    if (id === 'run') {
      this.runCalibration()
    } else if (id === 'clear') {
      this.dataSource?.entities.removeAll()
      this.result = null
      this.status = { count: 0, status: 'nominal' }
    }
  }

  getResult(): CalibrationResult | null {
    return this.result
  }

  private async runCalibration(): Promise<void> {
    if (!this.ipc || !this.dataSource || !this.lkp) {
      this.status = { ...this.status, status: 'error', error: 'No LKP set — place a pin first' }
      return
    }

    this.status = { ...this.status, status: 'loading' }

    try {
      // Build a default hiker profile centered on the LKP.
      // In a full UI, the user would edit these via form controls.
      const tripParams: TripParams = DEFAULT_TRIP_PARAMS
      const profile: HikerProfile = {
        tripParams,
        perceptionAccuracy: 'approximate',
        navigationMethod: 'compass-map',
        riskTolerance: 'moderate',
        goalOrientation: 'exploration',
        claimedTripHours: 8,
        calibrationAnchors: [
          { label: 'Start', point: this.lkp, hoursFromStart: 0, confidence: 'exact', isEndpoint: false },
        ],
        claimedMultiDay: false,
        plannedDays: 1,
        hasCampingGear: false,
      }

      const result = await this.ipc.invoke('hiker:calibrate', profile) as CalibrationResult | null
      if (!result?.model) {
        this.status = { ...this.status, status: 'nominal' }
        return
      }

      this.result = result
      this.dataSource.entities.removeAll()

      // Render reach radius rings around the LKP
      this.addReachRings(this.lkp, result.reachRadius)

      // Render beyond-LKP search cone if available
      if (result.beyondLkpCone) {
        this.addSearchCone(result.beyondLkpCone)
      }

      this.status = { count: 3 + (result.beyondLkpCone ? 1 : 0), status: 'nominal' }
    } catch (err) {
      console.warn('[hiker-profile] calibration failed:', err)
      this.status = { ...this.status, status: 'error', error: String(err) }
    }
  }

  private addReachRings(center: LngLat, reach: { nominalM: number; expandedM: number; contractedM: number }): void {
    if (!this.dataSource) return
    const rings: { radius: number; color: Cesium.Color; label: string }[] = [
      { radius: reach.contractedM, color: Cesium.Color.fromBytes(74, 255, 138, 180), label: 'Contracted' },
      { radius: reach.nominalM, color: Cesium.Color.fromBytes(255, 210, 74, 180), label: 'Nominal' },
      { radius: reach.expandedM, color: Cesium.Color.fromBytes(255, 74, 74, 180), label: 'Expanded' },
    ]

    for (const ring of rings) {
      if (ring.radius <= 0) continue
      const positions = this.circlePositions(center, ring.radius)
      this.dataSource.entities.add({
        id: `hiker:reach-${ring.label}`,
        polyline: {
          positions: new Cesium.ConstantProperty(positions),
          width: new Cesium.ConstantProperty(2),
          material: new Cesium.ColorMaterialProperty(ring.color),
          clampToGround: true,
        },
        properties: { radius: ring.radius, label: ring.label },
      } as any)
    }
  }

  private addSearchCone(cone: { center: LngLat; bearing: number; angularSpreadDeg: number; minRadiusM: number; maxRadiusM: number }): void {
    if (!this.dataSource || cone.maxRadiusM <= 0) return

    // Build a cone polygon: center + arc from (bearing - spread/2) to (bearing + spread/2)
    const halfSpread = cone.angularSpreadDeg / 2
    const startBearing = cone.bearing - halfSpread
    const endBearing = cone.bearing + halfSpread
    const steps = 32

    const positions: Cesium.Cartesian3[] = [Cesium.Cartesian3.fromDegrees(cone.center.lng, cone.center.lat)]
    for (let i = 0; i <= steps; i++) {
      const t = i / steps
      const bearing = startBearing + (endBearing - startBearing) * t
      const dest = this.destinationPoint(cone.center, cone.maxRadiusM, bearing)
      positions.push(Cesium.Cartesian3.fromDegrees(dest.lng, dest.lat))
    }

    this.dataSource.entities.add({
      id: 'hiker:search-cone',
      polygon: {
        hierarchy: new Cesium.PolygonHierarchy(positions),
        material: new Cesium.ColorMaterialProperty(Cesium.Color.fromBytes(255, 138, 74, 60)),
      },
      properties: { bearing: cone.bearing, spread: cone.angularSpreadDeg, maxRadiusM: cone.maxRadiusM },
    } as any)
  }

  private circlePositions(center: LngLat, radiusM: number): Cesium.Cartesian3[] {
    const positions: Cesium.Cartesian3[] = []
    const steps = 64
    for (let i = 0; i <= steps; i++) {
      const bearing = (i / steps) * 360
      const dest = this.destinationPoint(center, radiusM, bearing)
      positions.push(Cesium.Cartesian3.fromDegrees(dest.lng, dest.lat))
    }
    return positions
  }

  private destinationPoint(origin: LngLat, distanceM: number, bearingDeg: number): LngLat {
    const R = 6371000
    const bearing = (bearingDeg * Math.PI) / 180
    const lat1 = (origin.lat * Math.PI) / 180
    const lng1 = (origin.lng * Math.PI) / 180
    const d = distanceM / R

    const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(bearing))
    const lng2 = lng1 + Math.atan2(
      Math.sin(bearing) * Math.sin(d) * Math.cos(lat1),
      Math.cos(d) - Math.sin(lat1) * Math.sin(lat2),
    )

    return {
      lng: ((lng2 * 180) / Math.PI + 540) % 360 - 180,
      lat: (lat2 * 180) / Math.PI,
    }
  }
}

export const hikerProfilePlugin = new HikerProfilePlugin()
