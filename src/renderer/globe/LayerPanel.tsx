import { useState } from 'react'
import type { GIBSLayer } from '@shared/types'

interface LayerPanelProps {
  gibsLayers: GIBSLayer[]
  imageryLayer: string
  onImageryLayerChange: (id: string) => void
  overlayVisible: Record<string, boolean>
  onOverlayToggle: (key: string) => void
  imageryOpacity: number
  onImageryOpacityChange: (v: number) => void
  liveVisible: Record<string, boolean>
  onLiveToggle: (key: string) => void
  terrain3d: boolean
  onTerrain3dToggle: () => void
  hillshade: boolean
  onHillshadeToggle: () => void
  terrainExaggeration: number
  onTerrainExaggerationChange: (v: number) => void
  roadsVisible: boolean
  onRoadsToggle: () => void
  labelsVisible: boolean
  onLabelsToggle: () => void
}

const GIBS_CATEGORIES: { key: GIBSLayer['category']; label: string; color: string }[] = [
  { key: 'true-color', label: 'True Color', color: '#4a9eff' },
  { key: 'false-color', label: 'False Color', color: '#a04aff' },
  { key: 'vegetation', label: 'Vegetation', color: '#4aff8a' },
  { key: 'thermal', label: 'Thermal', color: '#ff8a4a' },
  { key: 'geostationary', label: 'Geostationary', color: '#ffcf4a' },
  { key: 'atmosphere', label: 'Atmosphere', color: '#4affff' },
]

export default function LayerPanel({
  gibsLayers,
  imageryLayer,
  onImageryLayerChange,
  imageryOpacity,
  onImageryOpacityChange,
  liveVisible,
  onLiveToggle,
  terrain3d,
  onTerrain3dToggle,
  hillshade,
  onHillshadeToggle,
  terrainExaggeration,
  onTerrainExaggerationChange,
  roadsVisible,
  onRoadsToggle,
  labelsVisible,
  onLabelsToggle,
}: LayerPanelProps) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({
    base: true,
    terrain: true,
    gibs: false,
    live: true,
  })

  const toggle = (section: string) => setExpanded((e) => ({ ...e, [section]: !e[section] }))

  const layersByCategory = GIBS_CATEGORIES.map((cat) => ({
    ...cat,
    layers: gibsLayers.filter((l) => l.category === cat.key),
  })).filter((c) => c.layers.length > 0)

  return (
    <div style={panelStyle.container}>
      {/* Base Imagery */}
      <div style={panelStyle.section}>
        <button style={panelStyle.sectionHeader(expanded.base)} onClick={() => toggle('base')}>
          <span>{expanded.base ? '▼' : '▶'}</span> BASE IMAGERY
        </button>
        {expanded.base && (
          <div style={panelStyle.sectionBody}>
            <div style={panelStyle.layerRow}>
              <select
                value={imageryLayer}
                onChange={(e) => onImageryLayerChange(e.target.value)}
                style={panelStyle.select}
              >
                <option value="esri">Sentinel-2 (Esri World Imagery)</option>
                {gibsLayers.map((l) => (
                  <option key={l.id} value={l.id}>{l.name}</option>
                ))}
              </select>
            </div>
            <div style={panelStyle.layerRow}>
              <span style={panelStyle.label}>Opacity</span>
              <input
                type="range" min="0" max="1" step="0.05"
                value={imageryOpacity}
                onChange={(e) => onImageryOpacityChange(parseFloat(e.target.value))}
                style={panelStyle.slider}
              />
              <span style={panelStyle.value}>{(imageryOpacity * 100).toFixed(0)}%</span>
            </div>
            {imageryLayer !== 'esri' && (() => {
              const layer = gibsLayers.find((l) => l.id === imageryLayer)
              return layer ? (
                <div style={panelStyle.hint}>
                  {layer.description}
                  <br />
                  <span style={panelStyle.tag}>⏱ {layer.temporalResolution}</span>
                  <span style={panelStyle.tag}>🔍 Max Z{layer.maxZoom}</span>
                </div>
              ) : null
            })()}
          </div>
        )}
      </div>

      {/* Road Network + Labels */}
      <div style={panelStyle.section}>
        <button style={panelStyle.sectionHeader(expanded.base)} onClick={() => toggle('base')}>
          <span>{expanded.base ? '▼' : '▶'}</span> ROAD NETWORK
        </button>
        {expanded.base && (
          <div style={panelStyle.sectionBody}>
            <label style={panelStyle.layerRow}>
              <input type="checkbox" checked={roadsVisible} onChange={onRoadsToggle} style={panelStyle.checkbox} />
              <span style={panelStyle.layerDot('#ffea4a')} />
              <span style={panelStyle.layerName}>Roads & Highways</span>
            </label>
            <label style={panelStyle.layerRow}>
              <input type="checkbox" checked={labelsVisible} onChange={onLabelsToggle} style={panelStyle.checkbox} />
              <span style={panelStyle.layerDot('#c0c8d0')} />
              <span style={panelStyle.layerName}>Place Labels & Boundaries</span>
            </label>
            <p style={panelStyle.hint}>
              Esri Transportation + Reference overlays. Vector roads, highways, rail, place names, and administrative boundaries on top of the satellite base imagery.
            </p>
          </div>
        )}
      </div>

      {/* Terrain & Hillshade */}
      <div style={panelStyle.section}>
        <button style={panelStyle.sectionHeader(expanded.terrain)} onClick={() => toggle('terrain')}>
          <span>{expanded.terrain ? '▼' : '▶'}</span> TERRAIN
        </button>
        {expanded.terrain && (
          <div style={panelStyle.sectionBody}>
            <label style={panelStyle.layerRow}>
              <input type="checkbox" checked={terrain3d} onChange={onTerrain3dToggle} style={panelStyle.checkbox} />
              <span style={panelStyle.layerDot('#8a6a4a')} />
              <span style={panelStyle.layerName}>3D Terrain (ArcGIS DEM)</span>
            </label>
            {terrain3d && (
              <div style={panelStyle.layerRow}>
                <span style={panelStyle.label}>Exaggeration</span>
                <input
                  type="range" min="0.5" max="5" step="0.1"
                  value={terrainExaggeration}
                  onChange={(e) => onTerrainExaggerationChange(parseFloat(e.target.value))}
                  style={panelStyle.slider}
                />
                <span style={panelStyle.value}>{terrainExaggeration.toFixed(1)}×</span>
              </div>
            )}
            <label style={panelStyle.layerRow}>
              <input type="checkbox" checked={hillshade} onChange={onHillshadeToggle} style={panelStyle.checkbox} />
              <span style={panelStyle.layerDot('#c0c8d0')} />
              <span style={panelStyle.layerName}>Hillshade (Sun Lighting)</span>
            </label>
          </div>
        )}
      </div>

      {/* Satellite Layers (GIBS) */}
      <div style={panelStyle.section}>
        <button style={panelStyle.sectionHeader(expanded.gibs)} onClick={() => toggle('gibs')}>
          <span>{expanded.gibs ? '▼' : '▶'}</span> SATELLITE LAYERS ({gibsLayers.length})
        </button>
        {expanded.gibs && (
          <div style={panelStyle.sectionBody}>
            {layersByCategory.map((cat) => (
              <div key={cat.key} style={panelStyle.category}>
                <div style={panelStyle.categoryHeader(cat.color)}>{cat.label}</div>
                {cat.layers.map((l) => (
                  <button
                    key={l.id}
                    style={panelStyle.layerBtn(imageryLayer === l.id)}
                    onClick={() => onImageryLayerChange(l.id)}
                    title={l.description}
                  >
                    <span style={panelStyle.layerDot(cat.color)} />
                    {l.name}
                    <span style={panelStyle.layerRes}>{l.temporalResolution}</span>
                  </button>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Live Data — satellites (overlay-level, others are plugins) */}
      <div style={panelStyle.section}>
        <button style={panelStyle.sectionHeader(expanded.live)} onClick={() => toggle('live')}>
          <span>{expanded.live ? '▼' : '▶'}</span> LIVE OVERLAYS
        </button>
        {expanded.live && (
          <div style={panelStyle.sectionBody}>
            <label style={panelStyle.layerRow}>
              <input
                type="checkbox"
                checked={liveVisible['satellites'] ?? true}
                onChange={() => onLiveToggle('satellites')}
                style={panelStyle.checkbox}
              />
              <span style={panelStyle.layerDot('#ff4a4a')} />
              <span style={panelStyle.layerName}>Satellites (ISS SGP4)</span>
            </label>
            <p style={panelStyle.hint}>
              All other feeds (aircraft, fires, vessels, lightning, climate, grid, network) are in the PLUGINS tab.
            </p>
          </div>
        )}
      </div>
    </div>
  )
}

const panelStyle = {
  container: {
    background: 'rgba(11, 15, 20, 0.92)',
    border: '1px solid #1e2a3a',
    borderRadius: 4,
    width: '100%',
    color: '#c0c8d0',
    fontFamily: 'monospace' as const,
    fontSize: 11,
    backdropFilter: 'blur(8px)',
  },
  section: { borderBottom: '1px solid #1e2a3a' },
  sectionHeader: (exp: boolean) => ({
    display: 'flex', alignItems: 'center', gap: 6, width: '100%', padding: '7px 10px',
    background: 'transparent', color: exp ? '#4a9eff' : '#8b9dad', border: 'none',
    fontSize: 10, letterSpacing: 1, cursor: 'pointer', textAlign: 'left' as const, fontWeight: 'bold' as const,
  }),
  sectionBody: { padding: '4px 10px 8px' },
  layerRow: { display: 'flex', alignItems: 'center', gap: 6, padding: '3px 0', cursor: 'pointer' },
  select: {
    width: '100%', padding: '4px 6px', background: '#0b0f14', color: '#c0c8d0',
    border: '1px solid #1e2a3a', borderRadius: 2, fontSize: 10, fontFamily: 'monospace' as const,
  },
  slider: { flex: 1, height: 4, accentColor: '#4a9eff' },
  label: { fontSize: 10, color: '#8b9dad', minWidth: 50 },
  value: { fontSize: 9, color: '#6b7d92', minWidth: 30, textAlign: 'right' as const },
  hint: {
    fontSize: 9, color: '#6b7d92', marginTop: 4, padding: '4px 6px',
    background: 'rgba(74, 158, 255, 0.05)', borderRadius: 2, lineHeight: 1.5,
  },
  tag: { display: 'inline-block', marginRight: 6, color: '#4a9eff' },
  category: { marginBottom: 6 },
  categoryHeader: (color: string) => ({
    fontSize: 9, color, letterSpacing: 1, marginBottom: 2, paddingBottom: 2,
    borderBottom: `1px solid ${color}22`,
  }),
  layerBtn: (active: boolean) => ({
    display: 'flex', alignItems: 'center', gap: 6, width: '100%', padding: '4px 6px',
    background: active ? 'rgba(74, 158, 255, 0.15)' : 'transparent',
    color: active ? '#4a9eff' : '#c0c8d0', border: 'none', borderRadius: 2,
    fontSize: 10, cursor: 'pointer', textAlign: 'left' as const, fontFamily: 'monospace' as const,
  }),
  layerDot: (color: string) => ({
    display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: color, flexShrink: 0,
  }),
  layerName: { flex: 1, fontSize: 10 },
  layerRes: { fontSize: 8, color: '#6b7d92' },
  checkbox: { accentColor: '#4a9eff' },
}
