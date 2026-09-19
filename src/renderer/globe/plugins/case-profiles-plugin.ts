/**
 * Case Profiles Plugin — Incident management.
 * Tier 5, Priority 18. From OGOS.
 *
 * Loads predefined case scenarios (M Cave, Kenny Veach, Custom) and
 * dispatches markers (LKP, end point, known points of interest) to the globe.
 * Also updates the shared scene context with the case's LKP, bounds, and center
 * so other analysis plugins can operate on the case area.
 */

import * as Cesium from 'cesium'
import type { EarthEnginePlugin, PluginContext, PluginStats, PluginControlSpec } from './plugin-manager'
import type { CaseProfile, CaseMarker } from '@shared/types'

export class CaseProfilesPlugin implements EarthEnginePlugin {
  id = 'case-profiles'
  name = 'Case Profiles (Incident Mgmt)'
  category = 'mission' as const

  private viewer: Cesium.Viewer | null = null
  private dataSource: Cesium.CustomDataSource | null = null
  private ipc: typeof window.api | null = null
  private status: PluginStats = { count: 0, status: 'disabled' }
  private profiles: CaseProfile[] = []
  private activeProfile: CaseProfile | null = null
  private selectedProfileId: string = ''

  async register(ctx: PluginContext): Promise<void> {
    this.viewer = ctx.viewer
    this.ipc = ctx.ipc
    this.dataSource = new Cesium.CustomDataSource('case-profiles')
    ctx.viewer.dataSources.add(this.dataSource)
    this.status = { count: 0, status: 'nominal' }

    // Load profiles from main process
    try {
      const result = await this.ipc!.invoke('case:profiles', {}) as { profiles: CaseProfile[] } | null
      this.profiles = result?.profiles || []
      this.status = { count: this.profiles.length, status: 'nominal' }
    } catch (err) {
      this.status = { count: 0, status: 'error', error: String(err) }
    }
  }

  unregister(): void {
    if (this.dataSource && this.viewer && !this.viewer.isDestroyed?.()) {
      this.viewer.dataSources.remove(this.dataSource)
    }
    this.dataSource = null
    this.profiles = []
    this.activeProfile = null
    this.viewer = null
    this.ipc = null
    this.status = { count: 0, status: 'disabled' }
  }

  update(_ctx: PluginContext): void {}

  getStats(): PluginStats {
    return this.status
  }

  getControls(): PluginControlSpec[] {
    return [
      { type: 'select', id: 'profile', label: 'Case', value: this.activeProfile?.id ?? '', options: this.profiles.map((p) => ({ label: p.name, value: p.id })) },
      { type: 'button', id: 'load', label: 'Load Profile', variant: 'primary' },
      { type: 'button', id: 'clear', label: 'Clear', variant: 'danger', disabled: !this.activeProfile },
      { type: 'separator', id: 'sep1' },
      { type: 'display', id: 'markers', label: 'Markers', value: String(this.activeProfile?.markers.length ?? 0), color: '#ff4a8a' },
      { type: 'display', id: 'desc', label: 'Info', value: this.activeProfile ? this.activeProfile.id : 'none', color: '#4a8aff' },
    ]
  }

  onControl(id: string, value?: unknown): void {
    if (id === 'profile' && typeof value === 'string') {
      this.selectedProfileId = value
    } else if (id === 'load') {
      if (this.selectedProfileId) {
        this.loadProfile(this.selectedProfileId)
      } else if (this.profiles.length > 0) {
        this.loadProfile(this.profiles[0].id)
      }
    } else if (id === 'clear') {
      this.clearProfile()
    }
  }

  getProfiles(): CaseProfile[] {
    return this.profiles
  }

  getActiveProfile(): CaseProfile | null {
    return this.activeProfile
  }

  loadProfile(id: string): void {
    const profile = this.profiles.find((p) => p.id === id)
    if (!profile || !this.dataSource) return

    this.dataSource.entities.removeAll()
    this.activeProfile = profile

    // Add LKP marker
    if (profile.lkp.lng !== 0 || profile.lkp.lat !== 0) {
      this.addMarkerEntity({
        id: `${profile.id}-lkp`,
        label: 'LKP',
        coord: profile.lkp,
        description: 'Last Known Point — starting location',
        color: '#ff4aff',
      })
    }

    // Add end point marker
    if (profile.endPoint.lng !== 0 || profile.endPoint.lat !== 0) {
      this.addMarkerEntity({
        id: `${profile.id}-end`,
        label: 'End Point',
        coord: profile.endPoint,
        description: 'Likely destination',
        color: '#4aff8a',
      })
    }

    // Add known markers
    for (const marker of profile.markers) {
      this.addMarkerEntity(marker)
    }

    // Fly to case center
    if (profile.center.lng !== 0 && this.viewer) {
      this.viewer.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(profile.center.lng, profile.center.lat, 50000),
        duration: 2,
      })
    }

    // Update scene context with the case's LKP so other plugins can use it
    if (this.ipc && profile.lkp.lng !== 0) {
      this.ipc.send('set:scene-context', { lkp: profile.lkp })
    }

    this.status = { count: profile.markers.length + 2, status: 'nominal' }
  }

  clearProfile(): void {
    this.activeProfile = null
    this.dataSource?.entities.removeAll()
    this.status = { count: 0, status: 'nominal' }
  }

  private addMarkerEntity(marker: CaseMarker): void {
    if (!this.dataSource) return

    const color = this.parseColor(marker.color) ?? Cesium.Color.WHITE

    this.dataSource.entities.add({
      id: `case:${marker.id}`,
      position: Cesium.Cartesian3.fromDegrees(marker.coord.lng, marker.coord.lat),
      point: {
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        pixelSize: 12,
        color: new Cesium.ConstantProperty(color),
        outlineColor: new Cesium.ConstantProperty(Cesium.Color.WHITE),
        outlineWidth: new Cesium.ConstantProperty(2),
      },
      label: {
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        text: marker.label,
        font: '11px monospace',
        fillColor: new Cesium.ConstantProperty(color),
        outlineColor: new Cesium.ConstantProperty(Cesium.Color.BLACK),
        outlineWidth: new Cesium.ConstantProperty(2),
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        pixelOffset: new Cesium.Cartesian2(0, -18),
      },
      properties: {
        description: marker.description,
      },
    } as any)
  }

  private parseColor(hex: string): Cesium.Color | null {
    if (!hex || !hex.startsWith('#')) return null
    const r = parseInt(hex.slice(1, 3), 16)
    const g = parseInt(hex.slice(3, 5), 16)
    const b = parseInt(hex.slice(5, 7), 16)
    if (isNaN(r) || isNaN(g) || isNaN(b)) return null
    return Cesium.Color.fromBytes(r, g, b, 255)
  }
}

export const caseProfilesPlugin = new CaseProfilesPlugin()
