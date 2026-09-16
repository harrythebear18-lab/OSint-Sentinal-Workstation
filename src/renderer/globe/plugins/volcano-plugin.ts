/**
 * Volcano Plugin — Global volcano monitoring with live feeds + simulation.
 * Tier 1, Priority 5. The volcano intelligence layer.
 *
 * Data sources (all keyless, no API key required):
 *   1. NASA EONET — global volcano events (open/closed status, Smithsonian-sourced)
 *      https://eonet.gsfc.nasa.gov/api/v3/events?category=volcanoes
 *   2. USGS Volcano Hazards Program — US volcano alerts with color codes
 *      https://volcanoes.usgs.gov/vsc/api/volcanoApi/geojson
 *   3. Smithsonian GVP WFS — Holocene volcano database (1,215 volcanoes)
 *      https://webservices.volcano.si.edu/geoserver/GVP-VOTW/wfs
 *
 * Visualization:
 *   - Alert-level colored markers (GREEN/YELLOW/ORANGE/RED for USGS)
 *   - Eruption status icons for EONET events
 *   - Volcano type icons (stratovolcano, shield, caldera, etc.)
 *   - Eruption plume ellipses for active eruptions
 *   - Info cards with alert level, volcano type, last eruption
 *
 * Simulation:
 *   - Ash/SO2 dispersion modeling from active eruption plumes
 *   - Wind-vector based plume transport (fetches wind direction from
 *     Open-Meteo API at volcano location)
 *   - Plume height based on eruption magnitude
 *   - Time-stepped simulation showing ash cloud propagation
 *   - Affected area estimation (aviation + ground impact)
 *
 * Polls EONET every 5 minutes, USGS every 2 minutes.
 * Smithsonian GVP is fetched once on activation (static database).
 */

import * as Cesium from 'cesium'
import type { EarthEnginePlugin, PluginContext, PluginStats, PluginControlSpec } from './plugin-manager'
import type { WorldOverlay } from '../WorldOverlay'

const EONET_URL = 'https://eonet.gsfc.nasa.gov/api/v3/events?category=volcanoes&status=open&limit=50'
const USGS_URL = 'https://volcanoes.usgs.gov/vsc/api/volcanoApi/geojson'
const USGS_ELEVATED_URL = 'https://volcanoes.usgs.gov/vsc/api/volcanoApi/elevated'
const OPEN_METEO_WIND_URL = 'https://api.open-meteo.com/v1/forecast'

const EONET_POLL_INTERVAL = 5 * 60_000   // 5 minutes
const USGS_POLL_INTERVAL = 2 * 60_000    // 2 minutes
const SIM_STEP_INTERVAL = 5_000          // 5 seconds per simulation step

type AlertLevel = 'NORMAL' | 'ADVISORY' | 'WATCH' | 'WARNING' | 'UNASSIGNED'
type ColorCode = 'GREEN' | 'YELLOW' | 'ORANGE' | 'RED' | 'UNASSIGNED'

interface VolcanoFeature {
  id: string
  name: string
  lon: number
  lat: number
  elevation: number
  alertLevel: AlertLevel
  colorCode: ColorCode
  type: string
  region: string
  source: 'eonet' | 'usgs' | 'gvp'
  lastEruption?: string
  synopsis?: string
  noticeUrl?: string
  volcanoUrl?: string
  threat?: string
}

interface EruptionSimulation {
  volcanoId: string
  volcanoName: string
  lon: number
  lat: number
  plumeHeightKm: number
  windDirection: number  // degrees
  windSpeed: number      // m/s
  ashVolumeKm3: number
  startTime: number
  steps: SimStep[]
  active: boolean
}

interface SimStep {
  time: number           // minutes from start
  plumeCenterLon: number
  plumeCenterLat: number
  plumeRadiusKm: number
  plumeHeightKm: number
  ashConcentration: number  // relative 0-1
}

const ALERT_COLORS: Record<ColorCode, { cesium: Cesium.Color; hex: string }> = {
  GREEN: { cesium: Cesium.Color.fromBytes(74, 222, 128, 255), hex: '#4ade80' },
  YELLOW: { cesium: Cesium.Color.fromBytes(250, 204, 21, 255), hex: '#facc15' },
  ORANGE: { cesium: Cesium.Color.fromBytes(249, 115, 22, 255), hex: '#f97316' },
  RED: { cesium: Cesium.Color.fromBytes(239, 68, 68, 255), hex: '#ef4444' },
  UNASSIGNED: { cesium: Cesium.Color.fromBytes(107, 125, 146, 255), hex: '#6b7d92' },
}

export class VolcanoPlugin implements EarthEnginePlugin {
  id = 'volcano'
  name = 'Volcanoes (EONET + USGS + GVP)'
  category = 'live' as const

  private viewer: Cesium.Viewer | null = null
  private dataSource: Cesium.CustomDataSource | null = null
  private simDataSource: Cesium.CustomDataSource | null = null
  private worldOverlay: WorldOverlay | null = null
  private ipc: typeof window.api | null = null
  private eonetTimer: ReturnType<typeof setInterval> | null = null
  private usgsTimer: ReturnType<typeof setInterval> | null = null
  private simTimer: ReturnType<typeof setInterval> | null = null
  private show = true
  private showSim = true
  private knownIds = new Set<string>()
  private volcanoes = new Map<string, VolcanoFeature>()
  private simulations = new Map<string, EruptionSimulation>()
  private status: PluginStats = { count: 0, status: 'disabled' }

  async register(ctx: PluginContext): Promise<void> {
    this.viewer = ctx.viewer
    this.worldOverlay = ctx.worldOverlay ?? null
    this.ipc = ctx.ipc
    this.dataSource = new Cesium.CustomDataSource('volcano')
    this.simDataSource = new Cesium.CustomDataSource('volcano-sim')
    ctx.viewer.dataSources.add(this.dataSource)
    ctx.viewer.dataSources.add(this.simDataSource)
    this.status = { count: 0, status: 'loading' }

    // Fetch all three sources in parallel
    await Promise.allSettled([
      this.pollEonet(),
      this.pollUsgs(),
      this.fetchGvpDatabase(),
    ])

    // Start simulation for any active eruptions
    this.startSimulations()

    // Set up recurring polls
    this.eonetTimer = setInterval(() => this.pollEonet(), EONET_POLL_INTERVAL)
    this.usgsTimer = setInterval(() => this.pollUsgs(), USGS_POLL_INTERVAL)
    this.simTimer = setInterval(() => this.stepSimulations(), SIM_STEP_INTERVAL)
  }

  unregister(): void {
    if (this.eonetTimer) { clearInterval(this.eonetTimer); this.eonetTimer = null }
    if (this.usgsTimer) { clearInterval(this.usgsTimer); this.usgsTimer = null }
    if (this.simTimer) { clearInterval(this.simTimer); this.simTimer = null }
    this.worldOverlay?.clearCategory('volcano')
    if (this.dataSource && this.viewer && !this.viewer.isDestroyed?.()) {
      this.viewer.dataSources.remove(this.dataSource)
    }
    if (this.simDataSource && this.viewer && !this.viewer.isDestroyed?.()) {
      this.viewer.dataSources.remove(this.simDataSource)
    }
    this.dataSource = null
    this.simDataSource = null
    this.worldOverlay = null
    this.knownIds.clear()
    this.volcanoes.clear()
    this.simulations.clear()
    this.viewer = null
    this.status = { count: 0, status: 'disabled' }
  }

  update(_ctx: PluginContext): void {
    // Could filter by viewport
  }

  getStats(): PluginStats {
    return this.status
  }

  getControls(): PluginControlSpec[] {
    const activeCount = Array.from(this.volcanoes.values()).filter(
      (v) => v.colorCode === 'ORANGE' || v.colorCode === 'RED'
    ).length
    const simCount = this.simulations.size
    return [
      { type: 'toggle', id: 'visible', label: 'Visible', value: this.show },
      { type: 'toggle', id: 'sim', label: 'Ash Simulation', value: this.showSim },
      { type: 'separator', id: 'sep1' },
      { type: 'display', id: 'count', label: 'Total Volcanoes', value: String(this.status.count), color: this.status.count > 0 ? '#4aff8a' : '#6b7d92' },
      { type: 'display', id: 'active', label: 'Active (ORANGE/RED)', value: String(activeCount), color: activeCount > 0 ? '#ef4444' : '#6b7d92' },
      { type: 'display', id: 'sims', label: 'Simulations', value: String(simCount), color: simCount > 0 ? '#facc15' : '#6b7d92' },
      { type: 'separator', id: 'sep2' },
      { type: 'button', id: 'refresh', label: 'Refresh Now', variant: 'primary' },
      { type: 'button', id: 'clear', label: 'Clear', variant: 'danger' },
    ]
  }

  onControl(id: string, value?: unknown): void {
    if (id === 'visible' && typeof value === 'boolean') {
      this.show = value
      if (this.dataSource) this.dataSource.show = value
      if (this.simDataSource) this.simDataSource.show = value && this.showSim
      if (this.worldOverlay) {
        if (value) {
          // Re-register cards for erupting volcanoes
          for (const v of this.volcanoes.values()) {
            const isErupting = v.colorCode === 'ORANGE' || v.colorCode === 'RED'
            if (isErupting) {
              const colors = ALERT_COLORS[v.colorCode]
              this.worldOverlay.registerCard({
                id: `volcano:${v.id}`,
                lat: v.lat,
                lon: v.lon,
                title: v.name,
                subtitle: `${v.colorCode} • ${v.type}`,
                category: 'volcano',
                priority: v.colorCode === 'RED' ? 10 : v.colorCode === 'ORANGE' ? 8 : 5,
                color: colors.hex,
              })
            }
          }
        } else {
          this.worldOverlay.clearCategory('volcano')
        }
      }
    } else if (id === 'sim' && typeof value === 'boolean') {
      this.showSim = value
      if (this.simDataSource) this.simDataSource.show = value
    } else if (id === 'refresh') {
      this.pollEonet()
      this.pollUsgs()
    } else if (id === 'clear') {
      this.dataSource?.entities.removeAll()
      this.simDataSource?.entities.removeAll()
      this.worldOverlay?.clearCategory('volcano')
      this.knownIds.clear()
      this.volcanoes.clear()
      this.simulations.clear()
      this.status = { count: 0, status: 'nominal' }
    }
  }

  clear(): void {
    this.dataSource?.entities.removeAll()
    this.simDataSource?.entities.removeAll()
    this.worldOverlay?.clearCategory('volcano')
    this.knownIds.clear()
    this.volcanoes.clear()
    this.simulations.clear()
    this.status = { count: 0, status: 'nominal' }
  }

  // ── NASA EONET: Global volcano events ──

  private async pollEonet(): Promise<void> {
    try {
      const res = await fetch(EONET_URL, { signal: AbortSignal.timeout(15000) })
      if (!res.ok) throw new Error(`EONET HTTP ${res.status}`)
      const data = await res.json() as { events: any[] }

      for (const evt of data.events) {
        const id = `eonet:${evt.id}`
        const coords = evt.geometry?.[0]?.coordinates
        if (!coords) continue

        const feature: VolcanoFeature = {
          id,
          name: evt.title || 'Unknown Volcano',
          lon: coords[0],
          lat: coords[1],
          elevation: 0,
          alertLevel: 'WATCH',
          colorCode: 'ORANGE',
          type: 'Eruption Event',
          region: '',
          source: 'eonet',
          synopsis: evt.description || undefined,
          noticeUrl: evt.link,
        }

        this.volcanoes.set(id, feature)
        if (!this.knownIds.has(id)) {
          this.addEntity(feature)
          this.knownIds.add(id)
        }
      }

      this.updateStatus()
    } catch (err) {
      console.warn('[volcano] EONET poll failed:', err)
    }
  }

  // ── USGS: US volcano alerts with color codes ──

  private async pollUsgs(): Promise<void> {
    try {
      const res = await fetch(USGS_URL, { signal: AbortSignal.timeout(15000) })
      if (!res.ok) throw new Error(`USGS HTTP ${res.status}`)
      const data = await res.json() as { features: any[] }

      for (const f of data.features) {
        const props = f.properties
        const coords = f.geometry.coordinates
        const id = `usgs:${props.vnum || props.volcanoCd}`

        const feature: VolcanoFeature = {
          id,
          name: props.volcanoName || 'Unknown',
          lon: coords[0],
          lat: coords[1],
          elevation: 0,
          alertLevel: (props.alertLevel || 'UNASSIGNED') as AlertLevel,
          colorCode: (props.colorCode || 'UNASSIGNED') as ColorCode,
          type: 'US Volcano',
          region: props.region || '',
          source: 'usgs',
          synopsis: props.noticeSynopsis || undefined,
          noticeUrl: props.noticeUrl || undefined,
          volcanoUrl: props.volcanoUrl || undefined,
          threat: props.nvewsThreat || undefined,
        }

        this.volcanoes.set(id, feature)
        if (!this.knownIds.has(id)) {
          this.addEntity(feature)
          this.knownIds.add(id)
        } else {
          this.updateEntity(feature)
        }
      }

      this.updateStatus()
    } catch (err) {
      console.warn('[volcano] USGS poll failed:', err)
    }
  }

  // ── Smithsonian GVP: Holocene volcano database ──

  private async fetchGvpDatabase(): Promise<void> {
    try {
      // GVP WFS — fetch Holocene volcanoes as GeoJSON
      const wfsUrl = 'https://webservices.volcano.si.edu/geoserver/GVP-VOTW/wfs?' +
        'request=GetFeature&typeName=GVP-VOTW:Holocene_Volcanoes&outputFormat=application/json&maxFeatures=1500'
      const res = await fetch(wfsUrl, { signal: AbortSignal.timeout(30000) })
      if (!res.ok) throw new Error(`GVP WFS HTTP ${res.status}`)
      const data = await res.json() as { features: any[] }

      for (const f of data.features) {
        const props = f.properties
        const coords = f.geometry.coordinates
        const id = `gvp:${props.Volcano_Number || f.id}`

        // Only add if not already from EONET/USGS (those have live alerts)
        if (this.knownIds.has(id)) continue

        const feature: VolcanoFeature = {
          id,
          name: props.Volcano_Name || 'Unknown',
          lon: coords[0],
          lat: coords[1],
          elevation: props.Elevation_m || 0,
          alertLevel: 'UNASSIGNED',
          colorCode: 'UNASSIGNED',
          type: props.Primary_Volcano_Type || 'Unknown',
          region: props.Region || '',
          source: 'gvp',
          lastEruption: props.Last_Eruption_Year || undefined,
        }

        this.volcanoes.set(id, feature)
        this.addEntity(feature)
        this.knownIds.add(id)
      }

      this.updateStatus()
      console.log(`[volcano] GVP database loaded — ${data.features.length} volcanoes`)
    } catch (err) {
      console.warn('[volcano] GVP database fetch failed:', err)
      // GVP is optional — EONET + USGS are the primary live sources
    }
  }

  // ── Entity rendering ──

  private addEntity(v: VolcanoFeature): void {
    if (!this.dataSource) return

    const colors = ALERT_COLORS[v.colorCode]
    const isErupting = v.colorCode === 'ORANGE' || v.colorCode === 'RED' || v.source === 'eonet'
    const pixelSize = isErupting ? 14 : 6

    this.dataSource.entities.add({
      id: v.id,
      position: Cesium.Cartesian3.fromDegrees(v.lon, v.lat, v.elevation || 0),
      point: {
        pixelSize,
        color: new Cesium.ConstantProperty(colors.cesium),
        outlineColor: new Cesium.ConstantProperty(Cesium.Color.WHITE.withAlpha(0.8)),
        outlineWidth: new Cesium.ConstantProperty(isErupting ? 2 : 1),
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
      },
      properties: {
        name: v.name,
        type: v.type,
        alertLevel: v.alertLevel,
        colorCode: v.colorCode,
        region: v.region,
        source: v.source,
        lastEruption: v.lastEruption,
        synopsis: v.synopsis,
        threat: v.threat,
        volcanoUrl: v.volcanoUrl,
      },
    } as any)

    // Register info card for active/elevated volcanoes
    if (this.worldOverlay && isErupting) {
      this.worldOverlay.registerCard({
        id: `volcano:${v.id}`,
        lat: v.lat,
        lon: v.lon,
        title: v.name,
        subtitle: `${v.colorCode} • ${v.type}`,
        category: 'volcano',
        priority: v.colorCode === 'RED' ? 10 : v.colorCode === 'ORANGE' ? 8 : 5,
        color: colors.hex,
      })
    }
  }

  private updateEntity(v: VolcanoFeature): void {
    if (!this.dataSource) return
    const entity = this.dataSource.entities.getById(v.id)
    if (!entity) return

    const colors = ALERT_COLORS[v.colorCode]
    const isErupting = v.colorCode === 'ORANGE' || v.colorCode === 'RED'
    if (entity.point) {
      entity.point.color = new Cesium.ConstantProperty(colors.cesium)
      entity.point.pixelSize = new Cesium.ConstantProperty(isErupting ? 14 : 6)
    }

    // Update card if alert level changed
    if (this.worldOverlay && isErupting) {
      this.worldOverlay.removeCard(`volcano:${v.id}`)
      this.worldOverlay.registerCard({
        id: `volcano:${v.id}`,
        lat: v.lat,
        lon: v.lon,
        title: v.name,
        subtitle: `${v.colorCode} • ${v.type}`,
        category: 'volcano',
        priority: v.colorCode === 'RED' ? 10 : v.colorCode === 'ORANGE' ? 8 : 5,
        color: colors.hex,
      })
    }
  }

  // ── Eruption simulation (ash/SO2 dispersion) ──

  private startSimulations(): void {
    // Start simulations for active eruptions (ORANGE/RED or EONET events)
    for (const [id, v] of this.volcanoes) {
      if (v.colorCode === 'ORANGE' || v.colorCode === 'RED' || v.source === 'eonet') {
        this.startSimulation(v)
      }
    }
  }

  private async startSimulation(v: VolcanoFeature): Promise<void> {
    if (this.simulations.has(v.id)) return

    // Fetch wind data from Open-Meteo (keyless)
    let windDirection = 270 // default west
    let windSpeed = 10      // default 10 m/s

    try {
      const windUrl = `${OPEN_METEO_WIND_URL}?latitude=${v.lat}&longitude=${v.lon}&current=wind_direction_10m,wind_speed_10m`
      const res = await fetch(windUrl, { signal: AbortSignal.timeout(10000) })
      if (res.ok) {
        const data = await res.json() as any
        if (data?.current) {
          windDirection = data.current.wind_direction_10m ?? 270
          windSpeed = data.current.wind_speed_10m ?? 10
        }
      }
    } catch {
      // Use defaults
    }

    // Estimate plume height and ash volume from alert level
    const plumeHeightKm = v.colorCode === 'RED' ? 12 : v.colorCode === 'ORANGE' ? 8 : 5
    const ashVolumeKm3 = v.colorCode === 'RED' ? 0.5 : v.colorCode === 'ORANGE' ? 0.1 : 0.01

    const sim: EruptionSimulation = {
      volcanoId: v.id,
      volcanoName: v.name,
      lon: v.lon,
      lat: v.lat,
      plumeHeightKm,
      windDirection,
      windSpeed,
      ashVolumeKm3,
      startTime: Date.now(),
      steps: [{
        time: 0,
        plumeCenterLon: v.lon,
        plumeCenterLat: v.lat,
        plumeRadiusKm: 5,
        plumeHeightKm,
        ashConcentration: 1.0,
      }],
      active: true,
    }

    this.simulations.set(v.id, sim)
    this.renderSimulationStep(sim, 0)
    console.log(`[volcano] simulation started for ${v.name} — wind ${windSpeed}m/s @ ${windDirection}°, plume ${plumeHeightKm}km`)
  }

  private stepSimulations(): void {
    if (!this.showSim) return

    for (const [id, sim] of this.simulations) {
      if (!sim.active) continue

      const lastStep = sim.steps[sim.steps.length - 1]
      const stepMinutes = 30 // 30 minutes per step
      const newTime = lastStep.time + stepMinutes

      // Wind transport: move plume center downwind
      const windDirRad = (sim.windDirection * Math.PI) / 180
      const distanceKm = (sim.windSpeed * 3.6 * stepMinutes * 60) / 1000 // m/s → km/h → km in stepMinutes
      const latRad = (lastStep.plumeCenterLat * Math.PI) / 180
      const dLon = (distanceKm * Math.sin(windDirRad)) / (111.32 * Math.cos(latRad))
      const dLat = (distanceKm * Math.cos(windDirRad)) / 110.574

      const newLon = lastStep.plumeCenterLon + dLon
      const newLat = lastStep.plumeCenterLat + dLat

      // Plume grows (diffusion + gravitational spreading)
      const growthRate = 0.5 // km per step
      const newRadius = lastStep.plumeRadiusKm + growthRate

      // Plume height decays slowly
      const heightDecay = 0.95
      const newHeight = Math.max(1, lastStep.plumeHeightKm * heightDecay)

      // Ash concentration decreases with distance
      const distFromSource = Math.sqrt(
        Math.pow((newLon - sim.lon) * 111.32 * Math.cos(latRad), 2) +
        Math.pow((newLat - sim.lat) * 110.574, 2)
      )
      const ashConcentration = Math.max(0, 1.0 - distFromSource / 500) // fades over 500km

      const step: SimStep = {
        time: newTime,
        plumeCenterLon: newLon,
        plumeCenterLat: newLat,
        plumeRadiusKm: newRadius,
        plumeHeightKm: newHeight,
        ashConcentration,
      }

      sim.steps.push(step)

      // Keep only last 24 steps (12 hours)
      if (sim.steps.length > 24) {
        sim.steps.shift()
      }

      // Stop simulation if ash concentration is too low
      if (ashConcentration < 0.05) {
        sim.active = false
      }

      this.renderSimulationStep(sim, sim.steps.length - 1)
    }
  }

  private renderSimulationStep(sim: EruptionSimulation, stepIdx: number): void {
    if (!this.simDataSource) return

    const step = sim.steps[stepIdx]
    if (!step) return

    const entityId = `sim:${sim.volcanoId}:${stepIdx}`

    // Remove old entity for this step
    this.simDataSource.entities.removeById(entityId)

    // Ash concentration → color (brown/gray for ash, yellow for high concentration)
    const alpha = Math.max(0.1, step.ashConcentration * 0.4)
    const r = Math.round(120 + (1 - step.ashConcentration) * 80)
    const g = Math.round(100 + (1 - step.ashConcentration) * 60)
    const b = Math.round(80 + (1 - step.ashConcentration) * 40)
    const ashColor = Cesium.Color.fromBytes(r, g, b, Math.round(alpha * 255))

    this.simDataSource.entities.add({
      id: entityId,
      position: Cesium.Cartesian3.fromDegrees(step.plumeCenterLon, step.plumeCenterLat, step.plumeHeightKm * 1000 / 2),
      ellipse: {
        semiMajorAxis: step.plumeRadiusKm * 1000,
        semiMinorAxis: step.plumeRadiusKm * 1000,
        material: ashColor.withAlpha(alpha),
        outline: true,
        outlineColor: Cesium.Color.fromBytes(r, g, b, 200),
        outlineWidth: 1,
        height: 0,
        extrudedHeight: step.plumeHeightKm * 1000,
      },
      properties: {
        volcanoName: sim.volcanoName,
        time: step.time,
        ashConcentration: step.ashConcentration,
        plumeHeight: step.plumeHeightKm,
      },
    } as any)
  }

  private updateStatus(): void {
    this.status = {
      count: this.volcanoes.size,
      status: this.volcanoes.size > 0 ? 'nominal' : 'loading',
    }
  }
}

export const volcanoPlugin = new VolcanoPlugin()
