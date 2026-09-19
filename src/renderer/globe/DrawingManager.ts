/**
 * DrawingManager — Cesium globe drawing handler.
 *
 * Manages mouse interactions for drawing:
 *   - bbox:    Click-drag to draw a bounding box rectangle
 *   - polygon: Click to add vertices, double-click to close
 *   - line:    Click to add vertices, double-click to finish
 *   - point:   Click to place a pin (LKP)
 *
 * Renders the in-progress and completed shapes as Cesium entities.
 * Calls onSelectionChange when a shape is completed.
 */

import * as Cesium from 'cesium'
import type { DrawMode, Selection, LngLat } from '@shared/types'

/** Information about a picked Cesium entity, for the info box. */
export interface PickedEntity {
  id: string
  name: string
  type: string
  lng: number
  lat: number
  height: number
  properties: Record<string, unknown>
}

export class DrawingManager {
  private viewer: Cesium.Viewer
  private handler: Cesium.ScreenSpaceEventHandler | null = null
  private mode: DrawMode = 'none'
  private onSelectionChange: (sel: Selection | null) => void
  private onPinPlace: (point: LngLat) => void
  private onEntityPick: (entity: PickedEntity | null) => void

  // Drawing state
  private isDragging = false
  private dragStart: Cesium.Cartesian3 | null = null
  private dragEnd: Cesium.Cartesian3 | null = null
  private polygonPoints: LngLat[] = []
  private linePoints: LngLat[] = []

  // Entities
  private drawDataSource: Cesium.CustomDataSource
  private bboxEntity: Cesium.Entity | null = null
  private polygonEntity: Cesium.Entity | null = null
  private lineEntity: Cesium.Entity | null = null
  private pinEntity: Cesium.Entity | null = null
  private previewPoints: Cesium.Entity[] = []

  constructor(
    viewer: Cesium.Viewer,
    onSelectionChange: (sel: Selection | null) => void,
    onPinPlace: (point: LngLat) => void,
    onEntityPick: (entity: PickedEntity | null) => void,
  ) {
    this.viewer = viewer
    this.onSelectionChange = onSelectionChange
    this.onPinPlace = onPinPlace
    this.onEntityPick = onEntityPick
    this.drawDataSource = new Cesium.CustomDataSource('drawing')
    viewer.dataSources.add(this.drawDataSource)
    this.setupHandler()
  }

  private setupHandler(): void {
    this.handler = new Cesium.ScreenSpaceEventHandler(this.viewer.scene.canvas)

    // LEFT DOWN — start drag (bbox) or add vertex (polygon/line) or place pin
    // When mode is 'none', pick entities for the info box
    this.handler.setInputAction(
      (event: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
        if (this.mode === 'none') {
          this.pickEntity(event.position)
          return
        }
        const cartesian = this.pickPosition(event.position)
        if (!cartesian) return

        if (this.mode === 'bbox') {
          this.isDragging = true
          this.dragStart = cartesian
          this.dragEnd = cartesian
          this.updateBboxPreview()
        } else if (this.mode === 'polygon') {
          const ll = this.toLngLat(cartesian)
          if (ll) {
            this.polygonPoints.push(ll)
            this.updatePolygonPreview()
          }
        } else if (this.mode === 'line') {
          const ll = this.toLngLat(cartesian)
          if (ll) {
            this.linePoints.push(ll)
            this.updateLinePreview()
          }
        } else if (this.mode === 'point') {
          const ll = this.toLngLat(cartesian)
          if (ll) {
            this.placePin(ll)
            this.onPinPlace(ll)
          }
        }
      },
      Cesium.ScreenSpaceEventType.LEFT_DOWN,
    )

    // MOUSE_MOVE — update drag preview (bbox)
    this.handler.setInputAction(
      (event: Cesium.ScreenSpaceEventHandler.MotionEvent) => {
        if (!this.isDragging || this.mode !== 'bbox') return
        const cartesian = this.pickPosition(event.endPosition)
        if (!cartesian) return
        this.dragEnd = cartesian
        this.updateBboxPreview()
      },
      Cesium.ScreenSpaceEventType.MOUSE_MOVE,
    )

    // LEFT_UP — finish drag (bbox)
    this.handler.setInputAction(
      () => {
        if (!this.isDragging || this.mode !== 'bbox') return
        this.isDragging = false
        if (this.dragStart && this.dragEnd) {
          const start = this.toLngLat(this.dragStart)
          const end = this.toLngLat(this.dragEnd)
          if (start && end) {
            const coords: LngLat[] = [
              { lng: Math.min(start.lng, end.lng), lat: Math.min(start.lat, end.lat) },
              { lng: Math.max(start.lng, end.lng), lat: Math.min(start.lat, end.lat) },
              { lng: Math.max(start.lng, end.lng), lat: Math.max(start.lat, end.lat) },
              { lng: Math.min(start.lng, end.lng), lat: Math.max(start.lat, end.lat) },
            ]
            this.onSelectionChange({ type: 'bbox', coords })
          }
        }
        this.dragStart = null
        this.dragEnd = null
      },
      Cesium.ScreenSpaceEventType.LEFT_UP,
    )

    // LEFT_DOUBLE_CLICK — close polygon/line
    this.handler.setInputAction(
      () => {
        if (this.mode === 'polygon' && this.polygonPoints.length >= 3) {
          this.onSelectionChange({ type: 'polygon', coords: [...this.polygonPoints] })
        } else if (this.mode === 'line' && this.linePoints.length >= 2) {
          this.onSelectionChange({ type: 'line', coords: [...this.linePoints] })
        }
      },
      Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK,
    )

    // RIGHT_CLICK — cancel current drawing or clear last vertex
    this.handler.setInputAction(
      () => {
        if (this.mode === 'polygon' && this.polygonPoints.length > 0) {
          this.polygonPoints.pop()
          this.updatePolygonPreview()
        } else if (this.mode === 'line' && this.linePoints.length > 0) {
          this.linePoints.pop()
          this.updateLinePreview()
        }
      },
      Cesium.ScreenSpaceEventType.RIGHT_CLICK,
    )
  }

  setMode(mode: DrawMode): void {
    this.mode = mode
    // Reset in-progress drawing state
    this.isDragging = false
    this.dragStart = null
    this.dragEnd = null
    this.polygonPoints = []
    this.linePoints = []

    // Disable camera translate (LEFT_DRAG) when drawing to avoid conflict
    const controller = this.viewer.scene.screenSpaceCameraController
    if (mode === 'bbox' || mode === 'polygon' || mode === 'line') {
      controller.translateEventTypes = []
      controller.enableTranslate = false
    } else {
      controller.translateEventTypes = [
        Cesium.CameraEventType.LEFT_DRAG,
        Cesium.CameraEventType.PINCH,
      ]
      controller.enableTranslate = true
    }

    // Change cursor
    const canvas = this.viewer.scene.canvas as HTMLCanvasElement
    if (mode === 'none') {
      canvas.style.cursor = 'default'
    } else if (mode === 'bbox') {
      canvas.style.cursor = 'crosshair'
    } else if (mode === 'polygon' || mode === 'line') {
      canvas.style.cursor = 'crosshair'
    } else if (mode === 'point') {
      canvas.style.cursor = 'pointer'
    }
  }

  getMode(): DrawMode {
    return this.mode
  }

  /** Render a completed selection on the globe. */
  renderSelection(sel: Selection | null): void {
    this.clearSelectionEntities()
    if (!sel) {
      this.requestRender()
      return
    }

    if (sel.type === 'bbox' && sel.coords.length >= 2) {
      // Bounds over all coords — safe for 2-corner API selections as well
      // as the 4-corner rings produced by dragging.
      let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity
      for (const c of sel.coords) {
        if (c.lng < west) west = c.lng
        if (c.lng > east) east = c.lng
        if (c.lat < south) south = c.lat
        if (c.lat > north) north = c.lat
      }

      // Use polygon with classificationType to clamp to terrain
      this.bboxEntity = this.drawDataSource.entities.add({
        name: 'Selection BBox',
        polygon: {
          hierarchy: Cesium.Cartesian3.fromDegreesArray([
            west, south,
            east, south,
            east, north,
            west, north,
          ]),
          material: Cesium.Color.fromBytes(74, 158, 255, 50),
          outline: true,
          outlineColor: Cesium.Color.fromBytes(74, 158, 255, 255),
          outlineWidth: 2,
          classificationType: Cesium.ClassificationType.BOTH,
        },
      })
    } else if (sel.type === 'polygon' && sel.coords.length >= 3) {
      const hierarchy = new Cesium.PolygonHierarchy(
        sel.coords.map((c) => Cesium.Cartesian3.fromDegrees(c.lng, c.lat)),
      )
      this.polygonEntity = this.drawDataSource.entities.add({
        name: 'Selection Polygon',
        polygon: {
          hierarchy,
          material: Cesium.Color.fromBytes(74, 158, 255, 50),
          outline: true,
          outlineColor: Cesium.Color.fromBytes(74, 158, 255, 255),
          outlineWidth: 2,
          classificationType: Cesium.ClassificationType.BOTH,
        },
      })
    } else if (sel.type === 'line' && sel.coords.length >= 2) {
      this.lineEntity = this.drawDataSource.entities.add({
        name: 'Selection Line',
        polyline: {
          positions: sel.coords.map((c) => Cesium.Cartesian3.fromDegrees(c.lng, c.lat)),
          width: 4,
          material: new Cesium.PolylineGlowMaterialProperty({
            glowPower: 0.2,
            color: Cesium.Color.fromBytes(74, 158, 255, 255),
          }),
          clampToGround: true,
        },
      })
    }
    this.requestRender()
  }

  /** Render an LKP pin. Uses a point + label entity with disableDepthTestDistance
   *  so the pin is always visible above terrain, even when zoomed/tilted. */
  renderPin(point: LngLat | null): void {
    if (this.pinEntity) {
      this.drawDataSource.entities.remove(this.pinEntity)
      this.pinEntity = null
    }
    if (!point) {
      this.requestRender()
      return
    }
    this.pinEntity = this.drawDataSource.entities.add({
      name: 'LKP Pin',
      id: 'lkp-pin',
      position: Cesium.Cartesian3.fromDegrees(point.lng, point.lat),
      point: {
        pixelSize: 16,
        color: Cesium.Color.fromBytes(255, 74, 74, 255),
        outlineColor: Cesium.Color.WHITE,
        outlineWidth: 3,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      label: {
        text: 'LKP',
        font: 'bold 13px sans-serif',
        fillColor: Cesium.Color.WHITE,
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 3,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        pixelOffset: new Cesium.Cartesian2(0, -22),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        showBackground: true,
        backgroundColor: Cesium.Color.fromBytes(0, 0, 0, 180),
        backgroundPadding: new Cesium.Cartesian2(8, 5),
      },
    })
    this.requestRender()
  }

  clear(): void {
    this.clearSelectionEntities()
    this.polygonPoints = []
    this.linePoints = []
    this.isDragging = false
    this.dragStart = null
    this.dragEnd = null
    this.requestRender()
  }

  destroy(): void {
    if (this.handler) {
      this.handler.destroy()
      this.handler = null
    }
    this.viewer.dataSources.remove(this.drawDataSource)
  }

  // ── Private helpers ──

  private requestRender(): void {
    // requestRenderMode = true means Cesium only renders on demand.
    // We must explicitly request a render when entities change.
    try {
      this.viewer.scene.requestRender()
    } catch {
      // viewer may be destroyed
    }
  }

  private pickPosition(screenPos: Cesium.Cartesian2): Cesium.Cartesian3 | null {
    const ray = this.viewer.camera.getPickRay(screenPos)
    if (!ray) return null
    const cartesian = this.viewer.scene.globe.pick(ray, this.viewer.scene)
    return cartesian ?? null
  }

  /** Pick a Cesium entity at screen position for the info box. */
  private pickEntity(screenPos: Cesium.Cartesian2): void {
    try {
      const picked = this.viewer.scene.pick(screenPos)
      if (!picked || !picked.id) {
        this.onEntityPick(null)
        return
      }

      const entity = picked.id as Cesium.Entity
      if (!(entity instanceof Cesium.Entity)) {
        this.onEntityPick(null)
        return
      }

      const id = entity.id ?? ''
      const name = entity.name ?? ''
      const type = id.includes(':') ? id.split(':')[0] : 'entity'

      // Extract position
      let lng = 0, lat = 0, height = 0
      if (entity.position) {
        const pos = entity.position.getValue(this.viewer.clock.currentTime)
        if (pos) {
          const carto = Cesium.Cartographic.fromCartesian(pos)
          lng = Cesium.Math.toDegrees(carto.longitude)
          lat = Cesium.Math.toDegrees(carto.latitude)
          height = carto.height
        }
      }

      // Extract properties
      const props: Record<string, unknown> = {}
      if (entity.properties) {
        const propertyNames = entity.properties.propertyNames
        if (propertyNames) {
          for (let i = 0; i < propertyNames.length; i++) {
            const key = propertyNames[i]
            const val = entity.properties[key]
            props[key] = val?.getValue?.(this.viewer.clock.currentTime) ?? val
          }
        }
      }

      this.onEntityPick({ id, name, type, lng, lat, height, properties: props })
    } catch {
      this.onEntityPick(null)
    }
    this.requestRender()
  }

  private toLngLat(cartesian: Cesium.Cartesian3): LngLat | null {
    const carto = Cesium.Cartographic.fromCartesian(cartesian)
    if (!carto) return null
    return {
      lng: Cesium.Math.toDegrees(carto.longitude),
      lat: Cesium.Math.toDegrees(carto.latitude),
    }
  }

  private updateBboxPreview(): void {
    if (this.bboxEntity) {
      this.drawDataSource.entities.remove(this.bboxEntity)
      this.bboxEntity = null
    }
    if (!this.dragStart || !this.dragEnd) return
    const start = this.toLngLat(this.dragStart)
    const end = this.toLngLat(this.dragEnd)
    if (!start || !end) return

    const west = Math.min(start.lng, end.lng)
    const south = Math.min(start.lat, end.lat)
    const east = Math.max(start.lng, end.lng)
    const north = Math.max(start.lat, end.lat)

    this.bboxEntity = this.drawDataSource.entities.add({
      name: 'BBox Preview',
      polygon: {
        hierarchy: Cesium.Cartesian3.fromDegreesArray([
          west, south,
          east, south,
          east, north,
          west, north,
        ]),
        material: Cesium.Color.fromBytes(74, 158, 255, 70),
        outline: true,
        outlineColor: Cesium.Color.fromBytes(74, 158, 255, 255),
        outlineWidth: 2,
        classificationType: Cesium.ClassificationType.BOTH,
      },
    })
    this.requestRender()
  }

  private updatePolygonPreview(): void {
    // Clear old preview
    for (const e of this.previewPoints) this.drawDataSource.entities.remove(e)
    this.previewPoints = []
    if (this.polygonEntity) {
      this.drawDataSource.entities.remove(this.polygonEntity)
      this.polygonEntity = null
    }

    // Draw vertex markers
    for (const p of this.polygonPoints) {
      const e = this.drawDataSource.entities.add({
        position: Cesium.Cartesian3.fromDegrees(p.lng, p.lat),
        point: {
          pixelSize: 10,
          color: Cesium.Color.fromBytes(74, 158, 255, 255),
          outlineColor: Cesium.Color.WHITE,
          outlineWidth: 2,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        },
      })
      this.previewPoints.push(e)
    }

    // Draw connecting lines if 2+ points
    if (this.polygonPoints.length >= 2) {
      this.polygonEntity = this.drawDataSource.entities.add({
        name: 'Polygon Preview',
        polyline: {
          positions: this.polygonPoints.map((p) => Cesium.Cartesian3.fromDegrees(p.lng, p.lat)),
          width: 3,
          material: new Cesium.PolylineGlowMaterialProperty({
            glowPower: 0.2,
            color: Cesium.Color.fromBytes(74, 158, 255, 200),
          }),
          clampToGround: true,
        },
      })
    }
    this.requestRender()
  }

  private updateLinePreview(): void {
    for (const e of this.previewPoints) this.drawDataSource.entities.remove(e)
    this.previewPoints = []
    if (this.lineEntity) {
      this.drawDataSource.entities.remove(this.lineEntity)
      this.lineEntity = null
    }

    for (const p of this.linePoints) {
      const e = this.drawDataSource.entities.add({
        position: Cesium.Cartesian3.fromDegrees(p.lng, p.lat),
        point: {
          pixelSize: 10,
          color: Cesium.Color.fromBytes(74, 158, 255, 255),
          outlineColor: Cesium.Color.WHITE,
          outlineWidth: 2,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        },
      })
      this.previewPoints.push(e)
    }

    if (this.linePoints.length >= 2) {
      this.lineEntity = this.drawDataSource.entities.add({
        name: 'Line Preview',
        polyline: {
          positions: this.linePoints.map((p) => Cesium.Cartesian3.fromDegrees(p.lng, p.lat)),
          width: 4,
          material: new Cesium.PolylineGlowMaterialProperty({
            glowPower: 0.2,
            color: Cesium.Color.fromBytes(74, 158, 255, 255),
          }),
          clampToGround: true,
        },
      })
    }
    this.requestRender()
  }

  private placePin(point: LngLat): void {
    this.renderPin(point)
  }

  private clearSelectionEntities(): void {
    if (this.bboxEntity) {
      this.drawDataSource.entities.remove(this.bboxEntity)
      this.bboxEntity = null
    }
    if (this.polygonEntity) {
      this.drawDataSource.entities.remove(this.polygonEntity)
      this.polygonEntity = null
    }
    if (this.lineEntity) {
      this.drawDataSource.entities.remove(this.lineEntity)
      this.lineEntity = null
    }
    for (const e of this.previewPoints) this.drawDataSource.entities.remove(e)
    this.previewPoints = []
  }
}
