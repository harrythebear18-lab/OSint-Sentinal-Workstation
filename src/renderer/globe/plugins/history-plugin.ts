/**
 * History & Research Plugin — historic sites from OpenStreetMap via Overpass
 * (historic=*), era-classified and rendered as era-colored markers.
 *
 *  - Fetches all historic=* nodes/ways/relations inside the selection bbox
 *  - Classifies into era buckets: Prehistoric → Roman → Medieval →
 *    Early Modern → Industrial → WW1 → WW2 (post-1945 excluded by default)
 *  - Click a site → info card in the panel + Wikipedia summary (when the
 *    site carries a wikipedia= tag) + Wikidata QID
 *  - Export visible sites as GeoJSON
 *
 * Runs automatically when the selection bbox changes, or manually via Fetch.
 */

import * as Cesium from 'cesium'
import type { EarthEnginePlugin, PluginContext, PluginStats, PluginControlSpec } from './plugin-manager'
import type { BBox, HistoricEra, HistoricSite, HistoryResponse } from '@shared/types'

const MAX_VISIBLE_ENTITIES = 20000

const ERA_COLORS: Record<HistoricEra, [number, number, number]> = {
  prehistoric: [200, 138, 74],   // ochre
  roman: [212, 80, 74],          // imperial red
  medieval: [138, 106, 255],     // purple
  'early-modern': [74, 158, 255],// blue
  industrial: [150, 160, 170],   // slate
  ww1: [168, 140, 90],           // khaki
  ww2: [106, 138, 74],           // olive drab
  modern: [90, 90, 90],          // dim grey
  unknown: [190, 190, 190],      // light grey
}

const ERA_OPTIONS = [
  { label: 'All eras', value: 'all' },
  { label: 'Prehistoric', value: 'prehistoric' },
  { label: 'Roman', value: 'roman' },
  { label: 'Medieval', value: 'medieval' },
  { label: 'Early Modern', value: 'early-modern' },
  { label: 'Industrial', value: 'industrial' },
  { label: 'WW1', value: 'ww1' },
  { label: 'WW2', value: 'ww2' },
  { label: 'Undated', value: 'unknown' },
]

interface SelectedSite extends HistoricSite {
  wikiExtract?: string
  wikiLoading?: boolean
}

export class HistoryPlugin implements EarthEnginePlugin {
  id = 'history'
  name = 'History & Research (OSM)'
  category = 'history' as const

  private viewer: Cesium.Viewer | null = null
  private dataSource: Cesium.CustomDataSource | null = null
  private ipc: typeof window.api | null = null
  private status: PluginStats = { count: 0, status: 'disabled' }
  private allSites: HistoricSite[] = []
  private siteById = new Map<string, HistoricSite>()
  private lastBbox: string | null = null
  private lastBboxParsed: { west: number; south: number; east: number; north: number } | null = null
  private lastViewBbox: string | null = null
  private show = true
  private eraFilter: HistoricEra | 'all' = 'all'
  private includePost1945 = false
  private selected: SelectedSite | null = null
  private lastError: string | null = null
  private clickHandler: Cesium.ScreenSpaceEventHandler | null = null

  async register(ctx: PluginContext): Promise<void> {
    this.viewer = ctx.viewer
    this.ipc = ctx.ipc
    this.dataSource = new Cesium.CustomDataSource('history')
    ctx.viewer.dataSources.add(this.dataSource)
    this.status = { count: 0, status: 'nominal' }

    this.clickHandler = new Cesium.ScreenSpaceEventHandler(ctx.viewer.canvas)
    this.clickHandler.setInputAction((click: { position: Cesium.Cartesian2 }) => {
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
    this.allSites = []
    this.siteById.clear()
    this.selected = null
    this.lastBbox = null
    this.lastViewBbox = null
    this.viewer = null
    this.ipc = null
    this.status = { count: 0, status: 'disabled' }
  }

  update(ctx: PluginContext): void {
    const sceneCtx = ctx.sceneContext as any

    // ── Fetch sites when selection bbox changes ──
    const selBbox = sceneCtx?.selectionBbox
    if (selBbox) {
      this.lastBboxParsed = selBbox
      const bboxKey = `${selBbox.west.toFixed(2)},${selBbox.south.toFixed(2)},${selBbox.east.toFixed(2)},${selBbox.north.toFixed(2)}`
      if (bboxKey !== this.lastBbox) {
        this.lastBbox = bboxKey
        const height = sceneCtx?.camera?.height
        if (!height || height <= 500_000) {
          this.fetchSites(selBbox)
        }
      }
    }

    // ── Viewport culling on camera move ──
    const viewBbox = sceneCtx?.bbox as BBox | undefined
    if (viewBbox && this.allSites.length > 0) {
      const viewKey = `${viewBbox.west.toFixed(3)},${viewBbox.south.toFixed(3)},${viewBbox.east.toFixed(3)},${viewBbox.north.toFixed(3)}`
      if (viewKey !== this.lastViewBbox) {
        this.lastViewBbox = viewKey
        this.cullToViewport(viewBbox)
      }
    }
  }

  getStats(): PluginStats {
    return this.status
  }

  clear(): void {
    this.dataSource?.entities.removeAll()
    this.allSites = []
    this.siteById.clear()
    this.selected = null
    this.lastBbox = null
    this.lastViewBbox = null
    this.status = { count: 0, status: 'nominal' }
  }

  getControls(): PluginControlSpec[] {
    const rendered = this.dataSource?.entities.values.length ?? 0
    const controls: PluginControlSpec[] = [
      { type: 'toggle', id: 'visible', label: 'Visible', value: this.show },
      { type: 'select', id: 'era', label: 'Era', value: this.eraFilter, options: ERA_OPTIONS },
      { type: 'toggle', id: 'post1945', label: 'Include post-1945', value: this.includePost1945 },
      { type: 'button', id: 'run', label: 'Fetch Historic Sites', variant: 'primary' },
      { type: 'button', id: 'export', label: 'Export GeoJSON', variant: 'default', disabled: this.allSites.length === 0 },
      { type: 'button', id: 'clear', label: 'Clear', variant: 'danger', disabled: this.allSites.length === 0 },
      { type: 'separator', id: 'sep1' },
      { type: 'display', id: 'total', label: 'Sites', value: String(this.allSites.length), color: '#d4a04a' },
      { type: 'display', id: 'rendered', label: 'Rendered', value: String(rendered), color: '#4affd4' },
    ]

    // Per-era counts (only for eras present)
    const counts = new Map<HistoricEra, number>()
    for (const s of this.allSites) counts.set(s.era, (counts.get(s.era) ?? 0) + 1)
    for (const opt of ERA_OPTIONS) {
      if (opt.value === 'all') continue
      const n = counts.get(opt.value as HistoricEra) ?? 0
      if (n > 0) {
        const [r, g, b] = ERA_COLORS[opt.value as HistoricEra]
        controls.push({
          type: 'display',
          id: `era-${opt.value}`,
          label: opt.label,
          value: String(n),
          color: `rgb(${r},${g},${b})`,
        })
      }
    }

    // Selected site info card
    if (this.selected) {
      const s = this.selected
      controls.push({ type: 'separator', id: 'sep-site' })
      controls.push({ type: 'display', id: 'sel-name', label: 'Site', value: s.name.slice(0, 48), color: '#d4a04a' })
      controls.push({ type: 'display', id: 'sel-era', label: 'Era', value: s.eraLabel, color: '#4affd4' })
      controls.push({ type: 'display', id: 'sel-type', label: 'Type', value: s.historicType, color: '#8a9aa8' })
      if (s.startDate) controls.push({ type: 'display', id: 'sel-date', label: 'Date', value: s.startDate, color: '#8a9aa8' })
      if (s.heritage) controls.push({ type: 'display', id: 'sel-heritage', label: 'Heritage', value: s.heritage, color: '#8a9aa8' })
      if (s.wikidata) controls.push({ type: 'display', id: 'sel-wikidata', label: 'Wikidata', value: s.wikidata, color: '#8a9aa8' })
      if (s.wikiLoading) {
        controls.push({ type: 'display', id: 'sel-wiki', label: 'Wikipedia', value: 'Loading…', color: '#8a9aa8' })
      } else if (s.wikiExtract) {
        controls.push({ type: 'display', id: 'sel-wiki', label: 'Wikipedia', value: s.wikiExtract.slice(0, 220), color: '#c8d0d8' })
      } else if (s.wikipedia) {
        controls.push({ type: 'display', id: 'sel-wiki', label: 'Wikipedia', value: s.wikipedia, color: '#8a9aa8' })
      }
    }

    if (this.lastError) {
      controls.push({ type: 'display', id: 'error', label: 'Error', value: this.lastError.slice(0, 60), color: '#ff4a4a' })
    }
    return controls
  }

  onControl(id: string, value?: unknown): void {
    if (id === 'visible' && typeof value === 'boolean') {
      this.show = value
      if (this.dataSource) this.dataSource.show = value
    } else if (id === 'era' && typeof value === 'string') {
      this.eraFilter = value as HistoricEra | 'all'
      this.lastViewBbox = null
      this.renderAll()
    } else if (id === 'post1945' && typeof value === 'boolean') {
      this.includePost1945 = value
      if (this.lastBboxParsed) {
        this.lastBbox = null
        this.fetchSites(this.lastBboxParsed)
      }
    } else if (id === 'run') {
      if (this.lastBboxParsed) {
        this.lastBbox = null
        this.fetchSites(this.lastBboxParsed)
      }
    } else if (id === 'export') {
      this.exportGeoJSON()
    } else if (id === 'clear') {
      this.clear()
    }
  }

  getFeatures(): HistoricSite[] {
    return this.allSites
  }

  private async fetchSites(bbox: { west: number; south: number; east: number; north: number }): Promise<void> {
    if (!this.ipc || !this.dataSource) return
    this.status = { ...this.status, status: 'loading' }

    try {
      const result = (await this.ipc.invoke('history:sites:fetch', {
        bounds: [
          { lng: bbox.west, lat: bbox.south },
          { lng: bbox.east, lat: bbox.north },
        ],
        opts: { includePost1945: this.includePost1945 },
      })) as HistoryResponse | null

      if (!result?.sites) {
        this.status = { count: 0, status: 'nominal' }
        return
      }

      this.allSites = result.sites
      this.siteById.clear()
      for (const s of this.allSites) this.siteById.set(s.id, s)
      this.lastError = result.error ?? null
      this.selected = null
      this.dataSource.entities.removeAll()
      this.lastViewBbox = null

      this.cullToViewport({ west: bbox.west, south: bbox.south, east: bbox.east, north: bbox.north })
      this.status = { count: result.sites.length, status: 'nominal' }
    } catch (err) {
      console.warn('[history] fetch failed:', err)
      this.status = { ...this.status, status: 'error', error: String(err) }
    }
  }

  /** Re-render everything (used when the era filter changes). */
  private renderAll(): void {
    if (!this.dataSource) return
    this.dataSource.entities.removeAll()
    const viewBbox: BBox = this.lastBboxParsed
      ? { ...this.lastBboxParsed }
      : { west: -180, south: -90, east: 180, north: 90 }
    this.cullToViewport(viewBbox)
  }

  private siteVisible(s: HistoricSite): boolean {
    return this.eraFilter === 'all' || s.era === this.eraFilter
  }

  private cullToViewport(viewBbox: BBox): void {
    if (!this.dataSource) return

    const visibleIds = new Set<string>()
    const toAdd: HistoricSite[] = []
    let count = 0

    for (const s of this.allSites) {
      if (count >= MAX_VISIBLE_ENTITIES) break
      if (!this.siteVisible(s)) continue
      if (this.siteIntersectsBbox(s, viewBbox)) {
        visibleIds.add(s.id)
        if (!this.dataSource.entities.getById(`history:${s.id}`)) {
          toAdd.push(s)
        }
        count++
      }
    }

    const toRemove: string[] = []
    const existing = this.dataSource.entities.values
    for (let i = 0; i < existing.length; i++) {
      const e = existing[i]
      const siteId = e.id.startsWith('history:') ? e.id.slice(8) : e.id
      if (!visibleIds.has(siteId)) {
        toRemove.push(e.id)
      }
    }
    for (const id of toRemove) {
      this.dataSource.entities.removeById(id)
    }

    for (const s of toAdd) {
      this.addSiteEntity(s)
    }

    this.dataSource.show = this.show
    if (toAdd.length > 0 || toRemove.length > 0) {
      try { this.viewer?.scene.requestRender() } catch {}
    }
  }

  private siteIntersectsBbox(s: HistoricSite, bbox: BBox): boolean {
    if (s.coords && s.coords.length > 0) {
      for (const c of s.coords) {
        if (c.lng >= bbox.west && c.lng <= bbox.east && c.lat >= bbox.south && c.lat <= bbox.north) return true
      }
      return false
    }
    return s.lng >= bbox.west && s.lng <= bbox.east && s.lat >= bbox.south && s.lat <= bbox.north
  }

  private addSiteEntity(s: HistoricSite): void {
    if (!this.dataSource) return
    const [r, g, b] = ERA_COLORS[s.era]
    const color = Cesium.Color.fromBytes(r, g, b, 230)

    // Sites with way geometry get a ground-clamped outline polygon
    if (s.coords && s.coords.length >= 3) {
      const positions = s.coords.map((c) => Cesium.Cartesian3.fromDegrees(c.lng, c.lat))
      this.dataSource.entities.add({
        id: `history:${s.id}`,
        polygon: {
          hierarchy: new Cesium.PolygonHierarchy(positions),
          material: new Cesium.ColorMaterialProperty(color.withAlpha(0.18)),
          outline: true,
          outlineColor: new Cesium.ConstantProperty(color.withAlpha(0.7)),
        },
        properties: { siteId: s.id },
      } as any)
    }

    // Marker + label at the site centroid (labels fade in under 50 km)
    this.dataSource.entities.add({
      id: `history:${s.id}:marker`,
      position: Cesium.Cartesian3.fromDegrees(s.lng, s.lat),
      point: {
        pixelSize: 9,
        color: new Cesium.ConstantProperty(color),
        outlineColor: new Cesium.ConstantProperty(Cesium.Color.BLACK.withAlpha(0.8)),
        outlineWidth: new Cesium.ConstantProperty(2),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      label: {
        text: s.name,
        font: '11px sans-serif',
        fillColor: new Cesium.ConstantProperty(color.withAlpha(1)),
        outlineColor: new Cesium.ConstantProperty(Cesium.Color.BLACK),
        outlineWidth: new Cesium.ConstantProperty(3),
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        pixelOffset: new Cesium.Cartesian2(0, -16),
        distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 80_000),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      properties: { siteId: s.id },
    } as any)
  }

  private handleClick(click: { position: Cesium.Cartesian2 }): void {
    if (!this.viewer) return
    const picked = this.viewer.scene.pick(click.position) as any
    const siteId = picked?.id?.properties?.siteId?.getValue?.() ?? picked?.id?.properties?.siteId
    if (!siteId || typeof siteId !== 'string') {
      if (this.selected) this.selected = null
      return
    }
    const site = this.siteById.get(siteId)
    if (!site) return
    this.selected = { ...site, wikiLoading: !!site.wikipedia }
    if (site.wikipedia) this.fetchWikiSummary(siteId, site.wikipedia)
  }

  /** Pull the Wikipedia REST summary for an OSM wikipedia= tag ("en:Stonehenge"). */
  private async fetchWikiSummary(siteId: string, tag: string): Promise<void> {
    const sep = tag.indexOf(':')
    const lang = sep > 0 ? tag.slice(0, sep) : 'en'
    const title = sep > 0 ? tag.slice(sep + 1) : tag
    try {
      const res = await fetch(
        `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`,
        { signal: AbortSignal.timeout(10000) },
      )
      if (!res.ok) return
      const data = await res.json()
      if (this.selected?.id === siteId) {
        this.selected = { ...this.selected, wikiExtract: data.extract ?? data.description ?? '', wikiLoading: false }
      }
    } catch {
      if (this.selected?.id === siteId) {
        this.selected = { ...this.selected, wikiLoading: false }
      }
    }
  }

  private async exportGeoJSON(): Promise<void> {
    if (!this.ipc || this.allSites.length === 0) return
    const visible = this.allSites.filter((s) => this.siteVisible(s))
    const collection = {
      type: 'FeatureCollection',
      features: visible.map((s) => ({
        type: 'Feature',
        geometry:
          s.coords && s.coords.length >= 3
            ? { type: 'Polygon', coordinates: [[...s.coords.map((c) => [c.lng, c.lat]), [s.coords[0].lng, s.coords[0].lat]]] }
            : { type: 'Point', coordinates: [s.lng, s.lat] },
        properties: {
          name: s.name,
          historicType: s.historicType,
          era: s.era,
          eraLabel: s.eraLabel,
          startDate: s.startDate,
          heritage: s.heritage,
          wikipedia: s.wikipedia,
          wikidata: s.wikidata,
          description: s.description,
          osmId: s.id,
        },
      })),
    }
    try {
      await this.ipc.invoke('export:geojson', collection)
    } catch (err) {
      console.warn('[history] export failed:', err)
    }
  }
}

export const historyPlugin = new HistoryPlugin()
