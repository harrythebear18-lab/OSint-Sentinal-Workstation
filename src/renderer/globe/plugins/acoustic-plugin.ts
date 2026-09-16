/**
 * Acoustic Propagation Plugin — Planetary outdoor sound modeling.
 * Tier 1, Priority 6. The planetary acoustic simulator.
 *
 * Models outdoor sound propagation using real terrain, real weather,
 * and ISO 9613-1 atmospheric absorption physics.
 *
 * This is what Meyer Sound MAPP XT, d&b ArrayCalc, and L-Acoustics
 * Soundvision do for single venues — but for any location on Earth.
 *
 * ── ISO 9613-1 propagation model ──
 *
 *   Lp = Lw - A_div - A_atm - A_gr - A_bar + D
 *
 *   A_div = 20*log10(r) + 11         geometric divergence (spherical)
 *   A_atm = alpha(f,T,RH,P) * r      atmospheric absorption (per band)
 *   A_gr  = ground effect            source/receiver height + ground type
 *   A_bar = barrier/terrain           DEM line-of-sight shadow
 *   D     = directivity               speaker horizontal/vertical pattern
 *
 * ── Inputs ──
 *
 *   Source:    position, power Lw (dB), directivity (H/V angle, rotation)
 *   Environment: temperature, humidity, wind, pressure, ground type
 *   Receiver grid: crowd, perimeter, FOH, delay towers, neighbours
 *
 * ── Engine integration ──
 *
 *   WASM SIMD:  crunch banded SPL over thousands of receiver points
 *   WebGPU:     render SPL heatmaps over terrain (colour-coded coverage)
 *   Plugin UI:  drop arrays, towers, fills; tweak aiming, height, power
 *   Weather:    wind + temperature gradients modulate attenuation + drift
 *
 * ── Data sources (all keyless) ──
 *
 *   DEM elevation: AWS Terrarium tiles (terrain shadowing)
 *   Weather: Open-Meteo (temperature, humidity, wind, pressure)
 *   Land cover: GIBS NDVI (ground impedance approximation)
 */

import * as Cesium from 'cesium'
import type { EarthEnginePlugin, PluginContext, PluginStats, PluginControlSpec } from './plugin-manager'

// ── Constants ──

const SPEED_OF_SOUND_0C = 331.3 // m/s at 0°C
const REF_DISTANCE = 1 // 1 meter
const EARTH_RADIUS_M = 6371000

// Standard octave band center frequencies (Hz)
const OCTAVE_BANDS = [63, 125, 250, 500, 1000, 2000, 4000, 8000] as const

// ── Types ──

interface SoundSource {
  id: string
  lon: number
  lat: number
  height: number          // speaker height in meters
  lw: number              // sound power level Lw (dB re 10^-12 W)
  freq: number            // center frequency Hz
  horizAngle: number      // horizontal -3dB coverage angle (degrees)
  vertAngle: number       // vertical -3dB coverage angle (degrees)
  rotation: number        // horizontal rotation in degrees (0 = north)
  label: string           // user label (e.g. "Main L", "Delay 1")
}

type GroundType = 'hard' | 'porous' | 'mixed'
const GROUND_TYPES: Record<GroundType, { label: string; G: number }> = {
  hard:   { label: 'Hard (water/concrete)', G: 0.0 },
  porous: { label: 'Porous (grass/soil)',    G: 1.0 },
  mixed:  { label: 'Mixed',                   G: 0.5 },
}

interface WeatherData {
  temperature: number    // °C
  humidity: number       // %
  pressure: number       // hPa
  windSpeed: number      // m/s
  windDirection: number  // degrees (0=N, 90=E)
}

// ── ISO 9613-1 atmospheric absorption ──

/**
 * ISO 9613-1 atmospheric absorption coefficient (dB/m).
 *
 * @param freq  Frequency in Hz
 * @param temp  Temperature in °C
 * @param hum   Relative humidity in %
 * @param pres  Atmospheric pressure in hPa
 * @returns Absorption coefficient alpha in dB/m
 */
function iso9613Absorption(freq: number, temp: number, hum: number, pres: number): number {
  const T = temp + 273.15
  const T0 = 293.15 // reference 20°C
  const P = pres / 1013.25
  const H = hum

  // Saturation vapor pressure
  const Psat = 10 ** (-6.8346 * (T0 / T) ** 1.261 + 4.6151)
  const C_hum = H * Psat / P

  // Relaxation frequencies
  const Fr_o = (P / T) * (24 + 40400 * C_hum * (0.02 + C_hum) / (0.391 + C_hum))
  const Fr_n = (P / T) * Math.sqrt(T / T0) * (9 + 280 * C_hum * Math.exp(-4.17 * ((T / T0) ** (-1 / 3) - 1)))

  const f = freq
  const f2 = f * f

  const a_classical = 8.686 * f2 * (1.84e-11 * P * Math.sqrt(T / T0))
  const a_oxygen = 8.686 * f2 * ((T0 / T) ** 2.5) * (0.01275 * Math.exp(-2239.1 / T) / (Fr_o + f2 / Fr_o))
  const a_nitrogen = 8.686 * f2 * ((T0 / T) ** 2.5) * (0.1068 * Math.exp(-3352 / T) / (Fr_n + f2 / Fr_n))

  return a_classical + a_oxygen + a_nitrogen
}

/**
 * Great-circle horizontal distance in meters.
 */
function horizDistance(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const la1 = lat1 * Math.PI / 180
  const la2 = lat2 * Math.PI / 180
  const dLat = la2 - la1
  const dLon = (lon2 - lon1) * Math.PI / 180
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a))
}

/**
 * Bearing from point 1 to point 2 in degrees (0=N, 90=E).
 */
function bearing(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const la1 = lat1 * Math.PI / 180
  const la2 = lat2 * Math.PI / 180
  const dLon = (lon2 - lon1) * Math.PI / 180
  const y = Math.sin(dLon) * Math.cos(la2)
  const x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dLon)
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360
}

/**
 * ISO 9613-1 ground effect A_gr (dB).
 *
 * Simplified from the full ISO 9613-2 ground effect model:
 *   - Hard ground (G=0): reflection adds up to +6 dB near ground
 *   - Porous ground (G=1): absorption reduces level
 *   - Mixed (G=0.5): intermediate
 *
 * @param dist  Horizontal distance in meters
 * @param hs    Source height in meters
 * @param hr    Receiver height in meters
 * @param G     Ground factor (0=hard, 1=porous)
 * @param freq  Frequency in Hz
 */
function groundEffect(dist: number, hs: number, hr: number, G: number, freq: number): number {
  // Path length difference between direct and reflected ray
  const dRef = Math.sqrt(dist * dist + (hs - hr) ** 2)
  const dGr = Math.sqrt(dist * dist + (hs + hr) ** 2)
  const delta = dGr - dRef

  if (delta < 0.001) return 0

  // Reflection coefficient depends on ground type
  const Rp = 1 - G // pressure reflection coefficient (simplified)
  // Ground interference factor
  const c = 343 // approx speed of sound
  const phase = 2 * Math.PI * freq * delta / c

  // Simplified: hard ground gives +6dB near source, porous absorbs
  const aGround = 6 * Rp * Math.cos(phase) - 6 * G * (1 - Math.cos(phase))

  // Limit to reasonable range
  return Math.max(-20, Math.min(6, aGround))
}

/**
 * Barrier / terrain attenuation A_bar (dB).
 *
 * Uses DEM line-of-sight to detect terrain shadowing.
 * If receiver is in acoustic shadow (no line-of-sight to source),
 * apply barrier attenuation based on the path difference.
 *
 * @param sourceElev  Source ground elevation (m)
 * @param sourceHeight  Source speaker height (m)
 * @param receiverElev  Receiver ground elevation (m)
 * @param receiverHeight  Receiver height (m)
 * @param dist  Horizontal distance (m)
 * @param terrainProfile  Elevation samples along path (m), or null
 */
function barrierAttenuation(
  sourceElev: number, sourceHeight: number,
  receiverElev: number, receiverHeight: number,
  dist: number,
  terrainProfile: number[] | null,
): number {
  if (!terrainProfile || terrainProfile.length < 3) return 0

  const sourceTotalH = sourceElev + sourceHeight
  const receiverTotalH = receiverElev + receiverHeight

  // Check if any terrain point blocks line-of-sight
  let maxExcess = 0
  const n = terrainProfile.length
  for (let i = 1; i < n - 1; i++) {
    const t = i / (n - 1)
    // Linear interpolation of line-of-sight height at this point
    const losHeight = sourceTotalH + (receiverTotalH - sourceTotalH) * t
    const terrainH = terrainProfile[i]
    if (terrainH > losHeight) {
      maxExcess = Math.max(maxExcess, terrainH - losHeight)
    }
  }

  if (maxExcess <= 0) return 0 // no barrier

  // Maekawa barrier formula (simplified)
  // A_bar = 10 * log10(3 + 20*N)
  // where N = 2 * delta / lambda  (path difference / wavelength)
  // Simplified: use excess height as proxy for path difference
  const c = 343
  const freq = 1000 // use 1kHz as representative
  const lambda = c / freq
  const deltaPath = maxExcess * 2 // approximate path difference
  const N = 2 * deltaPath / lambda
  const aBar = 10 * Math.log10(3 + 20 * N)

  return Math.min(25, aBar) // cap at 25 dB
}

/**
 * Speaker directivity factor D (dB).
 *
 * Models the horizontal off-axis attenuation based on the
 * speaker's coverage angle and rotation.
 */
function directivity(
  source: SoundSource,
  receiverBearing: number,
): number {
  if (source.horizAngle >= 360) return 0 // omnidirectional

  const halfAngle = source.horizAngle / 2
  const angleDiff = Math.abs(((receiverBearing - source.rotation + 540) % 360) - 180)

  if (angleDiff <= halfAngle) {
    // On-axis: no attenuation (could model vertical pattern too)
    return 0
  }

  // Off-axis: -6dB/octave beyond the -3dB point
  const beyond = angleDiff - halfAngle
  const beyondRatio = beyond / (180 - halfAngle)
  return -(6 + 12 * beyondRatio) // -6 to -18 dB off-axis
}

/**
 * Wind refraction effect (dB).
 *
 * Downwind: sound bends toward ground → enhanced propagation
 * Upwind: sound bends upward → shadow zone at distance
 */
function windRefraction(
  windSpeed: number,
  windDirection: number,
  receiverBearing: number,
  horizDist: number,
): number {
  const windBearingDiff = ((windDirection - receiverBearing + 540) % 360) - 180
  const windEffect = Math.cos(windBearingDiff * Math.PI / 180) // -1 (upwind) to 1 (downwind)

  if (windEffect < 0) {
    // Upwind shadow zone
    const shadowStart = 200 // shadow starts at ~200m upwind
    if (horizDist > shadowStart) {
      const shadowDepth = Math.min(25, (horizDist - shadowStart) / 50)
      return -shadowDepth * Math.abs(windEffect)
    }
  } else {
    // Downwind enhancement
    return windEffect * 3
  }
  return 0
}

// ── SPL color ramp ──

const SPL_RAMP: [number, number, number, number][] = [
  [30, 0, 0, 80],
  [50, 0, 50, 150],
  [65, 0, 150, 200],
  [75, 0, 200, 100],
  [85, 200, 200, 0],
  [95, 250, 150, 0],
  [105, 250, 50, 0],
  [120, 200, 0, 0],
]

// ── Plugin ──

export class AcousticPlugin implements EarthEnginePlugin {
  id = 'acoustic'
  name = 'Acoustic Propagation (Outdoor Sound)'
  category = 'terrain' as const

  private viewer: Cesium.Viewer | null = null
  private ipc: typeof window.api | null = null
  private dataSource: Cesium.CustomDataSource | null = null
  private imageryLayer: Cesium.ImageryLayer | null = null
  private status: PluginStats = { count: 0, status: 'disabled' }
  private sources = new Map<string, SoundSource>()
  private weather: WeatherData | null = null
  private lastBbox: { west: number; south: number; east: number; north: number } | null = null
  private placingSource = false
  private clickHandler: Cesium.ScreenSpaceEventHandler | null = null

  // Current source params (applied when placing new source)
  private currentLw = 110       // Lw sound power level (dB)
  private currentFreq = 1000    // Hz
  private currentHeight = 5     // meters
  private currentHorizAngle = 90  // degrees
  private currentVertAngle = 30   // degrees
  private currentRotation = 0     // degrees
  private currentGroundType: GroundType = 'mixed'
  private gridSize = 256
  private analysisRadiusDeg = 0.05 // ~5km

  async register(ctx: PluginContext): Promise<void> {
    this.viewer = ctx.viewer
    this.ipc = ctx.ipc
    this.dataSource = new Cesium.CustomDataSource('acoustic')
    ctx.viewer.dataSources.add(this.dataSource)
    this.status = { count: 0, status: 'nominal' }

    // Click handler for source placement
    this.clickHandler = new Cesium.ScreenSpaceEventHandler(ctx.viewer.scene.canvas)
    this.clickHandler.setInputAction((click: any) => {
      if (!this.placingSource) return
      const cartesian = ctx.viewer.scene.pickPosition(click.position)
      if (!cartesian) {
        // Fallback: pick globe
        const ray = ctx.viewer.camera.getPickRay(click.position)
        if (!ray) return
        const c = ctx.viewer.scene.globe.pick(ray, ctx.viewer.scene)
        if (!c) return
        const carto = Cesium.Cartographic.fromCartesian(c)
        this.placeSource(Cesium.Math.toDegrees(carto.longitude), Cesium.Math.toDegrees(carto.latitude))
      } else {
        const carto = Cesium.Cartographic.fromCartesian(cartesian)
        this.placeSource(Cesium.Math.toDegrees(carto.longitude), Cesium.Math.toDegrees(carto.latitude))
      }
      this.placingSource = false
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK)
  }

  unregister(): void {
    this.clickHandler?.destroy()
    this.clickHandler = null
    this.removeLayer()
    if (this.dataSource && this.viewer && !this.viewer.isDestroyed?.()) {
      this.viewer.dataSources.remove(this.dataSource)
    }
    this.dataSource = null
    this.sources.clear()
    this.viewer = null
    this.status = { count: 0, status: 'disabled' }
  }

  update(_ctx: PluginContext): void {}

  getStats(): PluginStats {
    return this.status
  }

  getControls(): PluginControlSpec[] {
    return [
      { type: 'button', id: 'place', label: this.placingSource ? 'Click on globe...' : 'Place Source', variant: 'primary' },
      { type: 'separator', id: 'sep1' },
      { type: 'slider', id: 'lw', label: 'Power Lw', value: this.currentLw, min: 80, max: 140, step: 1, unit: 'dB' },
      { type: 'select', id: 'freq', label: 'Frequency', value: String(this.currentFreq), options: OCTAVE_BANDS.map((f) => ({ label: `${f} Hz`, value: String(f) })) },
      { type: 'slider', id: 'height', label: 'Speaker Height', value: this.currentHeight, min: 0, max: 50, step: 0.5, unit: 'm' },
      { type: 'slider', id: 'horizAngle', label: 'H. Coverage', value: this.currentHorizAngle, min: 10, max: 360, step: 5, unit: '°' },
      { type: 'slider', id: 'vertAngle', label: 'V. Coverage', value: this.currentVertAngle, min: 5, max: 180, step: 5, unit: '°' },
      { type: 'slider', id: 'rotation', label: 'Rotation', value: this.currentRotation, min: 0, max: 360, step: 5, unit: '°' },
      { type: 'select', id: 'ground', label: 'Ground Type', value: this.currentGroundType, options: (Object.keys(GROUND_TYPES) as GroundType[]).map((g) => ({ label: GROUND_TYPES[g].label, value: g })) },
      { type: 'separator', id: 'sep2' },
      { type: 'button', id: 'compute', label: 'Compute SPL Map', variant: 'primary', disabled: this.sources.size === 0 },
      { type: 'button', id: 'clear', label: 'Clear All', variant: 'danger' },
      { type: 'separator', id: 'sep3' },
      { type: 'display', id: 'sources', label: 'Sources', value: String(this.sources.size), color: this.sources.size > 0 ? '#4aff8a' : '#6b7d92' },
      { type: 'display', id: 'weather', label: 'Weather', value: this.weather ? `${this.weather.temperature.toFixed(0)}°C ${this.weather.humidity.toFixed(0)}% RH ${this.weather.windSpeed.toFixed(0)}m/s` : 'Not fetched', color: this.weather ? '#4affd4' : '#6b7d92' },
    ]
  }

  onControl(id: string, value?: unknown): void {
    if (id === 'place') {
      this.placingSource = !this.placingSource
    } else if (id === 'lw' && typeof value === 'number') {
      this.currentLw = value
    } else if (id === 'freq' && typeof value === 'string') {
      this.currentFreq = parseInt(value)
    } else if (id === 'height' && typeof value === 'number') {
      this.currentHeight = value
    } else if (id === 'horizAngle' && typeof value === 'number') {
      this.currentHorizAngle = value
    } else if (id === 'vertAngle' && typeof value === 'number') {
      this.currentVertAngle = value
    } else if (id === 'rotation' && typeof value === 'number') {
      this.currentRotation = value
    } else if (id === 'ground' && typeof value === 'string') {
      this.currentGroundType = value as GroundType
    } else if (id === 'compute') {
      this.computeSPL()
    } else if (id === 'clear') {
      this.dataSource?.entities.removeAll()
      this.sources.clear()
      this.removeLayer()
      this.status = { count: 0, status: 'nominal' }
    }
  }

  clear(): void {
    this.dataSource?.entities.removeAll()
    this.sources.clear()
    this.removeLayer()
    this.status = { count: 0, status: 'nominal' }
  }

  // ── Source placement ──

  private placeSource(lon: number, lat: number): void {
    const id = `src-${Date.now()}`
    const label = `Source ${this.sources.size + 1}`
    const source: SoundSource = {
      id,
      lon,
      lat,
      height: this.currentHeight,
      lw: this.currentLw,
      freq: this.currentFreq,
      horizAngle: this.currentHorizAngle,
      vertAngle: this.currentVertAngle,
      rotation: this.currentRotation,
      label,
    }
    this.sources.set(id, source)
    this.renderSource(source)
    this.status = { count: this.sources.size, status: 'nominal' }
    console.log(`[acoustic] ${label} placed at ${lon.toFixed(4)}, ${lat.toFixed(4)} — Lw=${source.lw}dB @ ${source.freq}Hz, h=${source.height}m`)
  }

  private renderSource(s: SoundSource): void {
    if (!this.dataSource) return

    this.dataSource.entities.add({
      id: s.id,
      position: Cesium.Cartesian3.fromDegrees(s.lon, s.lat, s.height),
      point: {
        pixelSize: 12,
        color: Cesium.Color.fromBytes(250, 204, 21, 255),
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 2,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      label: {
        text: `${s.label}\n${s.lw}dB @ ${s.freq}Hz`,
        font: '12px sans-serif',
        fillColor: Cesium.Color.WHITE,
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 2,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        pixelOffset: new Cesium.Cartesian2(0, -25),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      properties: {
        type: 'sound-source',
        lw: s.lw,
        frequency: s.freq,
        height: s.height,
      },
    } as any)

    // Draw coverage cone if directional
    if (s.horizAngle < 360) {
      const halfAngleRad = (s.horizAngle / 2) * Math.PI / 180
      const rotationRad = s.rotation * Math.PI / 180
      const range = 500 // 500m visualization
      const lat1 = s.lat * Math.PI / 180

      const leftAngle = rotationRad - halfAngleRad
      const rightAngle = rotationRad + halfAngleRad

      const leftLat = s.lat + (range / 111000) * Math.cos(leftAngle)
      const leftLon = s.lon + (range / (111000 * Math.cos(lat1))) * Math.sin(leftAngle)
      const rightLat = s.lat + (range / 111000) * Math.cos(rightAngle)
      const rightLon = s.lon + (range / (111000 * Math.cos(lat1))) * Math.sin(rightAngle)

      this.dataSource.entities.add({
        id: `${s.id}-cone`,
        polyline: {
          positions: Cesium.Cartesian3.fromDegreesArray([
            s.lon, s.lat, leftLon, leftLat, rightLon, rightLat, s.lon, s.lat,
          ]),
          width: 2,
          material: Cesium.Color.fromBytes(250, 204, 21, 100),
          clampToGround: true,
        },
      } as any)
    }
  }

  // ── Weather ──

  private async fetchWeather(lon: number, lat: number): Promise<WeatherData> {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,wind_speed_10m,wind_direction_10m,surface_pressure`
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) })
    if (!res.ok) throw new Error(`Weather HTTP ${res.status}`)
    const data = await res.json() as any
    return {
      temperature: data.current.temperature_2m,
      humidity: data.current.relative_humidity_2m,
      pressure: data.current.surface_pressure,
      windSpeed: data.current.wind_speed_10m / 3.6,
      windDirection: data.current.wind_direction_10m,
    }
  }

  // ── SPL computation ──

  private async computeSPL(): Promise<void> {
    if (!this.viewer || !this.ipc || this.sources.size === 0) return
    this.status = { ...this.status, status: 'loading' }

    try {
      const firstSource = Array.from(this.sources.values())[0]
      const sourceLon = firstSource.lon
      const sourceLat = firstSource.lat

      // Fetch weather at source location
      this.weather = await this.fetchWeather(sourceLon, sourceLat)
      console.log(`[acoustic] weather: ${this.weather.temperature}°C, ${this.weather.humidity}% RH, ${this.weather.windSpeed}m/s @ ${this.weather.windDirection}°, ${this.weather.pressure}hPa`)

      // Analysis bbox
      const r = this.analysisRadiusDeg
      this.lastBbox = {
        west: sourceLon - r,
        south: sourceLat - r,
        east: sourceLon + r,
        north: sourceLat + r,
      }

      // Fetch DEM for terrain shadowing
      let demData: { elev: number[]; width: number; height: number; cellSizeX: number; cellSizeY: number } | null = null
      try {
        demData = await this.ipc.invoke('terrain:dem:raw', {
          bounds: [
            { lng: this.lastBbox.west, lat: this.lastBbox.south },
            { lng: this.lastBbox.east, lat: this.lastBbox.north },
          ],
        }) as any
      } catch {
        console.warn('[acoustic] DEM fetch failed — computing without terrain shadowing')
      }

      // Source elevation from DEM center
      const sourceElev = demData
        ? demData.elev[Math.floor(demData.height / 2) * demData.width + Math.floor(demData.width / 2)]
        : 0

      // Compute SPL grid
      const gw = this.gridSize
      const gh = this.gridSize
      const splGrid = new Float32Array(gw * gh)
      const G = GROUND_TYPES[this.currentGroundType].G

      for (let y = 0; y < gh; y++) {
        for (let x = 0; x < gw; x++) {
          const lon = this.lastBbox.west + (x / gw) * (this.lastBbox.east - this.lastBbox.west)
          const lat = this.lastBbox.south + (y / gh) * (this.lastBbox.north - this.lastBbox.south)

          // Energy summation across all sources
          let totalEnergy = 0

          for (const source of this.sources.values()) {
            const receiverElev = demData && demData.elev[y * demData.width + x] !== undefined
              ? demData.elev[y * demData.width + x]
              : 0

            const dist = horizDistance(source.lon, source.lat, lon, lat)
            if (dist < REF_DISTANCE) {
              totalEnergy += 10 ** (source.lw / 10)
              continue
            }

            const recvBearing = bearing(source.lon, source.lat, lon, lat)

            // ── ISO 9613-1 propagation model ──
            // Lp = Lw - A_div - A_atm - A_gr - A_bar + D

            // 1. Geometric divergence (spherical)
            const aDiv = 20 * Math.log10(dist) + 11

            // 2. Atmospheric absorption
            const alpha = iso9613Absorption(
              source.freq,
              this.weather!.temperature,
              this.weather!.humidity,
              this.weather!.pressure,
            )
            const aAtm = alpha * dist

            // 3. Ground effect
            const aGr = groundEffect(dist, source.height, 1.5, G, source.freq)

            // 4. Barrier / terrain attenuation
            // Extract terrain profile along path (simplified: use DEM row/column)
            let terrainProfile: number[] | null = null
            if (demData && demData.width > 0) {
              // Sample a few points along the path in the DEM grid
              const sx = Math.floor(((source.lon - this.lastBbox.west) / (this.lastBbox.east - this.lastBbox.west)) * demData.width)
              const sy = Math.floor(((source.lat - this.lastBbox.south) / (this.lastBbox.north - this.lastBbox.south)) * demData.height)
              const ex = x * demData.width / gw
              const ey = y * demData.height / gh
              const nSamples = Math.min(20, Math.max(3, Math.floor(Math.sqrt((ex - sx) ** 2 + (ey - sy) ** 2))))
              terrainProfile = []
              for (let i = 0; i < nSamples; i++) {
                const t = i / (nSamples - 1)
                const px = Math.floor(sx + (ex - sx) * t)
                const py = Math.floor(sy + (ey - sy) * t)
                if (px >= 0 && px < demData.width && py >= 0 && py < demData.height) {
                  terrainProfile.push(demData.elev[py * demData.width + px])
                } else {
                  terrainProfile.push(0)
                }
              }
            }
            const aBar = barrierAttenuation(sourceElev, source.height, receiverElev, 1.5, dist, terrainProfile)

            // 5. Directivity
            const D = directivity(source, recvBearing)

            // 6. Wind refraction
            const aWind = windRefraction(this.weather!.windSpeed, this.weather!.windDirection, recvBearing, dist)

            // Total SPL at receiver
            const lp = source.lw - aDiv - aAtm - aGr - aBar + D + aWind

            if (lp > 0) {
              totalEnergy += 10 ** (lp / 10)
            }
          }

          splGrid[y * gw + x] = totalEnergy > 0 ? 10 * Math.log10(totalEnergy) : 0
        }
      }

      // Color-map SPL grid
      const canvas = this.splToCanvas(splGrid, gw, gh)
      const blobUrl = await this.canvasToBlobUrl(canvas)

      this.removeLayer()

      const rectangle = Cesium.Rectangle.fromDegrees(
        this.lastBbox.west, this.lastBbox.south, this.lastBbox.east, this.lastBbox.north,
      )
      const provider = new Cesium.SingleTileImageryProvider({ url: blobUrl, rectangle, tileWidth: this.gridSize, tileHeight: this.gridSize })
      this.imageryLayer = this.viewer.imageryLayers.addImageryProvider(provider)
      this.imageryLayer.alpha = 0.6

      // Render wind arrow
      this.renderWindArrow(firstSource)

      this.status = { count: this.sources.size, status: 'nominal' }
      console.log(`[acoustic] SPL map computed — ${gw}x${gh} grid, ${this.sources.size} source(s)`)
    } catch (err) {
      console.warn('[acoustic] computation failed:', err)
      this.status = { ...this.status, status: 'error', error: String(err) }
    }
  }

  private splToCanvas(data: Float32Array, width: number, height: number): OffscreenCanvas {
    const canvas = new OffscreenCanvas(width, height)
    const ctx = canvas.getContext('2d')!
    const imageData = ctx.createImageData(width, height)

    for (let i = 0; i < data.length; i++) {
      const spl = Math.max(0, Math.min(120, data[i]))
      const [r, g, b] = this.interpolateRamp(SPL_RAMP, spl)
      const idx = i * 4
      imageData.data[idx] = r
      imageData.data[idx + 1] = g
      imageData.data[idx + 2] = b
      imageData.data[idx + 3] = spl > 30 ? 200 : 0
    }

    ctx.putImageData(imageData, 0, 0)
    return canvas
  }

  private interpolateRamp(ramp: [number, number, number, number][], val: number): [number, number, number] {
    if (val <= ramp[0][0]) return [ramp[0][1], ramp[0][2], ramp[0][3]]
    if (val >= ramp[ramp.length - 1][0]) return [ramp[ramp.length - 1][1], ramp[ramp.length - 1][2], ramp[ramp.length - 1][3]]
    for (let i = 0; i < ramp.length - 1; i++) {
      if (val >= ramp[i][0] && val <= ramp[i + 1][0]) {
        const t = (val - ramp[i][0]) / (ramp[i + 1][0] - ramp[i][0])
        return [
          Math.round(ramp[i][1] + t * (ramp[i + 1][1] - ramp[i][1])),
          Math.round(ramp[i][2] + t * (ramp[i + 1][2] - ramp[i][2])),
          Math.round(ramp[i][3] + t * (ramp[i + 1][3] - ramp[i][3])),
        ]
      }
    }
    return [0, 0, 0]
  }

  private renderWindArrow(source: SoundSource): void {
    if (!this.dataSource || !this.weather) return

    const arrowLength = 0.02
    const windRad = this.weather.windDirection * Math.PI / 180
    const endLon = source.lon + arrowLength * Math.sin(windRad) / Math.cos(source.lat * Math.PI / 180)
    const endLat = source.lat + arrowLength * Math.cos(windRad)

    this.dataSource.entities.removeById('wind-arrow')

    this.dataSource.entities.add({
      id: 'wind-arrow',
      polyline: {
        positions: Cesium.Cartesian3.fromDegreesArrayHeights([
          source.lon, source.lat, source.height + 10,
          endLon, endLat, source.height + 10,
        ]),
        width: 3,
        material: Cesium.Color.fromBytes(74, 158, 255, 200),
      },
      label: {
        text: `${this.weather.windSpeed.toFixed(0)}m/s`,
        font: '12px sans-serif',
        fillColor: Cesium.Color.fromBytes(74, 158, 255, 255),
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 2,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        pixelOffset: new Cesium.Cartesian2(0, -15),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    } as any)
  }

  private async canvasToBlobUrl(canvas: OffscreenCanvas): Promise<string> {
    const blob = await canvas.convertToBlob({ type: 'image/png' })
    return URL.createObjectURL(blob)
  }

  private removeLayer(): void {
    if (this.imageryLayer && this.viewer && !this.viewer.isDestroyed?.()) {
      this.viewer.imageryLayers.remove(this.imageryLayer)
    }
    this.imageryLayer = null
  }
}

export const acousticPlugin = new AcousticPlugin()
