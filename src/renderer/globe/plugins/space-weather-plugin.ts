/**
 * Space Weather Plugin — NOAA SWPC data (solar flares, solar wind, Kp index, aurora).
 * Ported from OGOS space weather overlay.
 *
 * Subscribes to SPACE_WEATHER_UPDATE IPC channel.
 * Renders as an informational HUD overlay + aurora circle at poles.
 */

import * as Cesium from 'cesium'
import type { EarthEnginePlugin, PluginContext, PluginStats, PluginControlSpec } from './plugin-manager'
import type { SpaceWeather } from '@shared/types'

export class SpaceWeatherPlugin implements EarthEnginePlugin {
  id = 'space-weather'
  name = 'Space Weather (NOAA SWPC)'
  category = 'climate' as const

  private viewer: Cesium.Viewer | null = null
  private dataSource: Cesium.CustomDataSource | null = null
  private status: PluginStats = { count: 0, status: 'disabled' }
  private show = true
  private unsubscribe: (() => void) | null = null
  private auroraEntities: Cesium.Entity[] = []
  private currentData: SpaceWeather | null = null

  register(ctx: PluginContext): void {
    this.viewer = ctx.viewer
    this.dataSource = new Cesium.CustomDataSource('space-weather')
    this.dataSource.show = this.show
    ctx.viewer.dataSources.add(this.dataSource)
    this.status = { count: 0, status: 'loading' }

    const handler = (data: SpaceWeather) => {
      if (data) {
        this.handleUpdate(data)
      }
    }

    ctx.ipc.spaceWeather.onUpdate(handler)
    this.unsubscribe = () => ctx.ipc.off('space-weather:update')
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
    this.auroraEntities = []
    this.currentData = null
    this.viewer = null
    this.status = { count: 0, status: 'disabled' }
  }

  update(_ctx: PluginContext): void {}

  getStats(): PluginStats {
    return this.status
  }

  getControls(): PluginControlSpec[] {
    const flareClass = this.currentData?.xrayFlareClass ?? '—'
    const kpIndex = this.currentData?.kpIndex != null ? String(this.currentData.kpIndex) : '—'
    return [
      { type: 'toggle', id: 'visible', label: 'Visible', value: this.show },
      { type: 'separator', id: 'sep1' },
      { type: 'display', id: 'count', label: 'Aurora Ovals', value: String(this.status.count), color: this.status.count > 0 ? '#4aff8a' : '#6b7d92' },
      { type: 'display', id: 'flare', label: 'X-ray Flare', value: flareClass, color: flareClass.startsWith('X') ? '#ff4a4a' : flareClass.startsWith('M') ? '#f97316' : '#6b7d92' },
      { type: 'display', id: 'kp', label: 'Kp Index', value: kpIndex, color: this.currentData?.kpIndex != null && this.currentData.kpIndex >= 5 ? '#ff4a4a' : '#4aff8a' },
    ]
  }

  onControl(id: string, value?: unknown): void {
    if (id === 'visible' && typeof value === 'boolean') {
      this.show = value
      if (this.dataSource) this.dataSource.show = value
    }
  }

  private handleUpdate(data: SpaceWeather): void {
    if (!this.dataSource) return
    this.currentData = data

    // Status first so the UI gets data even if the geometry fails
    this.status = {
      count: data.kpIndex != null ? 2 : 0,
      status: 'nominal',
    }

    const hasData = data.kpIndex != null || data.xrayFlareClass != null
    if (!hasData) {
      this.status.status = 'degraded'
      this.status.error = 'SWPC data unavailable'
    } else if (Date.now() - (data.timestamp ?? 0) > 15 * 60 * 1000) {
      this.status.status = 'stale'
      this.status.error = 'using last known space-weather values'
    }

    // Clear old aurora entities
    for (const e of this.auroraEntities) {
      this.dataSource.entities.remove(e)
    }
    this.auroraEntities = []

    // Render aurora oval at poles based on Kp index — show it for any measured Kp
    const kp = data.kpIndex ?? 0
    if (data.kpIndex != null) {
      try {
        // Kp 0 = ~2° from pole; Kp 9 = ~38° from pole
        const radiusDeg = 2 + kp * 4
        for (const pole of [89.5, -89.5]) {
          const entity = this.dataSource.entities.add({
            id: `aurora:${pole > 0 ? 'north' : 'south'}`,
            position: Cesium.Cartesian3.fromDegrees(0, pole, 100000),
            ellipse: {
              semiMajorAxis: radiusDeg * 111000,
              semiMinorAxis: radiusDeg * 111000,
              material: Cesium.Color.fromBytes(0, 255, 120, 80),
            } as any,
          } as any)
          this.auroraEntities.push(entity)
        }
      } catch (err) {
        console.error('[space-weather] aurora geometry failed:', err)
      }
    }
  }
}

export const spaceWeatherPlugin = new SpaceWeatherPlugin()
