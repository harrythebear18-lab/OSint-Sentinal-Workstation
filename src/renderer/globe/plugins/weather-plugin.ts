/**
 * Weather Plugin — RainViewer radar + Open-Meteo forecast.
 * Tier 1, Priority 1. Both OGOS and GEV rely on weather heavily.
 *
 * Renders:
 * - RainViewer radar tiles as a Cesium imagery overlay (blended, semi-transparent)
 * - RainViewer satellite infrared tiles (optional)
 * - Current conditions + 24h forecast via IPC (weather panel reads this)
 */

import * as Cesium from 'cesium'
import type { EarthEnginePlugin, PluginContext, PluginStats, PluginControlSpec } from './plugin-manager'
import type { WeatherResponse } from '@shared/types'

interface RadarData {
  host: string
  radarPast: { time: number; path: string }[]
  radarNowcast: { time: number; path: string }[]
  satellite: { time: number; path: string }[]
  generated: number
}

export class WeatherPlugin implements EarthEnginePlugin {
  id = 'weather'
  name = 'Weather (Radar + Forecast)'
  category = 'live' as const

  private viewer: Cesium.Viewer | null = null
  private radarLayer: Cesium.ImageryLayer | null = null
  private satelliteLayer: Cesium.ImageryLayer | null = null
  private radarData: RadarData | null = null
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private status: PluginStats = { count: 0, status: 'disabled' }
  private showRadar = true
  private showSatellite = false
  private radarOpacity = 0.6
  private forecast: WeatherResponse | null = null
  private forecastPoint: { lng: number; lat: number } | null = null

  async register(ctx: PluginContext): Promise<void> {
    this.viewer = ctx.viewer
    this.status = { count: 0, status: 'loading' }

    // Fetch radar metadata
    try {
      this.radarData = await this.fetchRadarData()
      this.status = { count: this.radarData.radarPast.length, status: 'nominal' }
    } catch (err) {
      this.status = { count: 0, status: 'error', error: String(err) }
      console.error('[weather] failed to fetch radar data:', err)
    }

    // Add radar layer (latest past frame)
    if (this.radarData && this.showRadar) {
      this.addRadarLayer()
    }

    // Poll for new radar frames every 10 minutes
    this.pollTimer = setInterval(() => this.refreshRadar(), 10 * 60 * 1000)
  }

  unregister(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
    this.removeRadarLayer()
    this.removeSatelliteLayer()
    this.viewer = null
    this.status = { count: 0, status: 'disabled' }
  }

  update(ctx: PluginContext): void {
    // Auto-fetch forecast for the LKP or viewport center
    const sceneCtx = ctx.sceneContext as any
    const lkp = sceneCtx?.lkp
    const center = sceneCtx?.camera?.center
    const point = lkp ?? center
    if (point && (!this.forecastPoint || Math.abs(point.lng - this.forecastPoint.lng) > 0.05 || Math.abs(point.lat - this.forecastPoint.lat) > 0.05)) {
      this.forecastPoint = point
      this.fetchForecast(point)
    }
  }

  getStats(): PluginStats {
    return this.status
  }

  getControls(): PluginControlSpec[] {
    const c = this.forecast?.current
    const controls: PluginControlSpec[] = [
      { type: 'toggle', id: 'radar', label: 'Radar Overlay', value: this.showRadar },
      { type: 'toggle', id: 'satellite', label: 'Satellite IR', value: this.showSatellite },
      { type: 'slider', id: 'opacity', label: 'Radar Opacity', min: 0, max: 1, step: 0.05, value: this.radarOpacity },
      { type: 'separator', id: 'sep1' },
    ]

    if (c) {
      controls.push(
        { type: 'display', id: 'temp', label: 'Temp', value: `${c.temperature.toFixed(1)}°C`, color: c.temperature > 25 ? '#ff8a4a' : c.temperature < 5 ? '#4a8aff' : '#4aff8a' },
        { type: 'display', id: 'feels', label: 'Feels Like', value: `${c.apparentTemp.toFixed(1)}°C`, color: '#ffd24a' },
        { type: 'display', id: 'wind', label: 'Wind', value: `${c.windSpeed.toFixed(0)} km/h`, color: '#4affd4' },
        { type: 'display', id: 'humidity', label: 'Humidity', value: `${c.humidity.toFixed(0)}%`, color: '#4a8aff' },
        { type: 'display', id: 'precip', label: 'Precip', value: `${c.precipitation.toFixed(1)} mm`, color: c.precipitation > 0 ? '#4a8aff' : '#6b7d92' },
      )
      const h = this.forecast?.hourly ?? []
      if (h.length > 0) {
        const next24 = h.slice(0, 24)
        const maxTemp = Math.max(...next24.map((x) => x.temp))
        const minTemp = Math.min(...next24.map((x) => x.temp))
        const totalPrecip = next24.reduce((s, x) => s + x.precip, 0)
        const maxPrecipProb = Math.max(...next24.map((x) => x.precipProb))
        controls.push(
          { type: 'separator', id: 'sep2' },
          { type: 'display', id: '24hmax', label: '24h Max', value: `${maxTemp.toFixed(1)}°C`, color: '#ff8a4a' },
          { type: 'display', id: '24hmin', label: '24h Min', value: `${minTemp.toFixed(1)}°C`, color: '#4a8aff' },
          { type: 'display', id: '24hprecip', label: '24h Rain', value: `${totalPrecip.toFixed(1)} mm`, color: '#4a8aff' },
          { type: 'display', id: '24hprob', label: 'Rain Prob', value: `${maxPrecipProb}%`, color: maxPrecipProb > 50 ? '#ff8a4a' : '#6b7d92' },
        )
      }
    } else {
      controls.push({ type: 'display', id: 'noforecast', label: 'Forecast', value: 'Place LKP pin', color: '#6b7d92' })
    }

    return controls
  }

  onControl(id: string, value?: unknown): void {
    if (id === 'radar' && typeof value === 'boolean') {
      this.setRadarVisible(value)
    } else if (id === 'satellite' && typeof value === 'boolean') {
      this.setSatelliteVisible(value)
    } else if (id === 'opacity' && typeof value === 'number') {
      this.setRadarOpacity(value)
    }
  }

  private async fetchForecast(point: { lng: number; lat: number }): Promise<void> {
    try {
      const result = await window.api.weather.forecast(point) as WeatherResponse | null
      if (result) {
        this.forecast = result
      }
    } catch (err) {
      console.warn('[weather] forecast fetch failed:', err)
    }
  }

  // ── Public API for UI panel ──

  setRadarVisible(visible: boolean): void {
    this.showRadar = visible
    if (visible) {
      this.addRadarLayer()
    } else {
      this.removeRadarLayer()
    }
  }

  setSatelliteVisible(visible: boolean): void {
    this.showSatellite = visible
    if (visible) {
      this.addSatelliteLayer()
    } else {
      this.removeSatelliteLayer()
    }
  }

  setRadarOpacity(opacity: number): void {
    this.radarOpacity = opacity
    if (this.radarLayer) this.radarLayer.alpha = opacity
  }

  getRadarData(): RadarData | null {
    return this.radarData
  }

  // ── Internal ──

  private async fetchRadarData(): Promise<RadarData> {
    // RainViewer sends duplicate CORS headers from the renderer — proxy through main
    const buf = await window.api.invoke('hal:fetch-buffer', { url: 'https://api.rainviewer.com/public/weather-maps.json', timeoutMs: 10000 }) as number[] | null
    if (!buf) throw new Error('RainViewer API returned empty')
    const text = new TextDecoder().decode(new Uint8Array(buf))
    const data = JSON.parse(text)
    return {
      host: data.host,
      radarPast: (data.radar?.past || []).map((f: { time: number; path: string }) => ({ time: f.time, path: f.path })),
      radarNowcast: (data.radar?.nowcast || []).map((f: { time: number; path: string }) => ({ time: f.time, path: f.path })),
      satellite: (data.satellite?.infrared || []).map((f: { time: number; path: string }) => ({ time: f.time, path: f.path })),
      generated: Date.now(),
    }
  }

  private async refreshRadar(): Promise<void> {
    try {
      this.radarData = await this.fetchRadarData()
      this.status = { count: this.radarData.radarPast.length, status: 'nominal' }
      // Refresh the radar layer with the latest frame
      if (this.showRadar) {
        this.removeRadarLayer()
        this.addRadarLayer()
      }
    } catch (err) {
      this.status = { ...this.status, status: 'stale' }
      console.warn('[weather] radar refresh failed:', err)
    }
  }

  private addRadarLayer(): void {
    if (!this.viewer || !this.radarData || this.radarLayer) return
    // Use the latest past frame
    const frames = this.radarData.radarPast
    if (frames.length === 0) return
    const frame = frames[frames.length - 1]
    const url = `${this.radarData.host}${frame.path}/512/{z}/{x}/{y}/4/1_1.png`

    const provider = new Cesium.UrlTemplateImageryProvider({
      url,
      maximumLevel: 12,
      credit: new Cesium.Credit('RainViewer'),
    })

    this.radarLayer = this.viewer.imageryLayers.addImageryProvider(provider)
    this.radarLayer.alpha = this.radarOpacity
    // Render above the base imagery
    this.radarLayer.brightness = 1.2
  }

  private removeRadarLayer(): void {
    if (this.radarLayer && this.viewer) {
      this.viewer.imageryLayers.remove(this.radarLayer)
      this.radarLayer = null
    }
  }

  private addSatelliteLayer(): void {
    if (!this.viewer || !this.radarData || this.satelliteLayer) return
    const frames = this.radarData.satellite
    if (frames.length === 0) return
    const frame = frames[frames.length - 1]
    const url = `${this.radarData.host}${frame.path}/512/{z}/{x}/{y}/0/0_0.png`

    const provider = new Cesium.UrlTemplateImageryProvider({
      url,
      maximumLevel: 12,
      credit: new Cesium.Credit('RainViewer Satellite'),
    })

    this.satelliteLayer = this.viewer.imageryLayers.addImageryProvider(provider)
    this.satelliteLayer.alpha = 0.5
  }

  private removeSatelliteLayer(): void {
    if (this.satelliteLayer && this.viewer) {
      this.viewer.imageryLayers.remove(this.satelliteLayer)
      this.satelliteLayer = null
    }
  }
}

export const weatherPlugin = new WeatherPlugin()
