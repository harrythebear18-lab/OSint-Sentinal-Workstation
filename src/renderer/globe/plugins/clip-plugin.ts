/**
 * CLIP Plugin — Tile embeddings + similarity search.
 * Tier 4, Priority 12. From OGOS.
 *
 * Captures the current viewport as an image, embeds it via CLIP,
 * and searches for similar tiles/regions. Renders similarity heatmaps.
 */

import * as Cesium from 'cesium'
import type { EarthEnginePlugin, PluginContext, PluginStats, PluginControlSpec } from './plugin-manager'

interface SimilarityResult {
  id: string
  lon: number
  lat: number
  score: number
  thumbnail?: string
}

export class ClipPlugin implements EarthEnginePlugin {
  id = 'clip-search'
  name = 'CLIP (Tile Similarity)'
  category = 'ai' as const

  private viewer: Cesium.Viewer | null = null
  private dataSource: Cesium.CustomDataSource | null = null
  private ipc: typeof window.api | null = null
  private status: PluginStats = { count: 0, status: 'disabled' }
  private results: SimilarityResult[] = []
  private queryText: string | null = null
  private clipHealthy = false

  async register(ctx: PluginContext): Promise<void> {
    this.viewer = ctx.viewer
    this.ipc = ctx.ipc
    this.dataSource = new Cesium.CustomDataSource('clip-search')
    ctx.viewer.dataSources.add(this.dataSource)
    this.status = { count: 0, status: 'loading' }

    // Check CLIP server health
    try {
      const health = await this.ipc!.invoke('ai:clip:health', {}) as { running: boolean; model?: string } | null
      this.clipHealthy = health?.running === true
      this.status = {
        count: 0,
        status: this.clipHealthy ? 'nominal' : 'error',
        error: this.clipHealthy ? undefined : 'CLIP server not running on :9776',
      }
    } catch (err) {
      this.clipHealthy = false
      this.status = { count: 0, status: 'error', error: String(err) }
    }
  }

  unregister(): void {
    if (this.dataSource && this.viewer && !this.viewer.isDestroyed?.()) {
      this.viewer.dataSources.remove(this.dataSource)
    }
    this.dataSource = null
    this.results = []
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
      { type: 'display', id: 'health', label: 'CLIP Server', value: this.clipHealthy ? 'ONLINE :9776' : 'OFFLINE', color: this.clipHealthy ? '#4aff8a' : '#ff4a4a' },
      { type: 'input', id: 'query', label: 'Text Query', value: this.queryText ?? '', placeholder: 'e.g. forest clearing, urban sprawl...' },
      { type: 'button', id: 'searchText', label: 'Search by Text', variant: 'primary', disabled: !this.clipHealthy },
      { type: 'button', id: 'searchViewport', label: 'Search by Viewport', variant: 'primary', disabled: !this.clipHealthy },
      { type: 'button', id: 'clear', label: 'Clear Results', variant: 'danger', disabled: this.results.length === 0 },
      { type: 'separator', id: 'sep1' },
      { type: 'display', id: 'results', label: 'Matches', value: String(this.results.length), color: '#a04aff' },
    ]
  }

  async onControl(id: string, value?: unknown): Promise<void> {
    if (id === 'query' && typeof value === 'string') {
      this.queryText = value
    } else if (id === 'searchText' && this.queryText) {
      await this.searchByText(this.queryText)
    } else if (id === 'searchViewport') {
      await this.searchByViewport()
    } else if (id === 'clear') {
      this.clearResults()
    }
  }

  isHealthy(): boolean {
    return this.clipHealthy
  }

  getResults(): SimilarityResult[] {
    return this.results
  }

  /**
   * Search by text query — embeds text, searches tile database.
   */
  async searchByText(query: string): Promise<void> {
    if (!this.ipc || !this.dataSource || !this.clipHealthy) return
    this.status = { ...this.status, status: 'loading' }
    this.queryText = query

    try {
      const result = await this.ipc.invoke('ai:clip:search', {
        text: query,
        limit: 50,
      }) as { results: SimilarityResult[] } | null

      if (!result?.results) {
        this.status = { count: 0, status: 'nominal' }
        return
      }

      this.results = result.results
      this.dataSource.entities.removeAll()

      for (const r of result.results) {
        this.addResultEntity(r)
      }

      this.status = { count: result.results.length, status: 'nominal' }
    } catch (err) {
      this.status = { ...this.status, status: 'error', error: String(err) }
      console.warn('[clip] search failed:', err)
    }
  }

  /**
   * Search by current viewport — captures canvas, embeds image, searches.
   */
  async searchByViewport(): Promise<void> {
    if (!this.ipc || !this.dataSource || !this.clipHealthy || !this.viewer) return
    this.status = { ...this.status, status: 'loading' }

    try {
      // Capture canvas as data URL
      const canvas = this.viewer.canvas
      const dataUrl = canvas.toDataURL('image/png')

      const result = await this.ipc.invoke('ai:clip:search', {
        image: dataUrl,
        limit: 50,
      }) as { results: SimilarityResult[] } | null

      if (!result?.results) {
        this.status = { count: 0, status: 'nominal' }
        return
      }

      this.results = result.results
      this.dataSource.entities.removeAll()

      for (const r of result.results) {
        this.addResultEntity(r)
      }

      this.status = { count: result.results.length, status: 'nominal' }
    } catch (err) {
      this.status = { ...this.status, status: 'error', error: String(err) }
      console.warn('[clip] viewport search failed:', err)
    }
  }

  clearResults(): void {
    this.results = []
    this.dataSource?.entities.removeAll()
    this.status = { count: 0, status: 'nominal' }
  }

  private addResultEntity(r: SimilarityResult): void {
    if (!this.dataSource) return

    // Score-based color: 1.0 (perfect) = bright green, 0.5 = yellow, 0.0 = red
    const t = Math.max(0, Math.min(1, r.score))
    const color = Cesium.Color.fromBytes(
      Math.round(255 * (1 - t)),
      Math.round(255 * t),
      Math.round(74 * t),
      255,
    )

    const pixelSize = Math.max(6, Math.min(14, 6 + t * 8))

    this.dataSource.entities.add({
      id: `clip:${r.id}`,
      position: Cesium.Cartesian3.fromDegrees(r.lon, r.lat),
      point: {
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        pixelSize,
        color: new Cesium.ConstantProperty(color),
        outlineColor: new Cesium.ConstantProperty(Cesium.Color.WHITE.withAlpha(0.7)),
        outlineWidth: new Cesium.ConstantProperty(1),
      },
      properties: {
        score: r.score,
      },
    } as any)
  }
}

export const clipPlugin = new ClipPlugin()
