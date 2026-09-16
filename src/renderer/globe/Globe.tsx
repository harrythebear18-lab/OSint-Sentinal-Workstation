import { useEffect, useRef, useState } from 'react'
import * as Cesium from 'cesium'
import { buildEsriProvider, buildNaturalEarthProvider, buildGibsProvider, buildFlatTerrain, buildEsriTransportationProvider, buildEsriReferenceProvider } from './imageryProviders'
import { DrawingManager } from './DrawingManager'
import type { PickedEntity } from './DrawingManager'
import { isDevRenderer } from './hal/is-prod'
import type { GIBSLayer, DrawMode, Selection, LngLat } from '@shared/types'

Cesium.Ion.defaultAccessToken = ''

/** Generate an opaque white PNG data URL to use as a bottomless pole cap fill. */
function getWhitePixelDataUrl(size: number = 256): string {
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    // 1x1 white PNG fallback
    return 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVQIW2P4DwABAQEAWI3nPAAAAABJRU5ErkJggg=='
  }
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, size, size)
  return canvas.toDataURL('image/png')
}

interface GlobeProps {
  imageryLayer: string | null
  gibsLayers: GIBSLayer[]
  imageryOpacity: number
  terrain3d: boolean
  hillshade: boolean
  terrainExaggeration: number
  roadsVisible: boolean
  labelsVisible: boolean
  onViewerReady: (viewer: Cesium.Viewer) => void
  onCameraMove: (viewport: unknown) => void
  drawMode: DrawMode
  onSelectionChange: (sel: Selection | null) => void
  onPinPlace: (point: LngLat) => void
  onEntityPick: (entity: PickedEntity | null) => void
  selection: Selection | null
  lkpPin: LngLat | null
}

export default function Globe({
  imageryLayer,
  gibsLayers,
  imageryOpacity,
  terrain3d,
  hillshade,
  terrainExaggeration,
  roadsVisible,
  labelsVisible,
  onViewerReady,
  onCameraMove,
  drawMode,
  onSelectionChange,
  onPinPlace,
  onEntityPick,
  selection,
  lkpPin,
}: GlobeProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const viewerRef = useRef<Cesium.Viewer | null>(null)
  const drawingRef = useRef<DrawingManager | null>(null)
  const roadsLayerRef = useRef<Cesium.ImageryLayer | null>(null)
  const labelsLayerRef = useRef<Cesium.ImageryLayer | null>(null)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState('starting')

  useEffect(() => {
    console.log('[Globe] useEffect mount — containerRef:', containerRef.current)
    if (!containerRef.current) {
      console.error('[Globe] containerRef is null — cannot create Viewer')
      return
    }

    // Guard against double-mount (React StrictMode or hot reload)
    if (viewerRef.current) {
      console.log('[Globe] viewer already exists — skipping creation')
      return
    }

    let v: Cesium.Viewer
    try {
      setStatus('checking CESIUM_BASE_URL')
      const baseUrl = (window as any).CESIUM_BASE_URL
      console.log('[Globe] CESIUM_BASE_URL:', baseUrl)
      console.log('[Globe] Cesium loaded')
      console.log('[Globe] container dimensions:', containerRef.current.clientWidth, 'x', containerRef.current.clientHeight)

      setStatus('building natural earth underlay')
      console.log('[Globe] building Natural Earth underlay...')
      const naturalEarthProvider = buildNaturalEarthProvider()
      console.log('[Globe] Natural Earth underlay built')

      setStatus('building pole cap fill')
      console.log('[Globe] building pole cap fill...')
      const poleFillerProvider = new Cesium.SingleTileImageryProvider({
        url: getWhitePixelDataUrl(),
        rectangle: Cesium.Rectangle.MAX_VALUE,
        tileWidth: 256,
        tileHeight: 256,
        credit: new Cesium.Credit('Pole cap fill'),
      })
      console.log('[Globe] pole cap fill built')

      setStatus('building Esri provider')
      console.log('[Globe] building Esri imagery provider...')
      const esriProvider = buildEsriProvider()
      console.log('[Globe] Esri provider built')

      setStatus('building flat terrain')
      console.log('[Globe] building flat terrain provider...')
      const flatTerrain = buildFlatTerrain()
      console.log('[Globe] flat terrain built')

      setStatus('creating Viewer')
      console.log('[Globe] creating Cesium.Viewer...')

      v = new Cesium.Viewer(containerRef.current, {
        baseLayerPicker: false,
        geocoder: false,
        homeButton: false,
        sceneModePicker: false,
        navigationHelpButton: false,
        animation: false,
        timeline: false,
        fullscreenButton: false,
        vrButton: false,
        selectionIndicator: false,
        infoBox: false,
        creditContainer: document.createElement('div'),
        shouldAnimate: true,
        baseLayer: new Cesium.ImageryLayer(poleFillerProvider as any),
        terrainProvider: flatTerrain,
        // ── PERFORMANCE TUNING FOR RTX 5060 ──
        // requestRenderMode saves GPU by only rendering on change.
        // But during camera interaction we need smooth frames.
        // maximumRenderTimeChange = Infinity means time ticks don't trigger renders
        // (good for static scenes, camera movement still triggers renders).
        requestRenderMode: true,
        maximumRenderTimeChange: Infinity,
        contextOptions: {
          requestWebgl1: false,
          antialias: false,                // MSAA off — use FXAA instead (cheaper)
          powerPreference: 'high-performance',
          failIfMajorPerformanceCaveat: false,
        } as any,
      })

      console.log('[Globe] Viewer created OK')

      // Natural Earth sits above the white pole-fill layer so polar tiles render as map
      v.imageryLayers.addImageryProvider(naturalEarthProvider as any, 1)

      // ── AGGRESSIVE PERFORMANCE TUNING ──
      const scene = v.scene
      const globe = scene.globe

      // Tile loading — higher = fewer tiles loaded = faster (default 2)
      globe.maximumScreenSpaceError = 4
      // Cache size — keep small to avoid V8 heap exhaustion at high zoom.
      // 100 tiles is enough for smooth panning; Cesium evicts LRU.
      globe.tileCacheSize = 100
      // Don't load terrain until needed
      // depthTestAgainstTerrain = true prevents seeing through hills/mountains
      // and helps the camera collision system work properly
      globe.depthTestAgainstTerrain = true
      // Fill the polar regions (above ~85° lat) where Web Mercator imagery has no tiles.
      // White matches the ice caps shown by the underlying pole-filler imagery layer.
      globe.baseColor = Cesium.Color.WHITE
      v.scene.backgroundColor = Cesium.Color.BLACK
      // Ground atmosphere + dynamic atmosphere lighting run a full-screen haze
      // pass and sun math every render — expensive and washes out imagery.
      // Fog stays on at half density for depth cueing (cheap per-pixel mix).
      globe.showGroundAtmosphere = false
      scene.fog.enabled = true
      scene.fog.density = 0.0001
      if (scene.skyAtmosphere) scene.skyAtmosphere.show = true
      // Sun lighting gated behind the hillshade toggle — per-tile lighting
      // costs GPU on every render, so it's off until explicitly enabled.
      scene.globe.enableLighting = false
      scene.globe.dynamicAtmosphereLighting = false
      // FXAA is cheaper than MSAA
      scene.postProcessStages.fxaa.enabled = true
      // Disable bloom (expensive)
      scene.postProcessStages.bloom.enabled = false
      // Disable ambient occlusion (very expensive)
      scene.postProcessStages.ambientOcclusion.enabled = false
      // Don't show shadows
      scene.shadowMap.enabled = false
      // Higher resolution scale = sharper but more GPU work — keep 1.0 for RTX 5060
      v.resolutionScale = 1.0
      // Use logarithmic depth buffer (helps with large altitude ranges)
      scene.logarithmicDepthBuffer = true

      console.log('[Globe] performance tuning applied')

      // ── INTUITIVE CAMERA CONTROLS ──
      // Goal: feels like Google Earth / Flight Sim — not floaty, not sticky
      // Camera stays ABOVE the earth, looks AT it, never goes through it
      const controller = scene.screenSpaceCameraController

      // Enable all controls
      controller.enableZoom = true
      controller.enableRotate = true
      controller.enableTranslate = true
      controller.enableTilt = true
      controller.enableLook = false

      // Zoom — wheel zooms toward cursor, not center of screen
      controller.zoomEventTypes = [
        Cesium.CameraEventType.WHEEL,
        Cesium.CameraEventType.PINCH,
      ]

      // Translate — LEFT drag to pan (intuitive, like Google Earth)
      controller.translateEventTypes = [
        Cesium.CameraEventType.LEFT_DRAG,
        Cesium.CameraEventType.PINCH,
      ]

      // Rotate — RIGHT drag to rotate the globe (Cesium default)
      controller.rotateEventTypes = [
        Cesium.CameraEventType.RIGHT_DRAG,
      ]
      controller.enableRotate = true

      // Tilt — disabled on middle (middle is now orbit)
      controller.tiltEventTypes = []

      // Look — disabled (conflicts with custom orbit)
      controller.lookEventTypes = []

      // ── Sensitivity ──
      // Zoom — moderate, controlled (default 5.0)
      controller.zoomFactor = 3.0

      // ── Collision: KEEP CAMERA ABOVE EARTH ──
      // This is the critical setting — prevents camera from going underground
      controller.enableCollisionDetection = true
      // Minimum height above terrain for collision detection (Cesium default 1500m)
      // Setting to 0 effectively disables it — must be a reasonable value
      controller.minimumCollisionTerrainHeight = 1500.0
      // Don't let camera go below this height above the ellipsoid
      controller.minimumZoomDistance = 100
      // Maximum zoom distance — can't zoom past 40,000km
      controller.maximumZoomDistance = 40_000_000

      // ── Inertia — consistent across all controls ──
      // 0 = instant stop, 1 = infinite drift
      // Low values = precise control. Keep all three consistent.
      controller.inertiaZoom = 0.1
      controller.inertiaTranslate = 0.1
      controller.inertiaSpin = 0.1  // rotation/orbit inertia — was defaulting to 0.9 (floaty)

      console.log('[Globe] camera controls tuned — collision + consistent inertia')

      // ── CURSOR-CENTERED ORBIT (right-drag) ──
      // Picks the terrain point under the cursor on right-down, then
      // orbits the camera around that point using direct vector math.
      // No lookAt/lookAtTransform — just sets position/direction/up/right directly.
      const orbitState = {
        target: null as Cesium.Cartesian3 | null,
        offset: null as Cesium.Cartesian3 | null,
        lastX: 0,
        lastY: 0,
      }
      const orbitHandler = new Cesium.ScreenSpaceEventHandler(scene.canvas)

      orbitHandler.setInputAction((event: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
        // Fully disable default controller during orbit
        controller.enableTranslate = false
        controller.enableZoom = false
        controller.enableRotate = false
        controller.enableTilt = false
        controller.enableLook = false

        const ray = v.camera.getPickRay(event.position)
        if (!ray) { console.log('[Globe] orbit — no ray'); return }
        let picked = v.scene.globe.pick(ray, v.scene)
        if (!picked) {
          const ellipsoid = v.scene.globe.ellipsoid
          const isect = Cesium.IntersectionTests.rayEllipsoid(ray, ellipsoid)
          if (isect) picked = Cesium.Ray.getPoint(ray, isect.start)
        }
        if (!picked) { return }

        orbitState.target = picked
        // Store initial offset vector from target to camera
        orbitState.offset = Cesium.Cartesian3.subtract(v.camera.position, picked, new Cesium.Cartesian3())
        orbitState.lastX = event.position.x
        orbitState.lastY = event.position.y
      }, Cesium.ScreenSpaceEventType.MIDDLE_DOWN)

      orbitHandler.setInputAction((event: Cesium.ScreenSpaceEventHandler.MotionEvent) => {
        if (!orbitState.target || !orbitState.offset) return

        const dx = event.endPosition.x - orbitState.lastX
        const dy = event.endPosition.y - orbitState.lastY
        orbitState.lastX = event.endPosition.x
        orbitState.lastY = event.endPosition.y

        const sens = 0.01
        const target = orbitState.target
        // Rotate the CURRENT offset (not a clone of the original) — accumulate rotation
        let offset = orbitState.offset

        // Up axis at target (normal to ellipsoid)
        const up = Cesium.Cartesian3.normalize(target, new Cesium.Cartesian3())

        // Horizontal drag → rotate offset around up axis
        if (Math.abs(dx) > 0.01) {
          const hAngle = -dx * sens
          const hQuat = Cesium.Quaternion.fromAxisAngle(up, hAngle, new Cesium.Quaternion())
          const hMat = Cesium.Matrix3.fromQuaternion(hQuat, new Cesium.Matrix3())
          offset = Cesium.Matrix3.multiplyByVector(hMat, offset, new Cesium.Cartesian3())
        }

        // Vertical drag → rotate offset around right axis
        if (Math.abs(dy) > 0.01) {
          // Right = cross(up, offset) normalized
          const right = Cesium.Cartesian3.cross(up, offset, new Cesium.Cartesian3())
          const rightLen = Cesium.Cartesian3.magnitude(right)
          if (rightLen > 1e-10) {
            Cesium.Cartesian3.normalize(right, right)

            // Clamp pitch so camera doesn't flip over the pole
            const currentAngle = Cesium.Cartesian3.angleBetween(offset, up)
            const vAngle = -dy * sens
            const newAngle = Cesium.Math.clamp(currentAngle + vAngle, 0.05, Math.PI - 0.05)
            const actualV = newAngle - currentAngle
            if (Math.abs(actualV) > 1e-6) {
              const vQuat = Cesium.Quaternion.fromAxisAngle(right, actualV, new Cesium.Quaternion())
              const vMat = Cesium.Matrix3.fromQuaternion(vQuat, new Cesium.Matrix3())
              offset = Cesium.Matrix3.multiplyByVector(vMat, offset, new Cesium.Cartesian3())
            }
          }
        }

        // Store the new offset for next frame (accumulate)
        orbitState.offset = offset

        // New camera position = target + rotated offset
        const newPos = Cesium.Cartesian3.add(target, offset, new Cesium.Cartesian3())

        // Direction = look at target
        const newDir = Cesium.Cartesian3.subtract(target, newPos, new Cesium.Cartesian3())
        Cesium.Cartesian3.normalize(newDir, newDir)

        // Up = cross(right, direction) — use ellipsoid up for stable orientation
        const newRight = Cesium.Cartesian3.cross(newDir, up, new Cesium.Cartesian3())
        Cesium.Cartesian3.normalize(newRight, newRight)
        const newUp = Cesium.Cartesian3.cross(newRight, newDir, new Cesium.Cartesian3())
        Cesium.Cartesian3.normalize(newUp, newUp)

        // Use setView for a clean camera state update
        v.camera.setView({
          destination: newPos,
          orientation: {
            direction: newDir,
            up: newUp,
          },
        })
      }, Cesium.ScreenSpaceEventType.MOUSE_MOVE)

      orbitHandler.setInputAction(() => {
        orbitState.target = null
        orbitState.offset = null
        // Re-enable default controller
        controller.enableTranslate = true
        controller.enableZoom = true
        controller.enableRotate = true
        controller.enableTilt = true
        controller.enableLook = false  // keep look disabled
      }, Cesium.ScreenSpaceEventType.MIDDLE_UP)

      // Store for cleanup
      ;(v as any)._orbitHandler = orbitHandler

      // Hide credit display
      try { (v as any).creditDisplay.container.style.display = 'none' } catch (e) {
        console.warn('[Globe] could not hide credit display:', e)
      }

      setStatus('attaching error handlers')
      console.log('[Globe] attaching render error handler...')

      v.scene.renderError.addEventListener((_scene, err) => {
        // Log only — do NOT setError during panning (tile 404s are normal)
        const errStr = err instanceof Error ? err.message : String(err)
        if (!errStr.includes('404') && !errStr.includes('texture')) {
          console.error('[Globe] RENDER ERROR:', errStr)
        }
      })

      setStatus('setting camera view')
      console.log('[Globe] setting initial camera view...')
      v.camera.setView({
        destination: Cesium.Cartesian3.fromDegrees(-45.7213, 22.5845, 21_750_200),
        orientation: {
          heading: Cesium.Math.toRadians(360),
          pitch: Cesium.Math.toRadians(-90),
          roll: 0,
        },
      })
      console.log('[Globe] camera view set')

      const now = new Date()
      v.clock.currentTime = Cesium.JulianDate.fromDate(now)
      v.clock.stopTime = Cesium.JulianDate.fromDate(new Date(now.getTime() + 90 * 60 * 1000))
      v.clock.clockRange = Cesium.ClockRange.UNBOUNDED
      v.clock.multiplier = 1.0  // real-time — 60x caused visual jank

      const sendViewport = () => {
        try {
          const cart = v.camera.positionCartographic
          const rec = v.camera.computeViewRectangle()
          onCameraMove({
            center: {
              lng: Cesium.Math.toDegrees(cart.longitude),
              lat: Cesium.Math.toDegrees(cart.latitude),
            },
            height: cart.height,
            heading: Cesium.Math.toDegrees(v.camera.heading),
            pitch: Cesium.Math.toDegrees(v.camera.pitch),
            roll: Cesium.Math.toDegrees(v.camera.roll),
            bbox: rec
              ? {
                  west: Cesium.Math.toDegrees(rec.west),
                  south: Cesium.Math.toDegrees(rec.south),
                  east: Cesium.Math.toDegrees(rec.east),
                  north: Cesium.Math.toDegrees(rec.north),
                }
              : null,
          })
        } catch (e) {
          console.error('[Globe] sendViewport error:', e)
        }
      }

      // Throttle viewport updates to 500ms — don't re-render React on every frame
      let viewportTimer: ReturnType<typeof setTimeout> | null = null
      const throttledSendViewport = () => {
        if (viewportTimer) return
        viewportTimer = setTimeout(() => {
          viewportTimer = null
          sendViewport()
        }, 500)
      }

      v.camera.percentageChanged = 0.05
      v.camera.changed.addEventListener(throttledSendViewport)
      sendViewport()

      viewerRef.current = v
      setReady(true)
      setStatus('ready')
      onViewerReady(v)

      // FPS tracking for benchmark plugin (dev only)
      if (isDevRenderer) {
        let lastT = performance.now()
        let frames = 0
        v.scene.postRender.addEventListener(() => {
          const now = performance.now()
          frames++
          if (now - lastT >= 1000) {
            (window as any).__cesiumFps = Math.round((frames * 1000) / (now - lastT))
            frames = 0
            lastT = now
          }
        })
      }

      // Create drawing manager for bbox/polygon/line selection
      drawingRef.current = new DrawingManager(v, onSelectionChange, onPinPlace, onEntityPick)
      console.log('[Globe] DrawingManager created')

      console.log('[Globe] READY — viewer passed to parent')
    } catch (e) {
      console.error('[Globe] FATAL during init:', e)
      const errStr = e instanceof Error ? `${e.message}\n${e.stack}` : String(e)
      setError(errStr)
      setStatus('error')
    }

    return () => {
      console.log('[Globe] cleanup — destroying viewer')
      if (drawingRef.current) {
        drawingRef.current.destroy()
        drawingRef.current = null
      }
      if (viewerRef.current) {
        try {
          const ov = viewerRef.current as any
          if (ov._orbitHandler) { ov._orbitHandler.destroy(); ov._orbitHandler = null }
          viewerRef.current.destroy()
          console.log('[Globe] viewer destroyed')
        } catch (e) {
          console.error('[Globe] destroy error:', e)
        }
        viewerRef.current = null
      }
    }
  }, [])

  // Update imagery layer
  useEffect(() => {
    const v = viewerRef.current
    if (!v) return

    // Remove every layer except the white pole filler (index 0) and Natural Earth underlay (index 1)
    while (v.imageryLayers.length > 2) {
      const top = v.imageryLayers.get(v.imageryLayers.length - 1)
      if (top) v.imageryLayers.remove(top)
    }
    roadsLayerRef.current = null
    labelsLayerRef.current = null

    let base: Cesium.ImageryLayer | undefined
    if (!imageryLayer || imageryLayer === 'esri') {
      base = v.imageryLayers.addImageryProvider(buildEsriProvider(), 2)
    } else {
      const gibsLayer = gibsLayers.find((l) => l.id === imageryLayer)
      if (gibsLayer) {
        base = v.imageryLayers.addImageryProvider(buildGibsProvider(gibsLayer) as any, 2)
      } else {
        base = v.imageryLayers.addImageryProvider(buildEsriProvider(), 2)
      }
    }
    if (base) base.alpha = imageryOpacity

    // Re-add road/label overlays on top of the new base imagery
    if (roadsVisible) {
      const layer = v.imageryLayers.addImageryProvider(buildEsriTransportationProvider())
      layer.alpha = 0.9
      roadsLayerRef.current = layer
    }
    if (labelsVisible) {
      const layer = v.imageryLayers.addImageryProvider(buildEsriReferenceProvider())
      layer.alpha = 0.9
      labelsLayerRef.current = layer
    }
  }, [imageryLayer, gibsLayers, roadsVisible, labelsVisible])

  // Road network + place labels overlays (Esri Transportation + Reference)
  // are managed by the base imagery effect above — they're re-added on top
  // whenever the base imagery changes, and toggled via roadsVisible/labelsVisible.

  // Apply opacity
  useEffect(() => {
    const v = viewerRef.current
    if (!v) return
    const layer = v.imageryLayers.get(2)
    if (layer) layer.alpha = imageryOpacity
  }, [imageryOpacity])

  // Toggle 3D terrain
  useEffect(() => {
    const v = viewerRef.current
    if (!v) return
    let cancelled = false

    if (terrain3d) {
      Cesium.ArcGISTiledElevationTerrainProvider.fromUrl(
        'https://elevation3d.arcgis.com/arcgis/rest/services/WorldElevation3D/Terrain3D/ImageServer',
      ).then((provider) => {
        if (cancelled) return
        v.terrainProvider = provider
        v.scene.verticalExaggeration = terrainExaggeration
      }).catch((err) => {
        console.error('[Globe] terrain provider failed:', err)
      })
    } else {
      v.terrainProvider = buildFlatTerrain()
      v.scene.verticalExaggeration = 1.0
    }

    return () => { cancelled = true }
  }, [terrain3d, terrainExaggeration])

  // Toggle hillshade — with natural TOD orbit (full day cycle in 30 minutes)
  useEffect(() => {
    const v = viewerRef.current
    if (!v) return

    let rafId = 0

    const timeout = setTimeout(() => {
      requestAnimationFrame(() => {
        if (hillshade) {
          // Start at noon for a balanced starting light
          const now = new Date()
          now.setHours(12, 0, 0, 0)
          v.clock.currentTime = Cesium.JulianDate.fromDate(now)
          // 12x speed: 24h compressed into 2 hours — fast enough to see day/night,
          // but satellites still move at a believable pace rather than 48x blur.
          v.clock.multiplier = 12.0
          v.clock.shouldAnimate = true
          v.scene.globe.enableLighting = true
          // Keep maximumRenderTimeChange at Infinity — we manually request renders
          // via a RAF loop for smooth 60fps sun movement
          v.scene.maximumRenderTimeChange = Infinity

          // Continuous render loop while hillshade is active
          const renderLoop = () => {
            v.scene.requestRender()
            rafId = requestAnimationFrame(renderLoop)
          }
          rafId = requestAnimationFrame(renderLoop)
        } else {
          v.scene.globe.enableLighting = false
          v.clock.shouldAnimate = true
          v.clock.multiplier = 1.0
          v.scene.maximumRenderTimeChange = Infinity
        }
        v.scene.requestRender()
      })
    }, 100)

    return () => {
      clearTimeout(timeout)
      if (rafId) cancelAnimationFrame(rafId)
    }
  }, [hillshade])

  // Sync draw mode to DrawingManager
  useEffect(() => {
    if (drawingRef.current) {
      drawingRef.current.setMode(drawMode)
    }
  }, [drawMode])

  // Sync selection rendering to DrawingManager
  useEffect(() => {
    if (drawingRef.current) {
      drawingRef.current.renderSelection(selection)
    }
  }, [selection])

  // Sync LKP pin rendering to DrawingManager
  useEffect(() => {
    if (drawingRef.current) {
      drawingRef.current.renderPin(lkpPin)
    }
  }, [lkpPin])

  return (
    <div ref={containerRef} style={{ width: '100%', height: '100%', position: 'absolute', inset: 0 }}>
      {error && (
        <div style={{ position: 'absolute', top: 50, left: 10, right: 10, padding: 12, background: '#1a0a0a', color: '#ff4a4a', fontFamily: 'monospace', fontSize: 12, border: '1px solid #ff4a4a', zIndex: 100, whiteSpace: 'pre-wrap' }}>
          <b>Cesium render error:</b>{'\n'}{error}
        </div>
      )}
      {!ready && !error && (
        <div style={{ position: 'absolute', top: 50, left: 10, color: '#8b9dad', fontFamily: 'monospace', fontSize: 12, zIndex: 100 }}>
          Cesium: {status}...
        </div>
      )}
    </div>
  )
}
