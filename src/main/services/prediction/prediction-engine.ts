/* Prediction Engine Orchestrator — ported from OGOS.
 *
 * Coordinates ALL 7 prediction models as a unified global network:
 * 1. Ocean-Atmosphere Coupling (foundation — connects ocean SST to land weather)
 * 2. Radar Nowcast (short-term precipitation movement)
 * 3. Storm Track Prediction (tropical cyclone tracks, informed by SST)
 * 4. Climate Anomaly Detection (per-station, informed by coupling)
 * 5. Sensor Failure Prediction (network health)
 * 6. Severe Weather Alerting (fuses ALL data sources)
 * 7. Precipitation Forecasting (fuses atmospheric + radar + coupling)
 *
 * Runs all models every 4 minutes, combines results into a single
 * PredictionUpdate, and broadcasts via the PREDICTION_UPDATE IPC channel. */
import { IPC } from '@shared/ipc'
import type {
  ClimateStation,
  ClimateMeasurement,
  LiveFeature,
  Storm,
  RadarData,
  PredictionUpdate,
  PredictionAlert,
  StormTrackPrediction,
  SstAnomaly,
} from '@shared/types'
import { broadcastToWindows } from '../../windows'
import { WildfireSpreadPredictor } from './wildfire-spread-predictor'
import { OceanAtmosphereCoupler } from './ocean-atmosphere-coupler'
import { RadarNowcastPredictor } from './radar-nowcast-predictor'
import { StormTrackPredictor } from './storm-track-predictor'
import { ClimateAnomalyPredictor } from './climate-anomaly-predictor'
import { SensorFailurePredictor } from './sensor-failure-predictor'
import type { SensorHealth } from './sensor-failure-predictor'
import { SevereWeatherPredictor } from './severe-weather-predictor'

export class PredictionEngine {
  private oceanAtmosphereCoupler = new OceanAtmosphereCoupler()
  private radarNowcastPredictor = new RadarNowcastPredictor()
  private stormTrackPredictor = new StormTrackPredictor()
  private climateAnomalyPredictor = new ClimateAnomalyPredictor()
  private sensorFailurePredictor = new SensorFailurePredictor()
  private severeWeatherPredictor = new SevereWeatherPredictor()
  private wildfireSpreadPredictor = new WildfireSpreadPredictor()

  private intervalId: NodeJS.Timeout | null = null

  // Latest data from ClimateMonitor
  private stations: ClimateStation[] = []
  private measurements = new Map<string, ClimateMeasurement>()
  private fires: LiveFeature[] = []
  private storms: Storm[] = []
  private sensorHealth = new Map<string, SensorHealth>()
  private lightning: { lat: number; lon: number; timestamp: number }[] = []
  private radarData: RadarData | null = null
  private lastUpdate: PredictionUpdate | null = null

  /** Called by ClimateMonitor when new climate data is available. */
  updateClimateData(
    stations: ClimateStation[],
    measurements: Map<string, ClimateMeasurement>,
    storms: Storm[],
    sensorHealth: Map<string, SensorHealth>,
    lightning: { lat: number; lon: number; timestamp: number }[] = [],
    fires: LiveFeature[] = [],
  ): void {
    this.stations = stations
    this.measurements = measurements
    this.fires = fires
    this.storms = storms
    this.sensorHealth = sensorHealth
    this.lightning = lightning
    this.climateAnomalyPredictor.updateHistory(stations, measurements)
  }

  /** Called when radar data is fetched. */
  updateRadarData(radarData: RadarData | null): void {
    this.radarData = radarData
  }

  /** Run all prediction models and broadcast a PredictionUpdate. */
  runPredictions(): PredictionUpdate {
    console.log('[prediction/engine] Running all prediction models (unified network mode)...')

    try {

    // 1. Ocean-Atmosphere Coupling (foundation — must run first)
    const coupling = this.oceanAtmosphereCoupler.analyze(this.stations, this.measurements)
    const sstAnomalies: SstAnomaly[] = coupling.sstAnomalies
    const teleconnectionIndices: Record<string, number> = coupling.teleconnectionIndices

    // 2. Radar Nowcast
    const radarNowcast = this.radarNowcastPredictor.predict(this.radarData)
    const radarCells = radarNowcast?.cells ?? []
    console.log(`[prediction/engine] Radar nowcast: ${radarNowcast ? 'generated' : 'no data'}`)

    // 3. Storm Track Predictions
    const stormTracks: StormTrackPrediction[] = this.stormTrackPredictor.predictAll(this.storms, this.measurements)
    console.log(`[prediction/engine] Storm tracks: ${stormTracks.length} predictions`)

    // 4. Climate Anomaly Predictions
    const climateAnomalies: PredictionAlert[] = this.climateAnomalyPredictor.predict(this.stations, this.measurements)
    console.log(`[prediction/engine] Climate anomalies: ${climateAnomalies.length} detected`)

    // 5. Sensor Failure Predictions
    const sensorFailures: PredictionAlert[] = this.sensorFailurePredictor.predictAll(this.stations, this.sensorHealth)
    console.log(`[prediction/engine] Sensor failures: ${sensorFailures.length} at risk`)

    // 6. Severe Weather Alerting (fuses ALL data)
    const severeWeather: PredictionAlert[] = this.severeWeatherPredictor.predict(
      this.stations,
      this.measurements,
      this.lightning,
      this.storms,
      coupling,
    )
    console.log(`[prediction/engine] Severe weather: ${severeWeather.length} alerts`)

    // 7. Precipitation Forecast (fuses atmospheric + radar nowcast + coupling)
    const precipitation: PredictionAlert[] = this.severeWeatherPredictor.forecastPrecipitation(
      this.stations,
      this.measurements,
      coupling,
      radarCells,
    )
    console.log(`[prediction/engine] Precipitation forecast: ${precipitation.length} cells`)

    // 8. Wildfire Spread (fast fuel, 1-hour forecast)
    const wildfireSpread: PredictionAlert[] = this.wildfireSpreadPredictor.predict(
      this.fires,
      this.stations,
      this.measurements,
    )
    console.log(`[prediction/engine] Wildfire spread: ${wildfireSpread.length} forecasts`)

    // Build summary
    const allAlerts = [...severeWeather, ...wildfireSpread, ...climateAnomalies, ...sensorFailures, ...precipitation]
    const totalPredictions = allAlerts.length + stormTracks.length + sstAnomalies.length

    const highRiskCount = allAlerts.filter((a) => a.severity === 'high' || a.severity === 'critical').length
    const criticalRiskCount = allAlerts.filter((a) => a.severity === 'critical').length

    const confidenceScores = [
      ...allAlerts.map((a) => a.confidence),
      ...stormTracks.map((s) => s.confidence),
    ]
    const avgConfidence = confidenceScores.length > 0
      ? (confidenceScores.reduce((a, b) => a + b, 0) / confidenceScores.length) * 100
      : 0

    const update: PredictionUpdate = {
      severeWeather,
      stormTracks,
      sstAnomalies,
      precipitation,
      climateAnomalies,
      sensorFailures,
      teleconnectionIndices,
      summary: {
        totalPredictions,
        highRiskCount,
        criticalRiskCount,
        avgConfidence,
      },
      timestamp: Date.now(),
    }

    console.log(`[prediction/engine] Update: ${totalPredictions} predictions, ${highRiskCount} high-risk, ${criticalRiskCount} critical, avg confidence ${avgConfidence.toFixed(0)}%`)

    broadcastToWindows(IPC.PREDICTION_UPDATE, update)
    this.lastUpdate = update
    return update
  } catch (err) {
    console.error('[prediction/engine] runPredictions failed:', err)
    const fallback: PredictionUpdate = {
      severeWeather: [],
      stormTracks: [],
      sstAnomalies: [],
      precipitation: [],
      climateAnomalies: [],
      sensorFailures: [],
      teleconnectionIndices: {},
      summary: { totalPredictions: 0, highRiskCount: 0, criticalRiskCount: 0, avgConfidence: 0 },
      timestamp: Date.now(),
    }
    broadcastToWindows(IPC.PREDICTION_UPDATE, fallback)
    this.lastUpdate = fallback
    return fallback
  }
}

  /** Get the last prediction update (or null if not yet run). */
  getLastUpdate(): PredictionUpdate | null {
    return this.lastUpdate
  }

  /** Start the prediction cycle — runs after 5s delay, then every 4 minutes. */
  start(): void {
    console.log('[prediction/engine] start() — 4-minute cycle')
    setTimeout(() => this.runPredictions(), 5000)
    this.intervalId = setInterval(() => this.runPredictions(), 4 * 60 * 1000)
  }

  /** Stop the prediction cycle. */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId)
      this.intervalId = null
    }
    console.log('[prediction/engine] stop()')
  }
}

// Singleton export — matches the live-data.ts pattern
export const predictionEngine = new PredictionEngine()
