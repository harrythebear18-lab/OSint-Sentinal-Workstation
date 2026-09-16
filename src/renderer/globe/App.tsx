import { useState, useEffect, useCallback, useRef, memo } from 'react'
import * as Cesium from 'cesium'
import Globe from './Globe'
import SatellitesOverlay from './SatellitesOverlay'
import LayerPanel from './LayerPanel'
import Hud from './Hud'
import CockpitShell from './CockpitShell'
import DrawTools from './DrawTools'
import PluginPanel from './plugins/PluginPanel'
import InspectorPanel from './InspectorPanel'
import StatusBar from './StatusBar'
import EntityInfoBox from './EntityInfoBox'
import ElevationProfile from './ElevationProfile'
import ClimateIntegrityPanel from './ClimateIntegrityPanel'
import WeatherOverlay from './WeatherOverlay'
import PredictionPanel from './PredictionPanel'
import IncidentPanel from './IncidentPanel'
import NetworkGridPanel from './NetworkGridPanel'
import SystemVerifierPanel from './SystemVerifierPanel'
import PrivacyPolicyPanel from './PrivacyPolicyPanel'
import PrivacyToggle, { type SecurityLevel, networkVisible as networkVisibleFor } from './PrivacyToggle'
import ExplainabilityOverlay, { type Hypothesis } from './ExplainabilityOverlay'
import AiPanel from './AiPanel'
import { WorldOverlay } from './WorldOverlay'
import WorldOverlayLayer from './WorldOverlayLayer'
import { pluginManager } from './plugins'
import { networkPlugin } from './plugins/network-plugin'
import { initHalRenderer } from './hal'
import type { PluginContext } from './plugins'
import type { GIBSLayer, DrawMode, Selection, LngLat } from '@shared/types'
import { selectionToBBox } from '@shared/types'
import type { PickedEntity } from './DrawingManager'

// ── Earth Engine v0.3 — cockpit windowing + plugin architecture ──

const MemoGlobe = memo(Globe)
const MemoLayerPanel = memo(LayerPanel)
const MemoHud = memo(Hud)
const MemoPluginPanel = memo(PluginPanel)
const MemoInspectorPanel = memo(InspectorPanel)
const MemoStatusBar = memo(StatusBar)

export default function App() {
  // ── Globe Renderer state ──
  const [viewer, setViewer] = useState<Cesium.Viewer | null>(null)
  const [worldOverlay, setWorldOverlay] = useState<WorldOverlay | null>(null)
  const [gibsLayers, setGibsLayers] = useState<GIBSLayer[]>([])
  const [imageryLayer, setImageryLayer] = useState<string>('esri')
  const [imageryOpacity, setImageryOpacity] = useState<number>(1.0)
  const [terrain3d, setTerrain3d] = useState<boolean>(true)
  const [hillshade, setHillshade] = useState<boolean>(false)
  const [terrainExaggeration, setTerrainExaggeration] = useState<number>(1.4)
  const [roadsVisible, setRoadsVisible] = useState<boolean>(true)
  const [labelsVisible, setLabelsVisible] = useState<boolean>(true)

  // ── Scene Context ──
  const viewportRef = useRef<unknown>(null)
  const [hudViewport, setHudViewport] = useState<unknown>(null)

  // ── Live Feed ──
  const [satellitesVisible, setSatellitesVisible] = useState<boolean>(true)

  // ── Drawing / Selection ──
  const [drawMode, setDrawMode] = useState<DrawMode>('none')
  const [selection, setSelection] = useState<Selection | null>(null)
  const [showIntegrity, setShowIntegrity] = useState<boolean>(false)
  const [showWeather, setShowWeather] = useState<boolean>(false)
  const [showPredictions, setShowPredictions] = useState<boolean>(false)
  const [showIncident, setShowIncident] = useState<boolean>(false)
  const [showNetGrid, setShowNetGrid] = useState<boolean>(false)
  const [showVerify, setShowVerify] = useState<boolean>(false)
  const [showPrivacy, setShowPrivacy] = useState<boolean>(false)
  const [securityLevel, setSecurityLevel] = useState<SecurityLevel>(0)
  const [lkpPin, setLkpPin] = useState<LngLat | null>(null)
  const [hypotheses, setHypotheses] = useState<Hypothesis[]>([])

  // ── Entity Info Box ──
  const [pickedEntity, setPickedEntityState] = useState<PickedEntity | null>(null)

  // Wrap setPickedEntity to also update scene context (so AI can see what user picked)
  const setPickedEntity = (entity: PickedEntity | null) => {
    setPickedEntityState(entity)
    window.api.scene.set({ selectedFeature: entity })
  }

  // ── Plugin state ──
  const [activePlugins, setActivePlugins] = useState<Set<string>>(new Set())
  const pluginCtxRef = useRef<PluginContext | null>(null)

  // ── Cockpit windowing state ──
  const [dockConfig, setDockConfig] = useState({
    leftWidth: 260,
    rightWidth: 320,
    leftVisible: true,
    rightVisible: true,
    activeLeftTab: 'plugins' as 'layers' | 'plugins',
    activeRightTab: 'inspector' as 'inspector' | 'ai',
  })

  useEffect(() => {
    window.api.imagery.layers().then((layers) => setGibsLayers(layers as GIBSLayer[]))
  }, [])

  // Camera move — store in ref, send to Scene Context, throttle HUD, update plugins
  const hudTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pluginUpdateTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const onCameraMove = useCallback((vp: unknown) => {
    viewportRef.current = vp
    window.api.scene.sendViewport(vp)

    if (hudTimerRef.current) return
    hudTimerRef.current = setTimeout(() => {
      hudTimerRef.current = null
      setHudViewport(viewportRef.current)
    }, 500)

    if (pluginUpdateTimer.current) return
    pluginUpdateTimer.current = setTimeout(() => {
      pluginUpdateTimer.current = null
      if (pluginCtxRef.current) {
        // Merge user-drawn selection bbox into scene context for plugins
        const selBbox = selection ? selectionToBBox(selection) : null
        const vp = viewportRef.current as Record<string, unknown> | null
        pluginManager.updateAll({
          ...pluginCtxRef.current,
          sceneContext: {
            ...(vp ?? {}),
            selection,
            selectionBbox: selBbox,
            lkp: lkpPin,
          },
        })
      }
    }, 1000)
  }, [selection, lkpPin])

  // Reset camera to north (heading=0, pitch=-90 top-down) keeping current position
  const resetNorth = useCallback(() => {
    if (!viewer || viewer.isDestroyed?.()) return
    const cam = viewer.camera
    viewer.camera.flyTo({
      destination: cam.positionWC,
      orientation: {
        heading: 0,
        pitch: Cesium.Math.toRadians(-90),
        roll: 0,
      },
      duration: 0.6,
    })
  }, [viewer])

  // Apply opacity to base imagery
  useEffect(() => {
    if (!viewer) return
    const layer = viewer.imageryLayers.get(0)
    if (layer) layer.alpha = imageryOpacity
  }, [viewer, imageryOpacity])

  // ── Plugin lifecycle ──
  const togglePlugin = useCallback((id: string) => {
    if (activePlugins.has(id)) {
      pluginManager.deactivate(id)
      setActivePlugins((prev) => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
    } else {
      if (pluginCtxRef.current) {
        pluginManager.activate(id)
        setActivePlugins((prev) => new Set(prev).add(id))
        // Immediately send current scene context to the newly-activated plugin
        // so it can process the current selection without waiting for a change
        const selBbox = selection ? selectionToBBox(selection) : null
        const vp = viewportRef.current as Record<string, unknown> | null
        pluginManager.updateAll({
          ...pluginCtxRef.current,
          sceneContext: {
            ...(vp ?? {}),
            selection,
            selectionBbox: selBbox,
            lkp: lkpPin,
          },
        })
      }
    }
  }, [activePlugins, selection, lkpPin])

  // Set up plugin context when viewer is ready
  useEffect(() => {
    if (!viewer) return
    const selBbox = selection ? selectionToBBox(selection) : null
    const vp = viewportRef.current as Record<string, unknown> | null
    const ctx: PluginContext = {
      viewer,
      sceneContext: {
        ...(vp ?? {}),
        selection,
        selectionBbox: selBbox,
        lkp: lkpPin,
      },
      ipc: window.api,
      worldOverlay: worldOverlay ?? undefined,
    }
    pluginCtxRef.current = ctx
    pluginManager.setContext(ctx)
  }, [viewer, selection, lkpPin, worldOverlay])

  // Shutdown plugins on unmount
  useEffect(() => {
    return () => pluginManager.shutdown()
  }, [])

  // Sync global privacy state to the network plugin so it hides the
  // user-location node and connection arcs when privacy is ON.
  useEffect(() => {
    networkPlugin.onControl('privacy', !networkVisibleFor(securityLevel))
  }, [securityLevel])

  const allPlugins = pluginManager.getPlugins()

  return (
    <CockpitShell
      config={dockConfig}
      onConfigChange={setDockConfig}
      leftLayers={
        <MemoLayerPanel
          gibsLayers={gibsLayers}
          imageryLayer={imageryLayer}
          onImageryLayerChange={setImageryLayer}
          overlayVisible={{}}
          onOverlayToggle={() => {}}
          imageryOpacity={imageryOpacity}
          onImageryOpacityChange={setImageryOpacity}
          liveVisible={{ satellites: satellitesVisible }}
          onLiveToggle={(key: string) => {
            if (key === 'satellites') setSatellitesVisible(!satellitesVisible)
          }}
          terrain3d={terrain3d}
          onTerrain3dToggle={() => setTerrain3d(!terrain3d)}
          hillshade={hillshade}
          onHillshadeToggle={() => setHillshade(!hillshade)}
          terrainExaggeration={terrainExaggeration}
          onTerrainExaggerationChange={setTerrainExaggeration}
          roadsVisible={roadsVisible}
          onRoadsToggle={() => setRoadsVisible(!roadsVisible)}
          labelsVisible={labelsVisible}
          onLabelsToggle={() => setLabelsVisible(!labelsVisible)}
        />
      }
      leftPlugins={
        <MemoPluginPanel
          plugins={allPlugins}
          activePlugins={activePlugins}
          onToggle={togglePlugin}
        />
      }
      rightPanel={
        <MemoInspectorPanel
          plugins={allPlugins}
          activePlugins={activePlugins}
          selection={selection}
          lkp={lkpPin}
        />
      }
      aiPanel={
        <AiPanel viewer={viewer} onHypothesesChange={setHypotheses} securityLevel={securityLevel} />
      }
      statusBar={
        <MemoStatusBar
          plugins={allPlugins}
          activePlugins={activePlugins}
          viewport={hudViewport}
          hillshade={hillshade}
          viewer={viewer}
        />
      }
    >
      <MemoGlobe
        imageryLayer={imageryLayer}
        gibsLayers={gibsLayers}
        imageryOpacity={imageryOpacity}
        terrain3d={terrain3d}
        hillshade={hillshade}
        terrainExaggeration={terrainExaggeration}
        roadsVisible={roadsVisible}
        labelsVisible={labelsVisible}
        onViewerReady={(v) => {
          setViewer(v)
          const overlay = new WorldOverlay(v)
          setWorldOverlay(overlay)
          // Initialize HAL — probe WebGPU, WebCodecs, WASM SIMD
          initHalRenderer().catch((e) => console.warn('[hal] init failed:', e))
        }}
        onCameraMove={onCameraMove}
        drawMode={drawMode}
        onSelectionChange={setSelection}
        onPinPlace={setLkpPin}
        onEntityPick={setPickedEntity}
        selection={selection}
        lkpPin={lkpPin}
      />

      {/* Drawing toolbar */}
      <DrawTools
        mode={drawMode}
        onModeChange={setDrawMode}
        onClear={() => {
          setSelection(null)
          setLkpPin(null)
        }}
        hasSelection={selection !== null || lkpPin !== null}
      />

      {/* Satellites overlay — SGP4 driven by Cesium clock */}
      {viewer && satellitesVisible && <SatellitesOverlay viewer={viewer} enabled={satellitesVisible} />}

      {/* World overlay — shared label/card layer with collision management */}
      <WorldOverlayLayer overlay={worldOverlay} />

      {/* HUD bar */}
      <MemoHud viewport={hudViewport} imageryLayer={imageryLayer} onResetNorth={resetNorth} />

      {/* Entity info box — appears when clicking on any entity */}
      <EntityInfoBox entity={pickedEntity} onClose={() => setPickedEntity(null)} />

      {/* Elevation profile — appears when a line is drawn */}
      {selection?.type === 'line' && (
        <ElevationProfile
          lineCoords={selection.coords}
          onClose={() => setSelection(null)}
        />
      )}

      {/* Toggle button toolbar for floating panels */}
      <div style={{
        position: 'absolute', top: 60, right: 12, zIndex: 200,
        display: 'flex', gap: 4, alignItems: 'center',
      }}>
        <PrivacyToggle onChange={setSecurityLevel} />
        <ToolbarBtn label="INTEGRITY" color="#4a9eff" active={showIntegrity} onClick={() => { setShowIntegrity(!showIntegrity); setShowWeather(false); setShowPredictions(false); setShowIncident(false); setShowNetGrid(false) }} />
        <ToolbarBtn label="WEATHER" color="#4affd4" active={showWeather} onClick={() => { setShowWeather(!showWeather); setShowIntegrity(false); setShowPredictions(false); setShowIncident(false); setShowNetGrid(false) }} />
        <ToolbarBtn label="PREDICT" color="#a04aff" active={showPredictions} onClick={() => { setShowPredictions(!showPredictions); setShowIntegrity(false); setShowWeather(false); setShowIncident(false); setShowNetGrid(false) }} />
        <ToolbarBtn label="INCIDENT" color="#ff8a4a" active={showIncident} onClick={() => { setShowIncident(!showIncident); setShowIntegrity(false); setShowWeather(false); setShowPredictions(false); setShowNetGrid(false) }} />
        <ToolbarBtn label="NET/GRID" color="#4affff" active={showNetGrid} onClick={() => { setShowNetGrid(!showNetGrid); setShowIntegrity(false); setShowWeather(false); setShowPredictions(false); setShowIncident(false) }} />
        <ToolbarBtn label="VERIFY" color="#ffea4a" active={showVerify} onClick={() => { setShowVerify(!showVerify); setShowIntegrity(false); setShowWeather(false); setShowPredictions(false); setShowIncident(false); setShowNetGrid(false); setShowPrivacy(false) }} />
        <ToolbarBtn label="PRIVACY" color="#4aff8a" active={showPrivacy} onClick={() => { setShowPrivacy(!showPrivacy); setShowIntegrity(false); setShowWeather(false); setShowPredictions(false); setShowIncident(false); setShowNetGrid(false); setShowVerify(false) }} />
      </div>

      {/* Climate integrity panel — toggleable floating panel */}
      {showIntegrity && (
        <div style={{ position: 'absolute', top: 88, right: 12, zIndex: 200, maxWidth: 280 }}>
          <ClimateIntegrityPanel />
        </div>
      )}

      {/* Weather overlay — current conditions + 24h forecast chart */}
      {showWeather && (
        <WeatherOverlay onClose={() => setShowWeather(false)} />
      )}

      {/* Prediction panel — 7-model prediction engine display */}
      {showPredictions && (
        <PredictionPanel onClose={() => setShowPredictions(false)} />
      )}

      {/* Incident panel — Fall → Flow → Find pipeline */}
      {showIncident && (
        <div style={{ position: 'absolute', top: 88, right: 12, zIndex: 200, width: 280 }}>
          <IncidentPanel
            selection={selection}
            lkp={lkpPin}
            viewportCenter={
              hudViewport && typeof hudViewport === 'object' && 'center' in (hudViewport as any)
                ? (hudViewport as any).center
                : null
            }
            tripParams={{
              hoursSinceLastSeen: 24,
              day: 1,
              pace: 'normal' as any,
              packWeight: 'medium' as any,
              experience: 'intermediate' as any,
              weather: 'clear' as any,
              temperatureC: 20,
              timeOfDay: 'day' as any,
              ageGroup: 'adult' as any,
              fitness: 'average' as any,
            }}
            onFlyTo={(lng, lat) => {
              if (viewer) {
                viewer.camera.flyTo({
                  destination: Cesium.Cartesian3.fromDegrees(lng, lat, 5000),
                  duration: 1.5,
                })
              }
            }}
          />
        </div>
      )}

      {/* Network/Grid operational panel */}
      {showNetGrid && (
        <div style={{ position: 'absolute', top: 88, right: 12, zIndex: 200 }}>
          <NetworkGridPanel privacyMode={!networkVisibleFor(securityLevel)} />
        </div>
      )}

      {/* System verifier panel — on-demand health check */}
      {showVerify && (
        <div style={{ position: 'absolute', top: 88, right: 12, zIndex: 200, width: 360 }}>
          <SystemVerifierPanel securityLevel={securityLevel} onClose={() => setShowVerify(false)} />
        </div>
      )}

      {/* Privacy policy panel — GDPR compliance */}
      {showPrivacy && (
        <PrivacyPolicyPanel onClose={() => setShowPrivacy(false)} />
      )}

      {/* Explainability overlay — AI hypothesis zones on the globe */}
      <ExplainabilityOverlay
        viewer={viewer}
        hypotheses={hypotheses}
        onZoneClick={(zone) => {
          if (viewer && zone.coords.length > 0) {
            const c = zone.coords[0]
            viewer.camera.flyTo({
              destination: Cesium.Cartesian3.fromDegrees(c.lng, c.lat, 50000),
              duration: 1.0,
            })
          }
        }}
      />
    </CockpitShell>
  )
}

/** Toolbar button for floating panel toggles */
function ToolbarBtn({ label, color, active, onClick }: {
  label: string; color: string; active: boolean; onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      style={{
        background: active ? `${color}20` : 'rgba(11, 15, 20, 0.9)',
        border: active ? `1px solid ${color}` : '1px solid #1e2a3a',
        color: active ? color : '#6b7d92',
        padding: '4px 8px',
        borderRadius: 3,
        fontSize: 9,
        letterSpacing: 0.5,
        cursor: 'pointer',
        fontFamily: 'monospace',
        fontWeight: 'bold',
      }}
      title={`Toggle ${label} panel`}
    >
      {label}
    </button>
  )
}
