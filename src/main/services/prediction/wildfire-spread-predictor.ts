import type { LiveFeature, ClimateStation, ClimateMeasurement, PredictionAlert } from '@shared/types'

/**
 * Minimal wildfire spread predictor.
 * Uses a simplified Rothermel-like spread model from live fire hotspots.
 * Inputs: wind, air temperature, fuel moisture (inferred from temperature), default slope.
 * Output: 1-hour predicted spread as a PredictionAlert with radiusKm.
 */
export class WildfireSpreadPredictor {
  private haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6371
    const dLat = this.toRad(lat2 - lat1)
    const dLon = this.toRad(lon2 - lon1)
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(this.toRad(lat1)) * Math.cos(this.toRad(lat2)) * Math.sin(dLon / 2) ** 2
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
    return R * c
  }

  private toRad(deg: number): number {
    return (deg * Math.PI) / 180
  }

  private nearestMeasurement(
    lat: number,
    lon: number,
    stations: ClimateStation[],
    measurements: Map<string, ClimateMeasurement>,
  ): ClimateMeasurement | null {
    let best: ClimateMeasurement | null = null
    let bestDist = Infinity
    for (const s of stations) {
      const dist = this.haversineKm(lat, lon, s.lat, s.lon)
      if (dist > 150) continue
      const m = measurements.get(s.id)
      if (!m) continue
      if (dist < bestDist) {
        bestDist = dist
        best = m
      }
    }
    return best
  }

  predict(
    fires: LiveFeature[],
    stations: ClimateStation[],
    measurements: Map<string, ClimateMeasurement>,
  ): PredictionAlert[] {
    if (fires.length === 0) return []
    const now = Date.now()
    const alerts: PredictionAlert[] = []

    for (const f of fires) {
      if (f.type !== 'fire') continue
      const m = this.nearestMeasurement(f.position.lat, f.position.lon, stations, measurements)

      const windSpeed = m?.windSpeed ?? 5
      const airTemp = m?.airTemp ?? 25
      const pressure = m?.pressure ?? 1013

      // Fuel moisture proxy from temperature and pressure (crude)
      const moisture = Math.max(0.05, Math.min(0.95, 0.6 - (airTemp - 10) * 0.01 - (pressure - 1000) * 0.001))

      // Base rate of spread m/s for fast fuel
      const baseRos = 0.08
      const windFactor = 1 + (windSpeed / 10) * 1.5
      const tempFactor = 1 + (airTemp - 20) / 40
      const slopeFactor = 1.2
      const spreadRate = (baseRos * windFactor * tempFactor * slopeFactor) / moisture

      // 1-hour spread radius
      const radiusKm = Math.min(50, (spreadRate * 3600) / 1000)

      let severity: PredictionAlert['severity'] = 'low'
      if (radiusKm > 15) severity = 'critical'
      else if (radiusKm > 8) severity = 'high'
      else if (radiusKm > 3) severity = 'moderate'

      let confidence = 0.4
      if (m?.windSpeed != null) confidence += 0.2
      if (m?.airTemp != null) confidence += 0.2
      if (m?.pressure != null) confidence += 0.1
      confidence = Math.min(0.95, confidence)

      alerts.push({
        id: `wildfire:${f.id}`,
        type: 'wildfire',
        severity,
        lat: f.position.lat,
        lon: f.position.lon,
        radiusKm,
        title: `Wildfire spread — ${(radiusKm * 1000 / 1000).toFixed(1)} km forecast`,
        description: `1-hour spread forecast using wind ${windSpeed.toFixed(1)} m/s, temp ${airTemp.toFixed(1)}°C, fuel moisture ${(moisture * 100).toFixed(0)}%`,
        confidence,
        validUntil: now + 60 * 60 * 1000,
      })
    }

    return alerts
  }
}
