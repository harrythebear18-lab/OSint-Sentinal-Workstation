/**
 * Routes Plugin — Least-cost pathfinding with Tobler's hiking function.
 * Tier 2, Priority 5. Both repos use routes for SAR + entity movement.
 *
 * Requests A* route from main process via IPC, renders as Cesium polyline.
 * Supports start/end points via globe click or scene context selection.
 */

import * as Cesium from 'cesium'
import type { EarthEnginePlugin, PluginContext, PluginStats, PluginControlSpec } from './plugin-manager'

interface RouteResult {
  id: string
  coordinates: number[][] // [lon, lat, elev]
  distance: number
  duration: number
  ascent: number
  descent: number
  difficulty: 'easy' | 'moderate' | 'hard' | 'extreme'
}

export class RoutesPlugin implements EarthEnginePlugin {
  id = 'routes'
  name = 'Routes (A* + Tobler)'
  category = 'mapping' as const

  private viewer: Cesium.Viewer | null = null
  private dataSource: Cesium.CustomDataSource | null = null
  private ipc: typeof window.api | null = null
  private status: PluginStats = { count: 0, status: 'disabled' }
  private routes = new Map<string, RouteResult>()
  private start: { lon: number; lat: number } | null = null
  private end: { lon: number; lat: number } | null = null
  private clickHandler: Cesium.ScreenSpaceEventHandler | null = null

  async register(ctx: PluginContext): Promise<void> {
    this.viewer = ctx.viewer
    this.ipc = ctx.ipc
    this.dataSource = new Cesium.CustomDataSource('routes')
    ctx.viewer.dataSources.add(this.dataSource)
    this.status = { count: 0, status: 'nominal' }

    // Click-to-place start/end
    this.clickHandler = new Cesium.ScreenSpaceEventHandler(ctx.viewer.canvas)
    this.clickHandler.setInputAction((click: any) => {
      this.handleClick(click)
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK)
  }

  unregister(): void {
    this.clickHandler?.destroy()
    this.clickHandler = null
    if (this.dataSource && this.viewer && !this.viewer.isDestroyed?.()) {
      this.viewer.dataSources.remove(this.dataSource)
    }
    this.dataSource = null
    this.routes.clear()
    this.start = null
    this.end = null
    this.viewer = null
    this.ipc = null
    this.status = { count: 0, status: 'disabled' }
  }

  update(ctx: PluginContext): void {
    // If no start point set yet, use LKP as default start
    if (!this.start) {
      const sceneCtx = ctx.sceneContext as any
      const lkp = sceneCtx?.lkp
      if (lkp) {
        this.start = { lon: lkp.lng, lat: lkp.lat }
        this.updateMarkers()
      }
    }
  }

  getStats(): PluginStats {
    return this.status
  }

  getControls(): PluginControlSpec[] {
    return [
      { type: 'display', id: 'start', label: 'Start', value: this.start ? `${this.start.lon.toFixed(4)}°, ${this.start.lat.toFixed(4)}°` : 'Place LKP pin or click', color: this.start ? '#4aff8a' : '#6b7d92' },
      { type: 'display', id: 'end', label: 'End', value: this.end ? `${this.end.lon.toFixed(4)}°, ${this.end.lat.toFixed(4)}°` : 'Click globe to set', color: this.end ? '#ff4a4a' : '#6b7d92' },
      { type: 'button', id: 'clear', label: 'Clear Route', variant: 'danger', disabled: this.routes.size === 0 },
      { type: 'separator', id: 'sep1' },
      { type: 'display', id: 'routes', label: 'Routes', value: String(this.routes.size), color: '#4a9eff' },
    ]
  }

  onControl(id: string): void {
    if (id === 'clear') {
      this.clearAll()
    }
  }

  getStart(): { lon: number; lat: number } | null {
    return this.start
  }

  getEnd(): { lon: number; lat: number } | null {
    return this.end
  }

  setStart(lon: number, lat: number): void {
    this.start = { lon, lat }
    this.updateMarkers()
    if (this.end) this.computeRoute()
  }

  setEnd(lon: number, lat: number): void {
    this.end = { lon, lat }
    this.updateMarkers()
    if (this.start) this.computeRoute()
  }

  clearAll(): void {
    this.routes.clear()
    this.start = null
    this.end = null
    this.dataSource?.entities.removeAll()
    this.status = { count: 0, status: 'nominal' }
  }

  private handleClick(click: any): void {
    if (!this.viewer) return
    const cart = this.viewer.scene.pickPosition(click.position)
    if (!cart) {
      // Fallback: pick ellipsoid
      const ray = this.viewer.camera.getPickRay(click.position)
      if (!ray) return
      const c = this.viewer.scene.globe.pick(ray, this.viewer.scene)
      if (!c) return
      const carto = Cesium.Cartographic.fromCartesian(c)
      this.placePoint(Cesium.Math.toDegrees(carto.longitude), Cesium.Math.toDegrees(carto.latitude))
      return
    }
    const carto = Cesium.Cartographic.fromCartesian(cart)
    this.placePoint(Cesium.Math.toDegrees(carto.longitude), Cesium.Math.toDegrees(carto.latitude))
  }

  private placePoint(lon: number, lat: number): void {
    if (!this.start) {
      this.setStart(lon, lat)
    } else if (!this.end) {
      this.setEnd(lon, lat)
    } else {
      // Both placed — start new route
      this.clearAll()
      this.setStart(lon, lat)
    }
  }

  private updateMarkers(): void {
    if (!this.dataSource) return
    // Remove old markers
    const markers = ['route:start', 'route:end']
    for (const id of markers) this.dataSource.entities.removeById(id)

    if (this.start) {
      this.dataSource.entities.add({
        id: 'route:start',
        position: Cesium.Cartesian3.fromDegrees(this.start.lon, this.start.lat),
        point: {
          pixelSize: 12,
          color: Cesium.Color.fromBytes(74, 255, 138, 255),
          outlineColor: Cesium.Color.WHITE,
          outlineWidth: 2,
        },
        label: {
          text: 'START',
          font: '11px monospace',
          fillColor: Cesium.Color.fromBytes(74, 255, 138, 255),
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 2,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          pixelOffset: new Cesium.Cartesian2(0, -18),
        },
      } as any)
    }

    if (this.end) {
      this.dataSource.entities.add({
        id: 'route:end',
        position: Cesium.Cartesian3.fromDegrees(this.end.lon, this.end.lat),
        point: {
          pixelSize: 12,
          color: Cesium.Color.fromBytes(255, 74, 74, 255),
          outlineColor: Cesium.Color.WHITE,
          outlineWidth: 2,
        },
        label: {
          text: 'END',
          font: '11px monospace',
          fillColor: Cesium.Color.fromBytes(255, 74, 74, 255),
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 2,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          pixelOffset: new Cesium.Cartesian2(0, -18),
        },
      } as any)
    }
  }

  private async computeRoute(): Promise<void> {
    if (!this.ipc || !this.start || !this.end || !this.dataSource) return
    this.status = { ...this.status, status: 'loading' }

    try {
      const result = await this.ipc.invoke('terrain:route:plan', {
        start: { lng: this.start.lon, lat: this.start.lat },
        end: { lng: this.end.lon, lat: this.end.lat },
      }) as { primary: { lng: number; lat: number }[]; distanceM: number; ascentM: number; descentM: number } | null

      if (!result?.primary || result.primary.length < 2) {
        this.status = { count: 0, status: 'error', error: 'No route returned' }
        return
      }

      const route: RouteResult = {
        id: `route-${Date.now()}`,
        coordinates: result.primary.map((p) => [p.lng, p.lat]),
        distance: result.distanceM,
        duration: result.distanceM / 1.1, // approx walking time
        ascent: result.ascentM,
        descent: result.descentM,
        difficulty: result.ascentM > 500 ? 'extreme' : result.ascentM > 200 ? 'hard' : result.ascentM > 50 ? 'moderate' : 'easy',
      }
      this.routes.set(route.id, route)
      this.addRouteEntity(route)
      this.status = { count: this.routes.size, status: 'nominal' }
    } catch (err) {
      this.status = { ...this.status, status: 'error', error: String(err) }
      console.warn('[routes] compute failed:', err)
    }
  }

  private addRouteEntity(route: RouteResult): void {
    if (!this.dataSource || route.coordinates.length < 2) return

    const positions = route.coordinates.map(([lon, lat]) =>
      Cesium.Cartesian3.fromDegrees(lon, lat),
    )

    const color = route.difficulty === 'extreme'
      ? Cesium.Color.fromBytes(255, 74, 74, 255)
      : route.difficulty === 'hard'
        ? Cesium.Color.fromBytes(255, 138, 74, 255)
        : route.difficulty === 'moderate'
          ? Cesium.Color.fromBytes(255, 234, 74, 255)
          : Cesium.Color.fromBytes(74, 255, 138, 255)

    this.dataSource.entities.add({
      id: `route:${route.id}`,
      polyline: {
        positions: new Cesium.ConstantProperty(positions),
        width: new Cesium.ConstantProperty(4),
        material: new Cesium.PolylineGlowMaterialProperty({
          glowPower: 0.2,
          color: new Cesium.ConstantProperty(color),
        }),
        clampToGround: true,
      },
      properties: {
        distance: route.distance,
        duration: route.duration,
        ascent: route.ascent,
        descent: route.descent,
        difficulty: route.difficulty,
      },
    } as any)
  }
}

export const routesPlugin = new RoutesPlugin()
