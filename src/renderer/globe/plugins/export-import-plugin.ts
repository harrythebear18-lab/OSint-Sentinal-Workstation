/**
 * Export/Import Plugin — GeoJSON / KML / KMZ.
 * Tier 5, Priority 19. From OGOS.
 *
 * Exports current analysis results from all active plugins to GeoJSON/KML.
 * Imports KML/KMZ files and renders them as Cesium entities on the globe.
 * Uses Electron save/open dialogs via IPC.
 */

import * as Cesium from 'cesium'
import type { EarthEnginePlugin, PluginContext, PluginStats, PluginControlSpec } from './plugin-manager'
import { pluginManager } from './plugin-manager'
import type { ImportResult, ImportedFeature } from '@shared/types'

export class ExportImportPlugin implements EarthEnginePlugin {
  id = 'export-import'
  name = 'Export / Import (GeoJSON/KML)'
  category = 'media' as const

  private viewer: Cesium.Viewer | null = null
  private dataSource: Cesium.CustomDataSource | null = null
  private ipc: typeof window.api | null = null
  private status: PluginStats = { count: 0, status: 'disabled' }
  private importedFeatures: ImportedFeature[] = []

  async register(ctx: PluginContext): Promise<void> {
    this.viewer = ctx.viewer
    this.ipc = ctx.ipc
    this.dataSource = new Cesium.CustomDataSource('export-import')
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
    this.importedFeatures = []
    this.status = { count: 0, status: 'disabled' }
  }

  update(_ctx: PluginContext): void {}

  getStats(): PluginStats {
    return this.status
  }

  getControls(): PluginControlSpec[] {
    return [
      { type: 'button', id: 'exportGeoJSON', label: 'Export GeoJSON', variant: 'primary' },
      { type: 'button', id: 'exportKML', label: 'Export KML', variant: 'primary' },
      { type: 'button', id: 'exportPNG', label: 'Export Screenshot (PNG)', variant: 'primary' },
      { type: 'button', id: 'import', label: 'Import KML/KMZ', variant: 'default' },
      { type: 'button', id: 'clear', label: 'Clear Imports', variant: 'danger', disabled: this.importedFeatures.length === 0 },
      { type: 'separator', id: 'sep1' },
      { type: 'display', id: 'imported', label: 'Imported', value: String(this.importedFeatures.length), color: '#4aff8a' },
    ]
  }

  async onControl(id: string): Promise<void> {
    if (id === 'exportGeoJSON') {
      await this.exportGeoJSON()
    } else if (id === 'exportKML') {
      await this.exportKML()
    } else if (id === 'exportPNG') {
      await this.exportPNG()
    } else if (id === 'import') {
      await this.importFile()
    } else if (id === 'clear') {
      this.dataSource?.entities.removeAll()
      this.importedFeatures = []
      this.status = { count: 0, status: 'nominal' }
    }
  }

  /**
   * Collect analysis results from all active plugins via the plugin manager.
   * Each analysis plugin exposes getter methods (getZones, getPaths, etc.)
   * that we use to build the export payload matching export-service.ts keys.
   */
  private collectResults(): Record<string, unknown> {
    const results: Record<string, unknown> = {}
    const active = pluginManager.getActive()
    const getPlugin = (id: string) => {
      const all = pluginManager.getPlugins()
      return all.find((p) => p.id === id)
    }

    for (const id of active) {
      const plugin = getPlugin(id) as any
      if (!plugin) continue

      try {
        // Search zones
        if (id === 'search-zones' && typeof plugin.getZones === 'function') {
          const zones = plugin.getZones()
          if (zones?.length > 0) {
            results['zones'] = { zones: zones.map((z: any) => ({
              lat: z.lat, lng: z.lng, radius: z.radiusKm ?? z.radius,
              probability: z.probability ?? 0,
              polygon: z.polygon ?? [{ lat: z.lat, lng: z.lng }],
            })) }
          }
        }

        // Rest points
        if (id === 'rest-points' && typeof plugin.getPoints === 'function') {
          const points = plugin.getPoints()
          if (points?.length > 0) results['restPoints'] = { points }
        }

        // Fall risk
        if (id === 'fall-risk' && typeof plugin.getZones === 'function') {
          const zones = plugin.getZones()
          if (zones?.length > 0) results['fallRisk'] = { zones }
        }

        // Remains corridor
        if (id === 'remains-corridor' && typeof plugin.getPaths === 'function') {
          const paths = plugin.getPaths()
          if (paths?.length > 0) results['corridor'] = { paths }
        }

        // Anomaly
        if (id === 'anomaly' && typeof plugin.getZones === 'function') {
          const zones = plugin.getZones()
          if (zones?.length > 0) results['anomaly'] = { zones }
        }

        // Roads
        if (id === 'roads' && typeof plugin.getSegments === 'function') {
          const segments = plugin.getSegments()
          if (segments?.length > 0) results['roads'] = { segments }
        }

        // Water
        if (id === 'water' && typeof plugin.getFeatures === 'function') {
          const features = plugin.getFeatures()
          if (features?.length > 0) results['water'] = { features }
        }

        // Infrastructure
        if (id === 'infrastructure' && typeof plugin.getFeatures === 'function') {
          const features = plugin.getFeatures()
          if (features?.length > 0) results['infrastructure'] = { features }
        }

        // CLIP results
        if (id === 'clip' && typeof plugin.getResults === 'function') {
          const clipResults = plugin.getResults()
          if (clipResults?.length > 0) results['clip'] = { results: clipResults }
        }

        // Web search results
        if (id === 'web-search' && typeof plugin.getResults === 'function') {
          const searchResults = plugin.getResults()
          if (searchResults?.length > 0) results['webSearch'] = { results: searchResults }
        }
      } catch (err) {
        console.warn(`[export] failed to collect from plugin ${id}:`, err)
      }
    }

    console.log(`[export] collected results from ${Object.keys(results).length} sources:`, Object.keys(results).join(', '))
    return results
  }

  async exportGeoJSON(): Promise<string | null> {
    if (!this.ipc) return null
    this.status = { ...this.status, status: 'loading' }
    try {
      const data = this.collectResults()
      const result = await this.ipc.invoke('export:geojson', data) as { path: string } | null
      this.status = { count: 1, status: 'nominal' }
      return result?.path || null
    } catch (err) {
      this.status = { ...this.status, status: 'error', error: String(err) }
      return null
    }
  }

  async exportKML(): Promise<string | null> {
    if (!this.ipc) return null
    this.status = { ...this.status, status: 'loading' }
    try {
      const data = this.collectResults()
      const result = await this.ipc.invoke('export:kml', data) as { path: string } | null
      this.status = { count: 1, status: 'nominal' }
      return result?.path || null
    } catch (err) {
      this.status = { ...this.status, status: 'error', error: String(err) }
      return null
    }
  }

  async exportPNG(): Promise<string | null> {
    if (!this.ipc || !this.viewer) return null
    this.status = { ...this.status, status: 'loading' }
    try {
      // Force a render to ensure the canvas is up to date
      this.viewer.scene.requestRender()
      // Capture the canvas as a PNG data URL
      const canvas = this.viewer.canvas as HTMLCanvasElement
      const dataUrl = canvas.toDataURL('image/png')
      const result = await this.ipc.files.exportPNG(dataUrl) as string | null
      this.status = { count: 1, status: 'nominal' }
      return result
    } catch (err) {
      this.status = { ...this.status, status: 'error', error: String(err) }
      return null
    }
  }

  async importFile(): Promise<ImportResult | null> {
    if (!this.ipc || !this.dataSource) return null
    this.status = { ...this.status, status: 'loading' }
    try {
      const result = await this.ipc.invoke('import:kml', {}) as ImportResult | null
      if (!result?.features) {
        this.status = { count: 0, status: 'nominal' }
        return null
      }

      this.importedFeatures = result.features
      this.dataSource.entities.removeAll()

      for (const f of result.features) {
        this.addImportedEntity(f)
      }

      // Fly to imported bounds
      if (this.viewer && result.bounds[0].lng !== 0) {
        const [sw, ne] = result.bounds
        this.viewer.camera.flyTo({
          destination: Cesium.Rectangle.fromDegrees(sw.lng, sw.lat, ne.lng, ne.lat),
          duration: 2,
        })
      }

      this.status = { count: result.features.length, status: 'nominal' }
      return result
    } catch (err) {
      this.status = { ...this.status, status: 'error', error: String(err) }
      return null
    }
  }

  private addImportedEntity(f: ImportedFeature): void {
    if (!this.dataSource || f.coords.length === 0) return
    const color = this.parseColor(f.styleColor) ?? Cesium.Color.fromBytes(74, 200, 255, 220)

    if (f.type === 'point') {
      const c = f.coords[0]
      this.dataSource.entities.add({
        id: `import:${f.id}`,
        position: Cesium.Cartesian3.fromDegrees(c.lng, c.lat),
        point: {
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          pixelSize: 10,
          color: new Cesium.ConstantProperty(color),
          outlineColor: new Cesium.ConstantProperty(Cesium.Color.WHITE),
          outlineWidth: new Cesium.ConstantProperty(2),
        },
        label: {
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          text: f.name,
          font: '11px sans-serif',
          fillColor: new Cesium.ConstantProperty(color),
          outlineColor: new Cesium.ConstantProperty(Cesium.Color.BLACK),
          outlineWidth: new Cesium.ConstantProperty(2),
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          pixelOffset: new Cesium.Cartesian2(0, -16),
        },
        properties: { description: f.description, folder: f.folder },
      } as any)
    } else if (f.type === 'line' && f.coords.length >= 2) {
      const positions = f.coords.map((c) => Cesium.Cartesian3.fromDegrees(c.lng, c.lat))
      this.dataSource.entities.add({
        id: `import:${f.id}`,
        polyline: {
          positions: new Cesium.ConstantProperty(positions),
          width: new Cesium.ConstantProperty(2.5),
          material: new Cesium.ColorMaterialProperty(color),
          clampToGround: true,
        },
        properties: { description: f.description, folder: f.folder },
      } as any)
    } else if (f.type === 'polygon' && f.coords.length >= 3) {
      const positions = f.coords.map((c) => Cesium.Cartesian3.fromDegrees(c.lng, c.lat))
      this.dataSource.entities.add({
        id: `import:${f.id}`,
        polygon: {
          hierarchy: new Cesium.PolygonHierarchy(positions),
          material: new Cesium.ColorMaterialProperty(color.withAlpha(0.4)),
        },
        properties: { description: f.description, folder: f.folder },
      } as any)
    }
  }

  private parseColor(hex?: string): Cesium.Color | null {
    if (!hex || !hex.startsWith('#')) return null
    const r = parseInt(hex.slice(1, 3), 16)
    const g = parseInt(hex.slice(3, 5), 16)
    const b = parseInt(hex.slice(5, 7), 16)
    if (isNaN(r) || isNaN(g) || isNaN(b)) return null
    return Cesium.Color.fromBytes(r, g, b, 220)
  }
}

export const exportImportPlugin = new ExportImportPlugin()
