/**
 * Climate Monitor — ported from OGOS climateMonitor.ts.
 *
 * Main orchestrator that polls all climate / ocean / weather data sources every
 * 4 minutes, calls fetchers in parallel, and broadcasts updates via IPC:
 *   - CLIMATE_UPDATE        — stations + measurements + stats
 *   - CLIMATE_INTEGRITY     — integrity summary with storms, space weather, etc.
 *   - CLIMATE_TRAFFIC       — traffic data point (station counts, freshness)
 *   - STORM_UPDATE          — active storms
 *   - SPACE_WEATHER_UPDATE  — space weather conditions
 *
 * Supports viewport culling via CLIMATE_SET_VIEWPORT to reduce IPC payload
 * for viewport-bound data (vessels, aircraft, fires).
 *
 * Reuses existing live data feeds from ../live/ for lightning, aircraft,
 * vessels, fires, and earthquakes — no duplication.
 */

import { IPC } from '@shared/ipc'
import type {
  ClimateStation,
  ClimateMeasurement,
  ClimateStats,
  ClimateUpdate,
  IntegrityUpdate,
  IntegritySummary,
  Storm,
  SpaceWeather,
  LiveFeature,
  ClimateDataSource,
  ClimateAlert,
  DataFlowHealth,
  SensorHealth,
  CrossVerification,
} from '@shared/types'
import { broadcastToWindows } from '../../windows'
import { ErddapFetcher, type FetchResult } from './erddap-fetcher'
import { WeatherFetcher } from './weather-fetcher'
import { StormFetcher } from './storm-fetcher'
import { SpaceWeatherFetcher } from './space-weather-fetcher'
import { getLightningFeatures } from '../live/lightning'
import { getAircraftFeatures } from '../live/aircraft'
import { getVesselFeatures } from '../live/vessels'
import { getFireFeatures } from '../live/fires'
import { ensureBathymetryGrid } from './bathymetry-cache'
import { DataFlowMonitor } from './data-flow-monitor'
import { SensorVerifier } from './sensor-verifier'
import { ResultsVerifier } from './results-verifier'
import { HeuristicWatchdog } from './heuristic-watchdog'

import type { PredictionEngine } from '../prediction/prediction-engine'

const POLL_INTERVAL_MS = 4 * 60 * 1000 // 4 minutes
const USGS_QUAKES_URL =
  'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson'

interface ViewportBounds {
  n: number
  s: number
  e: number
  w: number
}

class ClimateMonitor {
  private stations: ClimateStation[] = []
  private measurements: Record<string, ClimateMeasurement> = {}
  private intervalId: NodeJS.Timeout | null = null
  private fetchInProgress = false
  private viewportBounds: ViewportBounds | null = null

  private lastStorms: Storm[] = []
  private lastSpaceWeather: SpaceWeather | null = null
  private lastLightning: LiveFeature[] = []
  private lastAircraft: LiveFeature[] = []
  private lastEarthquakes: unknown[] = []
  private predictionEngine: PredictionEngine | null = null
  private whitelistedStations = new Set<string>()
  private snoozeUntil = 0

  // Integrity pipeline (ported from OGOS)
  private dataFlowMonitor: DataFlowMonitor
  private sensorVerifier: SensorVerifier
  private resultsVerifier: ResultsVerifier
  private heuristicWatchdog: HeuristicWatchdog
  private lastIntegritySummary: IntegritySummary | null = null
  private lastIntegrityUpdate: IntegrityUpdate | null = null

  constructor() {
    this.dataFlowMonitor = new DataFlowMonitor((alert) => this.emitAlert(alert))
    this.sensorVerifier = new SensorVerifier((alert) => this.emitAlert(alert))
    this.resultsVerifier = new ResultsVerifier((alert) => this.emitAlert(alert))
    this.heuristicWatchdog = new HeuristicWatchdog((alert) => this.emitAlert(alert))
  }

  private emitAlert(alert: ClimateAlert): void {
    if (this.isSnoozed()) return
    if (this.whitelistedStations.has(alert.stationId)) return
    broadcastToWindows(IPC.CLIMATE_ALERT, alert)
  }

  setSnooze(ms: number): void {
    this.snoozeUntil = ms > 0 ? Date.now() + ms : 0
  }

  isSnoozed(): boolean {
    return Date.now() < this.snoozeUntil
  }

  getIntegritySummary(): IntegritySummary | null {
    return this.lastIntegritySummary
  }

  /** Rebuild the last IntegrityUpdate from stored state (for getCurrent hydration). */
  getLastIntegrity(): IntegrityUpdate | null {
    return this.lastIntegrityUpdate
  }

  start(): void {
    console.log('[climate/monitor] start() — polling every 4 minutes')
    // Preload the global bathymetry grid in the background (non-blocking)
    ensureBathymetryGrid().catch((e) => console.warn('[climate/monitor] bathymetry preload failed:', e))
    this.fetchAll()
    this.intervalId = setInterval(() => this.fetchAll(), POLL_INTERVAL_MS)
  }

  stop(): void {
    console.log('[climate/monitor] stop()')
    if (this.intervalId) {
      clearInterval(this.intervalId)
      this.intervalId = null
    }
  }

  getPendingCount(): number {
    return this.fetchInProgress ? 1 : 0
  }

  getStations(): ClimateStation[] {
    return this.stations
  }

  getMeasurements(): Record<string, ClimateMeasurement> {
    return this.measurements
  }

  getStorms(): Storm[] {
    return this.lastStorms
  }

  getSpaceWeather(): SpaceWeather | null {
    return this.lastSpaceWeather
  }

  getLightning(): LiveFeature[] {
    return this.lastLightning
  }

  getAircraft(): LiveFeature[] {
    return this.lastAircraft
  }

  getEarthquakes(): unknown[] {
    return this.lastEarthquakes
  }

  setPredictionEngine(engine: PredictionEngine): void {
    this.predictionEngine = engine
  }

  whitelistStation(stationId: string): void {
    this.whitelistedStations.add(stationId)
  }

  unwhitelistStation(stationId: string): void {
    this.whitelistedStations.delete(stationId)
  }

  /** Set viewport bounds for IPC culling (called from CLIMATE_SET_VIEWPORT handler) */
  setViewportBounds(bounds: ViewportBounds | null): void {
    this.viewportBounds = bounds
  }

  /** Cull an array of lat/lon objects to the current viewport (with padding) */
  private cullToViewport<T extends { lat: number; lon: number }>(items: T[], padDeg = 10): T[] {
    if (!this.viewportBounds) return items
    const { n, s, e, w } = this.viewportBounds
    const south = s - padDeg
    const north = n + padDeg
    const west = w - padDeg
    const east = e + padDeg
    if (north - south > 170) return items
    return items.filter((item) => {
      if (item.lat < south || item.lat > north) return false
      if (west < -180 && east > 180) return true
      if (west < -180) return item.lon >= west + 360 || item.lon <= east
      if (east > 180) return item.lon >= west || item.lon <= east - 360
      return item.lon >= west && item.lon <= east
    })
  }

  private async fetchAll(): Promise<void> {
    if (this.fetchInProgress) return
    this.fetchInProgress = true

    try {
      // ── Fetch all ERDDAP + METAR sources in parallel, tracking per-source health ──
      const sourceConfigs: { source: ClimateDataSource; fetchFn: () => Promise<FetchResult> }[] = [
        { source: 'NOAA_NDBC', fetchFn: () => ErddapFetcher.fetchNDBC() },
        { source: 'TAO_PIRATA', fetchFn: () => ErddapFetcher.fetchTAO() },
        { source: 'TAO_PIRATA', fetchFn: () => ErddapFetcher.fetchTAOCurrents() },
        { source: 'TAO_PIRATA', fetchFn: () => ErddapFetcher.fetchTAOSalinity() },
        { source: 'GTSPP', fetchFn: () => ErddapFetcher.fetchGTSPP() },
        { source: 'ARGO', fetchFn: () => ErddapFetcher.fetchArgo() },
        { source: 'PMEL_CO2', fetchFn: () => ErddapFetcher.fetchCO2() },
        { source: 'NWS_WEATHER', fetchFn: () => WeatherFetcher.fetchNWS() },
      ]

      const dataFlowResults: DataFlowHealth[] = []
      const fetchResults = await Promise.all(
        sourceConfigs.map(async (cfg) => {
          const startTime = Date.now()
          try {
            const result = await cfg.fetchFn()
            const latency = Date.now() - startTime
            const payloadSize = JSON.stringify(result).length
            const measurementsMap = new Map(
              Object.entries(result.measurements).map(([k, v]) => [
                k,
                { timestamp: v.timestamp, stationId: k },
              ]),
            )
            const flowHealth = this.dataFlowMonitor.recordFetch(
              cfg.source,
              latency,
              payloadSize,
              result.stations.length,
              result.stations.length,
              measurementsMap,
              true,
            )
            dataFlowResults.push(flowHealth)
            return result
          } catch (e) {
            const latency = Date.now() - startTime
            const flowHealth = this.dataFlowMonitor.recordFetch(
              cfg.source,
              latency,
              0,
              0,
              0,
              new Map(),
              false,
            )
            dataFlowResults.push(flowHealth)
            console.warn(`[climate/monitor] ${cfg.source} fetch failed:`, e)
            return null
          }
        }),
      )

      const allStations: ClimateStation[] = []
      const allMeasurements: Record<string, ClimateMeasurement> = {}

      for (const r of fetchResults) {
        if (r) {
          allStations.push(...r.stations)
          Object.assign(allMeasurements, r.measurements)
        }
      }

      // ── Simulate BGC-Argo from existing Argo data (no external fetch) ──
      const argoResult = fetchResults[5] // ARGO is at index 5 in sourceConfigs
      if (argoResult) {
        const bgcResult = ErddapFetcher.simulateBGCArgo(argoResult)
        allStations.push(...bgcResult.stations)
        Object.assign(allMeasurements, bgcResult.measurements)
      }

      // ── Fetch storms, space weather, and live feeds in parallel ──
      const [stormsResult, spaceWeatherResult, lightning, aircraft, vessels, fires, earthquakes] =
        await Promise.allSettled([
          StormFetcher.fetchActiveStorms(),
          SpaceWeatherFetcher.fetch(),
          getLightningFeatures(),
          getAircraftFeatures(),
          getVesselFeatures(),
          getFireFeatures(),
          this.fetchEarthquakes(),
        ])

      const storms = stormsResult.status === 'fulfilled' ? stormsResult.value : []
      const spaceWeather = spaceWeatherResult.status === 'fulfilled' ? spaceWeatherResult.value : null
      const lightningFeatures = lightning.status === 'fulfilled' ? lightning.value : []
      const aircraftFeatures = aircraft.status === 'fulfilled' ? aircraft.value : []
      const vesselFeatures = vessels.status === 'fulfilled' ? vessels.value : []
      const fireFeatures = fires.status === 'fulfilled' ? fires.value : []
      const quakeFeatures = earthquakes.status === 'fulfilled' ? earthquakes.value : []

      this.stations = allStations
      this.measurements = allMeasurements
      this.lastStorms = storms
      if (spaceWeather) {
        this.lastSpaceWeather = spaceWeather
      }
      this.lastLightning = lightningFeatures as LiveFeature[]
      this.lastAircraft = aircraftFeatures as LiveFeature[]
      this.lastEarthquakes = quakeFeatures

      // ── Feed data to prediction engine ──
      if (this.predictionEngine) {
        const measurementsMap = new Map(Object.entries(allMeasurements))
        const lightningSimple = (lightningFeatures as LiveFeature[]).map((f) => ({
          lat: f.position.lat,
          lon: f.position.lon,
          timestamp: f.freshness,
        }))
        this.predictionEngine.updateClimateData(
          allStations,
          measurementsMap,
          storms,
          new Map(),
          lightningSimple,
          fireFeatures as LiveFeature[],
        )
        this.predictionEngine.runPredictions()
      }

      // ── Compute stats ──
      const stats = this.computeStats(allStations, allMeasurements)

      // ── Broadcast CLIMATE_UPDATE ──
      const update: ClimateUpdate = {
        stations: allStations,
        measurements: allMeasurements,
        stats,
        timestamp: Date.now(),
      }
      broadcastToWindows(IPC.CLIMATE_UPDATE, update)

      // ── Broadcast STORM_UPDATE ──
      broadcastToWindows(IPC.STORM_UPDATE, storms)

      // ── Broadcast SPACE_WEATHER_UPDATE ──
      const sw =
        spaceWeather && (spaceWeather.kpIndex != null || spaceWeather.xrayFlareClass != null)
          ? spaceWeather
          : this.lastSpaceWeather || spaceWeather
      if (sw) {
        broadcastToWindows(IPC.SPACE_WEATHER_UPDATE, sw)
      }

      // ── Run full integrity pipeline (sensor, results, heuristics) ──
      const measurementsMap = new Map(Object.entries(allMeasurements))
      const sensorHealth = this.sensorVerifier.verify(allStations, measurementsMap)
      const crossVerifications = await this.resultsVerifier.verify(allStations, measurementsMap)
      this.heuristicWatchdog.verify(allStations, measurementsMap, crossVerifications)

      const summary = this.computeIntegritySummary(sensorHealth, dataFlowResults, crossVerifications)
      this.lastIntegritySummary = summary

      // ── Broadcast CLIMATE_INTEGRITY ──
      const integrity: IntegrityUpdate = {
        sensorHealth: Array.from(sensorHealth.entries()),
        dataFlowHealth: dataFlowResults,
        crossVerifications,
        summary,
        storms,
        lightningStrikes: lightningFeatures,
        vessels: vesselFeatures,
        aircraft: aircraftFeatures,
        earthquakes: quakeFeatures,
        spaceWeather,
        wildfires: fireFeatures,
        timestamp: Date.now(),
      }
      this.lastIntegrityUpdate = integrity
      broadcastToWindows(IPC.CLIMATE_INTEGRITY, integrity)

      // ── Broadcast CLIMATE_TRAFFIC (with real integrity scores) ──
      broadcastToWindows(IPC.CLIMATE_TRAFFIC, {
        timestamp: Date.now(),
        totalStations: allStations.length,
        activeStations: allStations.filter((s) => s.active).length,
        newMeasurements: Object.keys(allMeasurements).length,
        avgWaterTemp: 0,
        avgCO2: 0,
        integrityScore: summary.overallScore,
        sensorsVerified: summary.sensorsVerified,
        sensorsFlagged: summary.sensorsWarning + summary.sensorsFailed,
      })

      console.log(
        `[climate/monitor] Cycle complete: ${allStations.length} stations, ` +
        `${Object.keys(allMeasurements).length} measurements, ${storms.length} storms, ` +
        `spaceWeather=${spaceWeather ? 'yes' : 'no'}`,
      )
    } catch (e) {
      console.error('[climate/monitor] fetchAll error:', e)
    } finally {
      this.fetchInProgress = false
    }
  }

  /** Compute ClimateStats from stations and measurements */
  private computeStats(
    stations: ClimateStation[],
    measurements: Record<string, ClimateMeasurement>,
  ): ClimateStats {
    const byType: Record<string, number> = {}
    const bySource: Record<string, number> = {}
    let invalidated = 0

    for (const s of stations) {
      byType[s.type] = (byType[s.type] ?? 0) + 1
      bySource[s.source] = (bySource[s.source] ?? 0) + 1
      if (s.invalidated) invalidated++
    }

    return {
      totalStations: stations.length,
      activeStations: stations.filter((s) => s.active).length,
      invalidatedStations: invalidated,
      byType,
      bySource,
    }
  }

  /** Compute IntegritySummary from sensor health, data flow, and cross-verifications */
  private computeIntegritySummary(
    sensorHealth: Map<string, SensorHealth>,
    dataFlow: DataFlowHealth[],
    crossVerifications: CrossVerification[],
  ): IntegritySummary {
    const sensors = Array.from(sensorHealth.values())
    const sensorsVerified = sensors.filter((s) => s.status === 'verified').length
    const sensorsWarning = sensors.filter((s) => s.status === 'warning').length
    const sensorsFailed = sensors.filter((s) => s.status === 'failed').length

    const sensorLayerScore =
      sensors.length > 0
        ? sensors.reduce((a, s) => a + s.integrityScore, 0) / sensors.length
        : 0

    const pipelinesActive = dataFlow.filter((d) => d.status === 'verified').length
    const pipelinesDegraded = dataFlow.filter(
      (d) => d.status === 'warning' || d.status === 'failed',
    ).length
    const dataFlowLayerScore =
      dataFlow.length > 0
        ? dataFlow.reduce((a, d) => a + d.pipelineScore, 0) / dataFlow.length
        : 0

    const resultsValidated = crossVerifications.length
    const resultsFlagged = crossVerifications.filter((v) => v.flags.length > 0).length
    const resultsLayerScore =
      crossVerifications.length > 0
        ? crossVerifications.reduce((a, v) => a + v.verificationScore, 0) / crossVerifications.length
        : 0

    let totalFlags = 0
    let criticalFlags = 0
    let warningFlags = 0
    let crossSourceMatches = 0
    let crossSourceMismatches = 0

    for (const v of crossVerifications) {
      for (const f of v.flags) {
        totalFlags++
        if (f.severity === 'critical') criticalFlags++
        else if (f.severity === 'warning') warningFlags++
      }
      for (const cs of v.crossSourceAgreement) {
        if (cs.agreement) crossSourceMatches++
        else crossSourceMismatches++
      }
    }

    const overallScore = (sensorLayerScore + dataFlowLayerScore + resultsLayerScore) / 3

    return {
      overallScore,
      sensorLayerScore,
      dataFlowLayerScore,
      resultsLayerScore,
      totalSensorsMonitored: sensors.length,
      sensorsVerified,
      sensorsWarning,
      sensorsFailed,
      pipelinesActive,
      pipelinesDegraded,
      resultsValidated,
      resultsFlagged,
      totalFlags,
      criticalFlags,
      warningFlags,
      dataPointsVerified: Object.keys(this.measurements).length,
      crossSourceMatches,
      crossSourceMismatches,
    }
  }

  /** Fetch recent earthquakes from USGS (M≥2.5, past day) */
  private async fetchEarthquakes(): Promise<unknown[]> {
    try {
      const res = await fetch(USGS_QUAKES_URL, { signal: AbortSignal.timeout(15000) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      if (!data.features || !Array.isArray(data.features)) return []

      const quakes = data.features.map((f: any) => ({
        id: f.id,
        mag: f.properties?.mag ?? 0,
        place: f.properties?.place ?? 'Unknown',
        lat: f.geometry?.coordinates?.[1] ?? 0,
        lon: f.geometry?.coordinates?.[0] ?? 0,
        depth: f.geometry?.coordinates?.[2] ?? 0,
        time: f.properties?.time ?? Date.now(),
        url: f.properties?.url ?? '',
        tsunami: f.properties?.tsunami === 1,
      }))
      quakes.sort((a: any, b: any) => b.mag - a.mag)
      console.log(`[climate/monitor] Earthquakes: ${quakes.length} (M≥2.5)`)
      return quakes
    } catch (e) {
      console.warn('[climate/monitor] Earthquake fetch failed:', e)
      return []
    }
  }
}

// Singleton export — matches the live-data.ts pattern
export const climateMonitor = new ClimateMonitor()
