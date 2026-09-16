/**
 * Behavior Engine Plugin — Multi-agent terrain simulation.
 * Tier 2, Priority 7. UEBS2-style agents with A*, hazards, fatigue.
 *
 * Calls the main process behavior engine (one-shot) which simulates
 * likely movement paths of a missing person from an LKP, with downhill
 * bias and terrain-aware random walk. Renders paths as polylines and
 * density zones as heat polygons.
 */

import * as Cesium from 'cesium'
import type { EarthEnginePlugin, PluginContext, PluginStats, PluginControlSpec } from './plugin-manager'
import type { BehaviorEngineResponse } from '@shared/types'

export class BehaviorEnginePlugin implements EarthEnginePlugin {
  id = 'behavior-engine'
  name = 'Behavior Engine (Multi-Agent)'
  category = 'mission' as const

  private viewer: Cesium.Viewer | null = null
  private dataSource: Cesium.CustomDataSource | null = null
  private ipc: typeof window.api | null = null
  private status: PluginStats = { count: 0, status: 'disabled' }
  private lkp: { lon: number; lat: number } | null = null
  private hours = 4
  private hasResults = false

  async register(ctx: PluginContext): Promise<void> {
    this.viewer = ctx.viewer
    this.ipc = ctx.ipc
    this.dataSource = new Cesium.CustomDataSource('behavior-engine')
    ctx.viewer.dataSources.add(this.dataSource)
    this.status = { count: 0, status: 'nominal' }
  }

  unregister(): void {
    if (this.dataSource && this.viewer && !this.viewer.isDestroyed?.()) {
      this.viewer.dataSources.remove(this.dataSource)
    }
    this.dataSource = null
    this.lkp = null
    this.hasResults = false
    this.viewer = null
    this.ipc = null
    this.status = { count: 0, status: 'disabled' }
  }

  update(ctx: PluginContext): void {
    // Sync LKP from scene context (placed via DrawTools pin mode)
    const sceneCtx = ctx.sceneContext as any
    const ctxLkp = sceneCtx?.lkp
    if (ctxLkp) {
      const newLkp = { lon: ctxLkp.lng, lat: ctxLkp.lat }
      if (!this.lkp || this.lkp.lon !== newLkp.lon || this.lkp.lat !== newLkp.lat) {
        this.lkp = newLkp
      }
    }
  }

  getStats(): PluginStats {
    return this.status
  }

  getControls(): PluginControlSpec[] {
    return [
      { type: 'display', id: 'lkp', label: 'LKP', value: this.lkp ? `${this.lkp.lon.toFixed(4)}°, ${this.lkp.lat.toFixed(4)}°` : 'Not set — use 📌 pin tool', color: this.lkp ? '#ff4a4a' : '#6b7d92' },
      { type: 'slider', id: 'hours', label: 'Hours', value: this.hours, min: 1, max: 24, step: 1 },
      { type: 'button', id: 'run', label: 'Run Simulation', variant: 'primary', disabled: !this.lkp },
      { type: 'button', id: 'clear', label: 'Clear', variant: 'danger', disabled: !this.hasResults },
      { type: 'separator', id: 'sep1' },
      { type: 'display', id: 'state', label: 'State', value: this.hasResults ? 'RESULTS' : 'IDLE', color: this.hasResults ? '#4aff8a' : '#6b7d92' },
    ]
  }

  onControl(id: string, value?: unknown): void {
    if (id === 'hours' && typeof value === 'number') {
      this.hours = value
    } else if (id === 'run' && this.lkp) {
      this.runSimulation()
    } else if (id === 'clear') {
      this.clearAll()
    }
  }

  setLkp(lon: number, lat: number): void {
    this.lkp = { lon, lat }
  }

  clearAll(): void {
    this.dataSource?.entities.removeAll()
    this.hasResults = false
    this.status = { count: 0, status: 'nominal' }
  }

  private async runSimulation(): Promise<void> {
    if (!this.ipc || !this.lkp || !this.dataSource) return
    this.status = { ...this.status, status: 'loading' }

    try {
      const result = await this.ipc.invoke('terrain:behavior:engine', {
        lkp: { lng: this.lkp.lon, lat: this.lkp.lat },
        hours: this.hours,
      }) as BehaviorEngineResponse | null

      if (!result?.paths) {
        this.status = { count: 0, status: 'nominal' }
        return
      }

      this.dataSource.entities.removeAll()

      // Render simulation paths as polylines
      for (let i = 0; i < result.paths.length; i++) {
        const path = result.paths[i]
        if (path.length < 2) continue
        this.addPathEntity(path, i)
      }

      // Render density zones as heat polygons
      for (const zone of result.densityZones) {
        this.addDensityEntity(zone)
      }

      this.hasResults = true
      this.status = { count: result.paths.length, status: 'nominal' }
    } catch (err) {
      this.status = { ...this.status, status: 'error', error: String(err) }
      console.warn('[behavior-engine] simulation failed:', err)
    }
  }

  private addPathEntity(path: { lng: number; lat: number }[], index: number): void {
    if (!this.dataSource) return
    const positions = path.map((c) => Cesium.Cartesian3.fromDegrees(c.lng, c.lat))

    this.dataSource.entities.add({
      id: `behavior-path:${index}`,
      polyline: {
        positions: new Cesium.ConstantProperty(positions),
        width: new Cesium.ConstantProperty(2),
        material: new Cesium.ColorMaterialProperty(
          Cesium.Color.fromBytes(74, 158, 255, 180),
        ),
        clampToGround: true,
      },
    } as any)
  }

  private addDensityEntity(zone: { id: string; coords: { lng: number; lat: number }[]; density: number }): void {
    if (!this.dataSource || zone.coords.length < 3) return
    const positions = zone.coords.map((c) => Cesium.Cartesian3.fromDegrees(c.lng, c.lat))

    // Density heat: high density = red, low = blue
    const t = Math.max(0, Math.min(1, zone.density))
    const color = Cesium.Color.fromBytes(
      Math.round(74 + (255 - 74) * t),
      Math.round(158 - (158 - 74) * t),
      Math.round(255 - (255 - 74) * t),
      200,
    )

    this.dataSource.entities.add({
      id: `behavior-density:${zone.id}`,
      polygon: {
        hierarchy: new Cesium.PolygonHierarchy(positions),
        material: new Cesium.ColorMaterialProperty(color.withAlpha(0.4)),
      },
      properties: { density: zone.density },
    } as any)
  }
}

export const behaviorEnginePlugin = new BehaviorEnginePlugin()
