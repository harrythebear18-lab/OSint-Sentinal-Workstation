/**
 * Predictions Plugin — severe weather, storm tracks, SST anomalies, precipitation.
 * Ported from OGOS GlobalOverlays prediction overlay layers.
 *
 * Subscribes to PREDICTION_UPDATE IPC channel.
 * Renders prediction alerts as colored circles + storm tracks as polylines.
 */

import * as Cesium from 'cesium'
import type { EarthEnginePlugin, PluginContext, PluginStats, PluginControlSpec } from './plugin-manager'
import type { PredictionUpdate, PredictionAlert, StormTrackPrediction, SstAnomaly } from '@shared/types'

function severityColor(severity: string): Cesium.Color {
  switch (severity) {
    case 'low': return Cesium.Color.fromBytes(34, 197, 94, 120)
    case 'moderate': return Cesium.Color.fromBytes(251, 191, 36, 120)
    case 'high': return Cesium.Color.fromBytes(249, 115, 22, 150)
    case 'critical': return Cesium.Color.fromBytes(239, 68, 68, 180)
    default: return Cesium.Color.fromBytes(100, 116, 139, 100)
  }
}

export class PredictionsPlugin implements EarthEnginePlugin {
  id = 'predictions'
  name = 'Predictions'
  category = 'mission' as const

  private viewer: Cesium.Viewer | null = null
  private dataSource: Cesium.CustomDataSource | null = null
  private status: PluginStats = { count: 0, status: 'disabled' }
  private unsubscribe: (() => void) | null = null
  private knownAlerts = new Set<string>()
  private knownTracks = new Set<string>()
  private knownSst = new Set<string>()

  register(ctx: PluginContext): void {
    this.viewer = ctx.viewer
    this.dataSource = new Cesium.CustomDataSource('predictions')
    ctx.viewer.dataSources.add(this.dataSource)
    this.status = { count: 0, status: 'loading' }

    const handler = (update: PredictionUpdate) => {
      if (update) {
        this.handleUpdate(update)
      }
    }

    ctx.ipc.predictions.onUpdate(handler)
    this.unsubscribe = () => ctx.ipc.off('prediction:update')
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
    this.knownAlerts.clear()
    this.knownTracks.clear()
    this.knownSst.clear()
    this.viewer = null
    this.status = { count: 0, status: 'disabled' }
  }

  update(_ctx: PluginContext): void {}

  getStats(): PluginStats {
    return this.status
  }

  getControls(): PluginControlSpec[] {
    return [
      { type: 'display', id: 'alerts', label: 'Alerts', value: String(this.knownAlerts.size), color: '#ff8a4a' },
      { type: 'display', id: 'tracks', label: 'Storm Tracks', value: String(this.knownTracks.size), color: '#ff4a4a' },
      { type: 'display', id: 'sst', label: 'SST Anomalies', value: String(this.knownSst.size), color: '#4a9eff' },
      { type: 'separator', id: 'sep1' },
      { type: 'button', id: 'clear', label: 'Clear All', variant: 'danger', disabled: this.knownAlerts.size === 0 && this.knownTracks.size === 0 && this.knownSst.size === 0 },
    ]
  }

  onControl(id: string): void {
    if (id === 'clear') {
      this.dataSource?.entities.removeAll()
      this.knownAlerts.clear()
      this.knownTracks.clear()
      this.knownSst.clear()
      this.status = { count: 0, status: 'nominal' }
    }
  }

  private handleUpdate(update: PredictionUpdate): void {
    if (!this.dataSource) return

    const allAlerts = [
      ...(update.severeWeather || []),
      ...(update.precipitation || []),
      ...(update.climateAnomalies || []),
      ...(update.sensorFailures || []),
    ]

    // Clear old alert entities
    const newAlertIds = new Set(allAlerts.map((a) => a.id))
    for (const id of this.knownAlerts) {
      if (!newAlertIds.has(id)) {
        this.dataSource.entities.removeById(`pred:${id}`)
        this.knownAlerts.delete(id)
      }
    }

    for (const alert of allAlerts) {
      this.updateAlertEntity(alert)
      this.knownAlerts.add(alert.id)
    }

    // Storm tracks
    const tracks = update.stormTracks || []
    const newTrackIds = new Set(tracks.map((t) => t.stormId))
    for (const id of this.knownTracks) {
      if (!newTrackIds.has(id)) {
        this.dataSource.entities.removeById(`pred-track:${id}`)
        this.knownTracks.delete(id)
      }
    }

    for (const track of tracks) {
      this.updateTrackEntity(track)
      this.knownTracks.add(track.stormId)
    }

    // SST anomalies
    const sst = update.sstAnomalies || []
    const newSstIds = new Set(sst.map((s, i) => `sst-${i}`))
    for (const id of this.knownSst) {
      if (!newSstIds.has(id)) {
        this.dataSource.entities.removeById(`sst:${id}`)
        this.knownSst.delete(id)
      }
    }

    sst.forEach((s, i) => {
      this.updateSstEntity(s, i)
      this.knownSst.add(`sst-${i}`)
    })

    const total = allAlerts.length + tracks.length + sst.length
    this.status = { count: total, status: 'nominal' }
  }

  private updateAlertEntity(alert: PredictionAlert): void {
    if (!this.dataSource) return
    const id = `pred:${alert.id}`
    const position = Cesium.Cartesian3.fromDegrees(alert.lon, alert.lat, 0)
    const color = severityColor(alert.severity)
    const radius = (alert.radiusKm ?? 50) * 1000 // meters

    const existing = this.dataSource.entities.getById(id)
    if (!existing) {
      this.dataSource.entities.add({
        id,
        position: new Cesium.ConstantPositionProperty(position),
        ellipse: {
          semiMajorAxis: new Cesium.ConstantProperty(radius),
          semiMinorAxis: new Cesium.ConstantProperty(radius),
          material: color,
          outline: true,
          outlineColor: color.withAlpha(0.8),
        },
        label: {
          text: alert.title.substring(0, 30),
          font: '9px monospace',
          fillColor: Cesium.Color.WHITE,
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 2,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          pixelOffset: new Cesium.Cartesian2(0, -14),
        },
        properties: {
          severity: alert.severity,
          confidence: alert.confidence,
          description: alert.description,
          type: alert.type,
        },
      } as any)
    } else {
      ;(existing.position as Cesium.ConstantPositionProperty).setValue(position)
    }
  }

  private updateTrackEntity(track: StormTrackPrediction): void {
    if (!this.dataSource) return
    const id = `pred-track:${track.stormId}`
    if (!track.positions || track.positions.length < 2) {
      this.dataSource.entities.removeById(id)
      return
    }

    const positions = track.positions.map((p) =>
      Cesium.Cartesian3.fromDegrees(p.lon, p.lat, 0),
    )

    const existing = this.dataSource.entities.getById(id)
    if (!existing) {
      this.dataSource.entities.add({
        id,
        polyline: {
          positions: new Cesium.ConstantProperty(positions),
          material: Cesium.Color.fromBytes(255, 100, 100, 150),
          width: 2,
          arcType: Cesium.ArcType.NONE,
        },
      } as any)
    } else {
      ;(existing.polyline!.positions as Cesium.ConstantProperty).setValue(positions)
    }
  }

  private updateSstEntity(sst: SstAnomaly, index: number): void {
    if (!this.dataSource) return
    const id = `sst:sst-${index}`
    const position = Cesium.Cartesian3.fromDegrees(sst.lon, sst.lat, 0)

    // Color: blue for cold anomaly, red for warm
    const abs = Math.abs(sst.anomaly)
    const color = sst.anomaly > 0
      ? Cesium.Color.fromBytes(239, 68, 68, Math.min(200, abs * 50))
      : Cesium.Color.fromBytes(59, 130, 246, Math.min(200, abs * 50))

    const radius = Math.min(abs * 50000, 500000)

    const existing = this.dataSource.entities.getById(id)
    if (!existing) {
      this.dataSource.entities.add({
        id,
        position: new Cesium.ConstantPositionProperty(position),
        ellipse: {
          semiMajorAxis: new Cesium.ConstantProperty(radius),
          semiMinorAxis: new Cesium.ConstantProperty(radius),
          material: color,
          outline: true,
          outlineColor: color.withAlpha(0.8),
        },
        properties: {
          anomaly: sst.anomaly,
          region: sst.region,
        },
      } as any)
    } else {
      ;(existing.position as Cesium.ConstantPositionProperty).setValue(position)
    }
  }
}

export const predictionsPlugin = new PredictionsPlugin()
