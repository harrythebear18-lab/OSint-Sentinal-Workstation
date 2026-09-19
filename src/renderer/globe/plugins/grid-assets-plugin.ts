/**
 * Grid Assets Plugin — power plants, substations, data centers, AI centers, interconnects.
 * Ported from OGOS GlobalOverlays grid-assets + grid-interconnects layers.
 *
 * Subscribes to GRID_UPDATE IPC channel.
 * Renders assets as colored point entities + interconnects as polylines.
 */

import * as Cesium from 'cesium'
import type { EarthEnginePlugin, PluginContext, PluginStats, PluginControlSpec } from './plugin-manager'
import type { GridAsset, GridUpdate, GridInterconnect, GridAssetType } from '@shared/types'

const ASSET_COLORS: Record<GridAssetType, Cesium.Color> = {
  power_plant: Cesium.Color.fromBytes(245, 158, 11, 255),
  substation: Cesium.Color.fromBytes(0, 255, 204, 255),
  transformer: Cesium.Color.fromBytes(59, 130, 246, 255),
  transmission_line: Cesium.Color.fromBytes(100, 116, 139, 255),
  renewable_farm: Cesium.Color.fromBytes(16, 185, 129, 255),
  battery_storage: Cesium.Color.fromBytes(139, 92, 246, 255),
  data_center: Cesium.Color.fromBytes(236, 72, 153, 255),
  ai_center: Cesium.Color.fromBytes(239, 68, 68, 255),
  edge_node: Cesium.Color.fromBytes(132, 204, 22, 255),
}

function assetColor(type: GridAssetType): Cesium.Color {
  return ASSET_COLORS[type] ?? Cesium.Color.fromBytes(192, 200, 216, 255)
}

function assetPixelSize(type: GridAssetType): number {
  switch (type) {
    case 'power_plant': return 8
    case 'data_center': return 7
    case 'ai_center': return 7
    case 'substation': return 6
    case 'renewable_farm': return 6
    case 'battery_storage': return 5
    case 'transformer': return 4
    case 'edge_node': return 4
    default: return 5
  }
}

export class GridAssetsPlugin implements EarthEnginePlugin {
  id = 'grid-assets'
  name = 'Grid Assets'
  category = 'infrastructure' as const

  private viewer: Cesium.Viewer | null = null
  private dataSource: Cesium.CustomDataSource | null = null
  private status: PluginStats = { count: 0, status: 'disabled' }
  private show = true
  private unsubscribe: (() => void) | null = null
  private knownAssets = new Set<string>()
  private knownInterconnects = new Set<string>()
  private assetMap = new Map<string, GridAsset>()

  register(ctx: PluginContext): void {
    this.viewer = ctx.viewer
    this.dataSource = new Cesium.CustomDataSource('grid-assets')
    ctx.viewer.dataSources.add(this.dataSource)
    this.status = { count: 0, status: 'loading' }

    const handler = (update: GridUpdate) => {
      if (update?.assets) {
        this.handleUpdate(update.assets, update.interconnects || [])
      }
    }

    ctx.ipc.grid.onUpdate(handler)
    this.unsubscribe = () => ctx.ipc.off('grid:update')
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
    this.knownAssets.clear()
    this.knownInterconnects.clear()
    this.assetMap.clear()
    this.viewer = null
    this.status = { count: 0, status: 'disabled' }
  }

  update(_ctx: PluginContext): void {}

  getStats(): PluginStats {
    return this.status
  }

  getControls(): PluginControlSpec[] {
    return [
      { type: 'toggle', id: 'visible', label: 'Visible', value: this.show },
      { type: 'separator', id: 'sep1' },
      { type: 'display', id: 'count', label: 'Asset Count', value: String(this.status.count), color: this.status.count > 0 ? '#4aff8a' : '#6b7d92' },
    ]
  }

  onControl(id: string, value?: unknown): void {
    if (id === 'visible' && typeof value === 'boolean') {
      this.show = value
      if (this.dataSource) this.dataSource.show = value
    }
  }

  private handleUpdate(assets: GridAsset[], interconnects: GridInterconnect[]): void {
    if (!this.dataSource) return

    // Update assets
    const newAssetIds = new Set(assets.map((a) => a.id))
    for (const id of this.knownAssets) {
      if (!newAssetIds.has(id)) {
        this.dataSource.entities.removeById(`grid-asset:${id}`)
        this.knownAssets.delete(id)
        this.assetMap.delete(id)
      }
    }

    for (const a of assets) {
      this.assetMap.set(a.id, a)
      this.updateAssetEntity(a)
      this.knownAssets.add(a.id)
    }

    // Update interconnects
    const newIcIds = new Set(interconnects.map((i) => i.id))
    for (const id of this.knownInterconnects) {
      if (!newIcIds.has(id)) {
        this.dataSource.entities.removeById(`grid-ic:${id}`)
        this.knownInterconnects.delete(id)
      }
    }

    for (const ic of interconnects) {
      this.updateInterconnectEntity(ic)
      this.knownInterconnects.add(ic.id)
    }

    this.status = { count: assets.length, status: 'nominal' }
  }

  private updateAssetEntity(a: GridAsset): void {
    if (!this.dataSource) return
    const id = `grid-asset:${a.id}`
    const position = Cesium.Cartesian3.fromDegrees(a.lon, a.lat, 0)
    const color = assetColor(a.type)
    const size = assetPixelSize(a.type)

    const existing = this.dataSource.entities.getById(id)
    const label = a.name ? a.name.substring(0, 20) : ''

    if (!existing) {
      this.dataSource.entities.add({
        id,
        position: new Cesium.ConstantPositionProperty(position),
        point: {
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          pixelSize: size,
          color,
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 1,
          // 10,000 km — disables terrain occlusion for near-side entities
          // but the globe still occludes far-side entities (Earth diameter ~12,742 km)
        },
        label: label
          ? {
              text: label,
              font: '8px monospace',
              fillColor: Cesium.Color.WHITE.withAlpha(0.7),
              outlineColor: Cesium.Color.BLACK,
              outlineWidth: 2,
              style: Cesium.LabelStyle.FILL_AND_OUTLINE,
              pixelOffset: new Cesium.Cartesian2(0, -10),
            }
          : undefined,
        properties: {
          type: a.type,
          capacityMw: a.capacityMw,
          energyType: a.energyType,
          owner: a.owner,
          active: a.active,
        },
      } as any)
    } else {
      ;(existing.position as Cesium.ConstantPositionProperty).setValue(position)
    }
  }

  private updateInterconnectEntity(ic: GridInterconnect): void {
    if (!this.dataSource) return
    const id = `grid-ic:${ic.id}`
    const src = this.assetMap.get(ic.sourceAssetId)
    const tgt = this.assetMap.get(ic.targetAssetId)
    if (!src || !tgt) {
      this.dataSource.entities.removeById(id)
      return
    }

    const positions = [
      Cesium.Cartesian3.fromDegrees(src.lon, src.lat, 0),
      Cesium.Cartesian3.fromDegrees(tgt.lon, tgt.lat, 0),
    ]

    const color = ic.type === 'fiber' || ic.type === 'waveguide'
      ? Cesium.Color.fromBytes(0, 255, 204, 120)
      : Cesium.Color.fromBytes(245, 158, 11, 120)

    const existing = this.dataSource.entities.getById(id)
    if (!existing) {
      this.dataSource.entities.add({
        id,
        polyline: {
          positions: new Cesium.ConstantProperty(positions),
          material: new Cesium.ColorMaterialProperty(color),
          width: new Cesium.ConstantProperty(1.5),
          arcType: Cesium.ArcType.GEODESIC,
          clampToGround: true,
        },
      } as any)
    } else {
      ;(existing.polyline!.positions as Cesium.ConstantProperty).setValue(positions)
    }
  }
}

export const gridAssetsPlugin = new GridAssetsPlugin()
