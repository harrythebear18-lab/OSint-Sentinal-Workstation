/* Shared type contracts between main process and renderer.
 * These travel over IPC — keep them serializable (no class instances, no Maps). */

/* ------------------------------------------------------------------ */
/* Basic geometry                                                       */
/* ------------------------------------------------------------------ */

export interface LngLat {
  lng: number
  lat: number
}

export interface BBox {
  west: number
  south: number
  east: number
  north: number
}

/* ------------------------------------------------------------------ */
/* Drawing / selection                                                  */
/* ------------------------------------------------------------------ */

export type DrawMode = 'none' | 'bbox' | 'polygon' | 'line' | 'point'

export interface Selection {
  type: 'bbox' | 'polygon' | 'line'
  coords: LngLat[]
}

/** Compute a BBox from a selection's coordinates. */
export function selectionToBBox(sel: Selection): BBox | null {
  if (sel.coords.length < 2) return null
  let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity
  for (const c of sel.coords) {
    if (c.lng < west) west = c.lng
    if (c.lng > east) east = c.lng
    if (c.lat < south) south = c.lat
    if (c.lat > north) north = c.lat
  }
  return { west, south, east, north }
}

/** Check if a point is within a [SW, NE] bounds pair. */
export function isWithinBounds(point: LngLat, bounds: [LngLat, LngLat]): boolean {
  const [sw, ne] = bounds
  return (
    point.lng >= sw.lng &&
    point.lng <= ne.lng &&
    point.lat >= sw.lat &&
    point.lat <= ne.lat
  )
}

/* ------------------------------------------------------------------ */
/* Scene context                                                        */
/* ------------------------------------------------------------------ */

export interface GlobeViewport {
  center: LngLat
  height: number
  heading: number
  pitch: number
  roll: number
  bbox: BBox | null
}

export interface SceneContext {
  activeLayers: string[]
  selectedFeature: unknown | null
  lkp: LngLat | null
  endPoint: LngLat | null
  bbox: BBox | null
  timeRange: { start: number; end: number } | null
  camera: {
    center: LngLat
    height: number
    heading: number
    pitch: number
    roll: number
  } | null
}

export type OfflineStrategy = 'prefer-cache' | 'cache-only' | 'online'

export interface TileRequest {
  source: string
  z: number
  x: number
  y: number
}

/* ------------------------------------------------------------------ */
/* Satellite imagery (NASA GIBS)                                       */
/* ------------------------------------------------------------------ */

export interface GIBSLayer {
  id: string
  name: string
  gibsLayer: string
  format: 'jpeg' | 'png'
  tileMatrixSet: string
  maxZoom: number
  temporalResolution: string
  description: string
  category: 'true-color' | 'false-color' | 'thermal' | 'vegetation' | 'geostationary' | 'atmosphere'
}

export interface SentinelScene {
  id: string
  tileUrl: string
  date: string
  cloudCover: number
  bounds: [LngLat, LngLat]
  isImageOverlay?: boolean
  maxZoom?: number
}

export interface SentinelRequest {
  bounds: [LngLat, LngLat]
  maxCloudCover?: number
  limit?: number
  layerId?: string
  date?: string
}

export interface SentinelResponse {
  layers: GIBSLayer[]
  scenes: SentinelScene[]
  best?: SentinelScene
}

/* ------------------------------------------------------------------ */
/* DEM                                                                  */
/* ------------------------------------------------------------------ */

export interface DemSampleRequest {
  lng: number
  lat: number
}

export interface DemSampleResponse {
  elevation: number | null
}

export interface DemProfileRequest {
  coords: LngLat[]
}

export interface DemProfilePoint {
  lng: number
  lat: number
  elevation: number | null
  distance: number
}

export interface DemProfileResponse {
  points: DemProfilePoint[]
  totalAscent: number
  totalDescent: number
  maxSlopeDeg: number
}

/* ------------------------------------------------------------------ */
/* Slope analysis                                                       */
/* ------------------------------------------------------------------ */

export type ActivityProfile = 'hiking' | 'scrambling' | 'sar'

export interface SlopeAnalysisRequest {
  bounds: [LngLat, LngLat]
  profile?: ActivityProfile
  demZoom?: number
}

export interface SlopeBand {
  id: string
  coords: LngLat[]
  slopeDeg: number
  class: 'passable' | 'steep' | 'impassable'
}

export interface SlopeAnalysisResponse {
  grid: number[][]
  bounds: [LngLat, LngLat]
  bands: SlopeBand[]
  legend: { deg: number; label: string; color: string }[]
}

/* ------------------------------------------------------------------ */
/* Anomaly analysis                                                     */
/* ------------------------------------------------------------------ */

export type AnalysisMode = 'active-sar' | 'legacy-research'

export interface AnomalyAnalysisRequest {
  bounds: [LngLat, LngLat]
  threshold?: number
  demZoom?: number
  mode?: AnalysisMode
}

export interface AnomalyZone {
  id: string
  coords: LngLat[]
  strength: number
  type: 'depression' | 'prominence'
  sizeM: number
}

export interface AnomalyAnalysisResponse {
  zones: AnomalyZone[]
  bounds: [LngLat, LngLat]
}

/* ------------------------------------------------------------------ */
/* Search zones / rest points / routing                                 */
/* ------------------------------------------------------------------ */

export interface SearchZonesRequest {
  lkp: LngLat
  radii?: number[]
  profile?: ActivityProfile
}

export interface SearchZone {
  id: string
  radius: number
  coords: LngLat[]
  probability: number
}

export interface SearchZonesResponse {
  zones: SearchZone[]
  lkp: LngLat
}

export interface RestPointsRequest {
  lkp: LngLat
  maxHours?: number
  bounds?: [LngLat, LngLat]
}

export interface RestPoint {
  id: string
  lng: number
  lat: number
  score: number
  reasons: string[]
}

export interface RestPointsResponse {
  points: RestPoint[]
}

export interface RoutePlanRequest {
  start: LngLat
  end: LngLat
  preference?: 'least-effort' | 'peak-ridge' | 'valley-contour'
  bounds?: [LngLat, LngLat]
}

export interface RoutePlanResponse {
  primary: LngLat[]
  alternatives: LngLat[][]
  distanceM: number
  ascentM: number
  descentM: number
}

export interface FallRiskRequest {
  route?: LngLat[]
  bounds?: [LngLat, LngLat]
}

export interface FallRiskResponse {
  zones: { id: string; coords: LngLat[]; risk: 'low' | 'moderate' | 'high' }[]
}

export interface RemainsCorridorRequest {
  /** Fall point — where the person likely fell. */
  fallPoint: LngLat
  /** Bounding box constraining the search area [SW, NE]. */
  bounds: [LngLat, LngLat]
  /** Rainfall in mm (0 = gravity-only dry fall). */
  rainfallMm?: number
  /** DEM zoom level (default 12). */
  demZoom?: number
}

export type DepositionZoneType = 'shelf' | 'basin' | 'snag' | 'fan' | 'confluence'

export interface DepositionZone {
  id: string
  coords: LngLat[]
  /** Priority 0–1 (higher = more likely deposition). */
  priority: number
  /** Type of deposition feature. */
  type: DepositionZoneType
  /** Reason this is a deposition zone. */
  reason: string
}

export interface CorridorPath {
  id: string
  coords: LngLat[]
  /** Primary (main gully) or secondary (branch). */
  primary: boolean
  /** Flow accumulation at terminal point. */
  accumulation: number
}

export interface ChokePoint {
  id: string
  coord: LngLat
  /** Why this is a choke point. */
  reason: string
}

export interface RemainsCorridorResponse {
  /** Downhill flow paths from the fall point. */
  paths: CorridorPath[]
  /** Deposition zones where remains are likely to come to rest. */
  depositionZones: DepositionZone[]
  /** Choke points — narrow constrictions where debris gets caught. */
  chokePoints: ChokePoint[]
  /** Terminal zone — the fan/outlet where the corridor ends. */
  terminalZone: {
    coords: LngLat[]
    areaKm2: number
  } | null
  /** Rainfall used (0 = dry gravity-only). */
  rainfallMm: number
}

/* ------------------------------------------------------------------ */
/* Runoff / hydrology                                                   */
/* ------------------------------------------------------------------ */

export interface RunoffAnalysisRequest {
  bounds: [LngLat, LngLat]
  rainfallMm?: number
}

/** A watershed divide segment separating drainage basins. */
export interface WatershedDivide {
  id: string
  coords: LngLat[]
  /** Watershed label (e.g. "Watershed A"). */
  label: string
  /** Area in km². */
  areaKm2: number
}

export interface RunoffAnalysisResponse {
  flowPaths: { id: string; coords: LngLat[]; dischargeLps: number }[]
  pools: { id: string; coords: LngLat[]; depthM: number; volumeL: number }[]
  floodZones: { id: string; coords: LngLat[]; risk: number; reason: string }[]
  /** Ridge lines separating drainage basins. */
  watershedDivides: WatershedDivide[]
  rainfallMm: number
}

/* ------------------------------------------------------------------ */
/* Canopy                                                               */
/* ------------------------------------------------------------------ */

export interface CanopyAnalysisRequest {
  bounds: [LngLat, LngLat]
  demZoom?: number
  mode?: AnalysisMode
}

export interface CanopyAnalysisResponse {
  zones: {
    id: string
    coords: LngLat[]
    type: 'dense-forest' | 'forest' | 'open-forest' | 'shrubland' | 'grassland' | 'barren' | 'water' | 'defoliation' | 'dead-trees' | 'clearing' | 'thinning' | 'healthy-forest'
    avgNdvi: number
    severity: number
  }[]
  bounds: [LngLat, LngLat]
}

/* ------------------------------------------------------------------ */
/* Behavior engine                                                      */
/* ------------------------------------------------------------------ */

export interface BehaviorEngineRequest {
  lkp: LngLat
  hours: number
  bounds?: [LngLat, LngLat]
}

export interface BehaviorEngineResponse {
  paths: LngLat[][]
  densityZones: { id: string; coords: LngLat[]; density: number }[]
}

/* ------------------------------------------------------------------ */
/* Water features (OSM Overpass)                                       */
/* ------------------------------------------------------------------ */

export interface WaterFeature {
  id: string
  type: 'stream' | 'river' | 'lake' | 'pond' | 'spring' | 'wetland' | 'reservoir'
  coords: LngLat[]
  name?: string
}

export interface WaterResponse {
  features: WaterFeature[]
  bounds: [LngLat, LngLat]
  error?: string
}

/* ------------------------------------------------------------------ */
/* Infrastructure (OSM Overpass — airports, power, substations, buoys) */
/* ------------------------------------------------------------------ */

export type InfrastructureType =
  | 'airport'
  | 'helipad'
  | 'power_plant'
  | 'substation'
  | 'generator'
  | 'transformer'
  | 'monitoring_station'
  | 'lighthouse'
  | 'navigation_buoy'
  | 'weather_station'
  | 'tower'

export interface InfrastructureFeature {
  id: string
  type: InfrastructureType
  /** OSM primary tag value (e.g. 'aerodrome', 'plant', 'substation'). */
  osmType: string
  /** Sub-classification (e.g. plant:source=gas, aerodrome:type=public). */
  subtype?: string
  /** ICAO / IATA code for airports, if tagged. */
  icao?: string
  iata?: string
  /** Power plant generator output (MW) if tagged. */
  outputMw?: number
  /** Voltage in kV for substations/transformers, if tagged. */
  voltageKv?: number
  /** Plant fuel/source (gas, coal, nuclear, hydro, wind, solar, etc.). */
  fuel?: string
  /** Operator / owner, if tagged. */
  operator?: string
  /** Polygon outline for area features (centroids are computed by the renderer). */
  coords: LngLat[]
  name?: string
}

export interface InfrastructureResponse {
  features: InfrastructureFeature[]
  bounds: [LngLat, LngLat]
  error?: string
}

/* ------------------------------------------------------------------ */
/* Roads (OSM Overpass)                                                */
/* ------------------------------------------------------------------ */

export interface RoadSegment {
  id: string
  /** OSM highway type. */
  highwayType: string
  /** Cost multiplier for this road type (0-1, lower = more preferred). */
  costMultiplier: number
  /** Coordinates of the road segment. */
  coords: LngLat[]
  name?: string
}

export interface RoadResponse {
  segments: RoadSegment[]
  bounds: [LngLat, LngLat]
}

/* ------------------------------------------------------------------ */
/* Weather (RainViewer + Open-Meteo)                                  */
/* ------------------------------------------------------------------ */

export interface RadarFrame {
  time: number
  path: string
}

export interface RadarData {
  host: string
  radarPast: RadarFrame[]
  radarNowcast: RadarFrame[]
  satellite: RadarFrame[]
  generated: number
}

export interface CurrentWeather {
  temperature: number
  apparentTemp: number
  humidity: number
  windSpeed: number
  windDir: number
  precipitation: number
  weatherCode: number
  isDay: boolean
}

export interface HourlyForecast {
  time: string
  temp: number
  precipProb: number
  precip: number
  windSpeed: number
  weatherCode: number
}

export interface WeatherResponse {
  current: CurrentWeather
  hourly: HourlyForecast[]
  location: LngLat
}

/* ------------------------------------------------------------------ */
/* Live data feeds                                                      */
/* ------------------------------------------------------------------ */

export type LiveFeatureType =
  | 'satellite'
  | 'aircraft'
  | 'vessel'
  | 'fire'
  | 'quake'
  | 'lightning'
  | 'storm'
  | 'station'
  | 'space-weather'
  | 'grid-asset'
  | 'grid-interconnect'
  | 'net-connection'
  | 'prediction'

export interface LiveFeature {
  id: string
  type: LiveFeatureType
  position: { lon: number; lat: number; height?: number }
  velocity?: { speed?: number; heading?: number; x?: number; y?: number; z?: number }
  meta: Record<string, unknown>
  freshness: number
}

export interface LiveUpdate {
  type: 'delta' | 'full'
  features?: LiveFeature[]
  added?: LiveFeature[]
  removed?: LiveFeature[]
  source: string
  timestamp: number
}

/* ------------------------------------------------------------------ */
/* AI (Ollama / CLIP / web search)                                    */
/* ------------------------------------------------------------------ */

export interface OllamaModel {
  name: string
  size: number
  digest: string
  capabilities: string[]
}

export interface AiHealthResponse {
  running: boolean
  models: OllamaModel[]
}

export interface AiChatRequest {
  prompt: string
  model?: string
  context?: string
}

export interface AiChatResponse {
  content: string
  model: string
  error?: string
}

export interface AiVisionRequest {
  prompt: string
  image: string
  model?: string
}

export interface ClipHealthResponse {
  running: boolean
  model?: string
}

export interface ClipSearchRequest {
  query: string
  bounds?: [LngLat, LngLat]
}

export interface ClipSearchResponse {
  results: { id: string; score: number; lng: number; lat: number }[]
}

export interface WebSearchRequest {
  query: string
  limit?: number
}

export interface WebSearchResult {
  title: string
  url: string
  snippet: string
}

export interface WebSearchResponse {
  results: WebSearchResult[]
}

/* ================================================================== */
/* Climate / Ocean (ported from OGOS climateTypes.ts)                  */
/* ================================================================== */

export type ClimateDataSource =
  | 'NOAA_NDBC' | 'ARGO' | 'BGC_ARGO' | 'NOAA_ERDDAP' | 'GTSPP'
  | 'TAO_PIRATA' | 'PMEL_CO2' | 'NWS_WEATHER' | 'NHC_STORM'
  | 'BLITZORTUNG_LIGHTNING' | 'NOAA_SWPC' | 'NASA_FIRMS'

export type StationType =
  | 'buoy' | 'argo_float' | 'bgc_argo_float' | 'carbon_station'
  | 'weather_station' | 'storm' | 'lightning'

export type OceanBasin =
  | 'north_pacific' | 'south_pacific' | 'north_atlantic'
  | 'south_atlantic' | 'indian' | 'arctic' | 'southern_ocean'

export type Continent =
  | 'north_america' | 'south_america' | 'europe'
  | 'africa' | 'asia' | 'oceania' | 'antarctica'

export type RegionType = 'ocean' | 'land'
export type RegionId = OceanBasin | Continent

export interface RegionClassification {
  regionId: RegionId
  regionType: RegionType
  name: string
  centerLat: number
  centerLon: number
}

export interface ClimateStation {
  id: string
  name: string
  type: StationType
  source: ClimateDataSource
  lat: number
  lon: number
  elevation?: number
  depth?: number
  country?: string
  region?: string
  owner?: string
  lastUpdate: number
  active: boolean
  invalidated?: boolean
  invalidationReason?: string
}

export interface ClimateMeasurement {
  stationId: string
  timestamp: number
  waterTemp?: number
  airTemp?: number
  windSpeed?: number
  windDir?: number
  waveHeight?: number
  wavePeriod?: number
  pressure?: number
  salinity?: number
  co2?: number
  chl?: number
  currentSpeed?: number
  currentDir?: number
  depth?: number
  oxygen?: number
  nitrate?: number
  ph?: number
  /** Argo drift trajectory — recent positions for drift trail visualization */
  trajectory?: { lat: number; lon: number; timestamp: number }[]
}

export interface ClimateStats {
  totalStations: number
  activeStations: number
  invalidatedStations: number
  byType: Record<string, number>
  bySource: Record<string, number>
}

export interface ClimateUpdate {
  stations: ClimateStation[]
  measurements: Record<string, ClimateMeasurement>
  stats: ClimateStats
  timestamp: number
}

/* ── Storms ── */

export interface StormTrackPoint {
  lat: number
  lon: number
  timestamp: number
  windSpeedKt?: number
  pressureMB?: number
  category?: string
  forecastHour?: number
}

export interface Storm {
  id: string
  name: string
  basin: string
  type: string
  classification: string
  intensity: string
  lat: number
  lon: number
  windSpeedKt?: number
  pressureMB?: number
  movementDir?: string
  movementSpeedKt?: number
  lastUpdate: number
  track: StormTrackPoint[]
  forecastTrack: StormTrackPoint[]
}

/* ── Space weather ── */

export interface SpaceWeather {
  xrayFlareClass?: string
  xrayFlareIntensity?: number
  protonFlux?: number
  electronFlux?: number
  solarWindSpeed?: number
  solarWindDensity?: number
  kpIndex?: number
  auroraForecast?: string
  timestamp: number
}

/* ── Climate integrity (ported from OGOS climateTypes.ts) ── */

export type IntegrityStatus = 'verified' | 'warning' | 'failed' | 'stale' | 'unknown'

export interface ClimateAlert {
  id: string
  timestamp: number
  type: string
  stationId: string
  stationName: string
  source: ClimateDataSource
  lat: number
  lon: number
  message: string
  severity: 'info' | 'warning' | 'critical'
  field?: string
}

export interface PipelineCheck {
  check: string
  status: IntegrityStatus
  message: string
}

export interface DataFlowHealth {
  source: ClimateDataSource
  sourceName: string
  status: IntegrityStatus
  pipelineScore: number
  lastFetchTime: number
  fetchLatencyMs: number
  avgLatencyMs: number
  payloadSizeBytes: number
  stationsExpected: number
  stationsReceived: number
  completenessPercent: number
  duplicateCount: number
  outOfOrderCount: number
  missingFieldCount: number
  totalPackets: number
  droppedPackets: number
  pipelineChecks: PipelineCheck[]
  latencyHistory: number[]
}

export interface SensorCheck {
  check: string
  status: IntegrityStatus
  message: string
  value?: string
}

export interface SensorHealth {
  stationId: string
  status: IntegrityStatus
  integrityScore: number
  lastTransmission: number
  expectedIntervalMs: number
  actualIntervalMs: number
  transmissionCount: number
  missedTransmissions: number
  transmissionRegularity: number
  fieldsExpected: string[]
  fieldsReceived: string[]
  fieldsMissing: string[]
  driftDetected: boolean
  driftDetails: string[]
  calibrationStatus: string
  consecutiveFailures: number
  uptimePercent: number
  checks: SensorCheck[]
}

export interface VerificationFlag {
  type: string
  severity: 'warning' | 'critical'
  message: string
  field?: string
}

export interface NearbyComparison {
  stationId: string
  stationName: string
  source: ClimateDataSource
  distanceKm: number
  field: string
  theirValue: number
  ourValue: number
  delta: number
  withinTolerance: boolean
}

export interface PhysicalCheck {
  field: string
  value: number
  min: number
  max: number
  passed: boolean
  message: string
}

export interface StatisticalCheck {
  status: IntegrityStatus
  zScore: number
  mean: number
  stdDev: number
  sampleSize: number
  message: string
}

export interface TemporalCheck {
  status: IntegrityStatus
  previousValue?: number
  currentValue: number
  rateOfChange: number
  maxExpectedRate: number
  message: string
}

export interface CrossSourceCheck {
  field: string
  sources: string[]
  values: number[]
  spread: number
  agreement: boolean
  message: string
}

export interface CrossVerification {
  stationId: string
  stationName: string
  source: ClimateDataSource
  lat: number
  lon: number
  status: IntegrityStatus
  verificationScore: number
  measurement?: ClimateMeasurement
  nearbyComparisons: NearbyComparison[]
  physicalPlausibility: PhysicalCheck[]
  statisticalOutlier: StatisticalCheck
  temporalConsistency: TemporalCheck
  crossSourceAgreement: CrossSourceCheck[]
  flags: VerificationFlag[]
}

export interface IntegritySummary {
  overallScore: number
  sensorLayerScore: number
  dataFlowLayerScore: number
  resultsLayerScore: number
  totalSensorsMonitored: number
  sensorsVerified: number
  sensorsWarning: number
  sensorsFailed: number
  pipelinesActive: number
  pipelinesDegraded: number
  resultsValidated: number
  resultsFlagged: number
  totalFlags: number
  criticalFlags: number
  warningFlags: number
  dataPointsVerified: number
  crossSourceMatches: number
  crossSourceMismatches: number
}

export interface IntegrityUpdate {
  sensorHealth: [string, SensorHealth][]
  dataFlowHealth: DataFlowHealth[]
  crossVerifications: CrossVerification[]
  summary: IntegritySummary
  storms: Storm[]
  lightningStrikes: unknown[]
  vessels: unknown[]
  aircraft: unknown[]
  earthquakes: unknown[]
  spaceWeather: SpaceWeather | null
  wildfires: unknown[]
  timestamp: number
}

/* ================================================================== */
/* Predictions (ported from OGOS predictionTypes.ts)                   */
/* ================================================================== */

export interface PredictionAlert {
  id: string
  type: string
  severity: 'low' | 'moderate' | 'high' | 'critical'
  lat: number
  lon: number
  radiusKm?: number
  title: string
  description: string
  confidence: number
  validUntil: number
}

export interface StormTrackPrediction {
  stormId: string
  stormName: string
  positions: StormTrackPoint[]
  confidence: number
}

export interface SstAnomaly {
  lat: number
  lon: number
  anomaly: number
  region: string
}

export interface PredictionUpdate {
  severeWeather: PredictionAlert[]
  stormTracks: StormTrackPrediction[]
  sstAnomalies: SstAnomaly[]
  precipitation: PredictionAlert[]
  climateAnomalies: PredictionAlert[]
  sensorFailures: PredictionAlert[]
  teleconnectionIndices: Record<string, number>
  summary: {
    totalPredictions: number
    highRiskCount: number
    criticalRiskCount: number
    avgConfidence: number
  }
  timestamp: number
}

/* ================================================================== */
/* Grid (ported from OGOS gridTypes.ts)                                */
/* ================================================================== */

export type GridAssetType =
  | 'power_plant' | 'substation' | 'transformer' | 'transmission_line'
  | 'renewable_farm' | 'battery_storage' | 'data_center' | 'ai_center'
  | 'edge_node'

export type EnergyType =
  | 'coal' | 'gas' | 'nuclear' | 'hydro' | 'wind' | 'solar'
  | 'geothermal' | 'battery' | 'mixed' | 'unknown'

export interface GridAsset {
  id: string
  name: string
  type: GridAssetType
  source: string
  lat: number
  lon: number
  country?: string
  region?: string
  owner?: string
  operator?: string
  capacityMw?: number
  energyType?: EnergyType
  voltageKv?: number
  lastUpdate: number
  active: boolean
  tags?: string[]
}

export interface GridInterconnect {
  id: string
  sourceAssetId: string
  targetAssetId: string
  type: 'ac_line' | 'dc_line' | 'fiber' | 'waveguide' | 'unknown'
  capacityMw?: number
  capacityTbps?: number
  latencyMs?: number
  active: boolean
  lastUpdate: number
}

export interface GridAssetMeasurement {
  assetId: string
  timestamp: number
  voltageKv?: number
  frequencyHz?: number
  loadMw?: number
  generationMw?: number
  temperatureC?: number
  carbonIntensityGco2Kwh?: number
  utilizationPercent?: number
  pue?: number
  healthScore?: number
}

export interface GridUpdate {
  assets: GridAsset[]
  measurements: GridAssetMeasurement[]
  interconnects: GridInterconnect[]
  timestamp: number
}

export interface GridAlert {
  id: string
  assetId: string
  type: string
  severity: 'low' | 'moderate' | 'high' | 'critical'
  message: string
  timestamp: number
}

/* ================================================================== */
/* Network (ported from OGOS networkTypes.ts)                          */
/* ================================================================== */

export interface GeoLocation {
  ip: string
  country: string
  countryCode: string
  city: string
  region: string
  lat: number
  lon: number
  isp: string
  org: string
  as: string
  timezone: string
}

export interface NetworkConnection {
  id: string
  protocol: 'TCP' | 'UDP'
  localAddress: string
  localPort: number
  remoteAddress: string
  remotePort: number
  state: string
  processId: number
  processName: string
  geo?: GeoLocation
  firstSeen: number
  lastSeen: number
  bytesSent?: number
  bytesReceived?: number
}

export interface NetworkStats {
  totalConnections: number
  activeConnections: number
  uniqueCountries: number
  uniqueIPs: number
  totalBytesSent: number
  totalBytesReceived: number
  topProcesses: { name: string; connections: number }[]
  topCountries: { country: string; count: number }[]
}

export interface NetworkUpdate {
  connections: NetworkConnection[]
  stats: NetworkStats
  userLocation: GeoLocation | null
  timestamp: number
}

export interface NetworkHealth {
  status: 'healthy' | 'degraded' | 'critical' | 'offline'
  connectivityScore: number
  latency: number
  packetLoss: number
  timestamp: number
}

export interface VpnStatus {
  isActive: boolean
  publicIP: string
  publicIPGeo?: GeoLocation
  vpnProvider: string | null
  dnsLeakDetected: boolean
  killSwitchActive: boolean
}

/* ================================================================== */
/* Import / Export (ported from OGOS)                                  */
/* ================================================================== */

export interface ImportedFeature {
  id: string
  name: string
  type: 'point' | 'line' | 'polygon'
  coords: LngLat[]
  description?: string
  styleColor?: string
  folder?: string
}

export interface ImportResult {
  features: ImportedFeature[]
  /** Bounding box of all features [SW, NE]. */
  bounds: [LngLat, LngLat]
  fileName: string
  featureCount: number
}

/* ================================================================== */
/* Case profiles (ported from OGOS)                                    */
/* ================================================================== */

export interface CaseMarker {
  id: string
  label: string
  coord: LngLat
  description: string
  color: string
}

export interface CaseProfile {
  id: string
  name: string
  description: string
  /** Bounding box for the analysis area [SW, NE]. */
  bounds: [LngLat, LngLat]
  /** Last Known Point (trailhead / starting location). */
  lkp: LngLat
  /** Likely destination or end point. */
  endPoint: LngLat
  /** Known markers to display on the map. */
  markers: CaseMarker[]
  /** Initial map center. */
  center: LngLat
  /** Initial zoom. */
  zoom: number
}

/* ================================================================== */
/* Trip parameters + Hiker profile (ported from OGOS)                  */
/* ================================================================== */

export type Pace = 'slow' | 'normal' | 'fast'
export type PackWeight = 'light' | 'medium' | 'heavy'
export type ExperienceLevel = 'novice' | 'experienced' | 'expert'
export type WeatherCondition = 'clear' | 'cloudy' | 'rain' | 'snow' | 'extreme'
export type TimeOfDay = 'morning' | 'midday' | 'afternoon' | 'night'
export type AgeGroup = 'young' | 'adult' | 'elderly'
export type FitnessLevel = 'unfit' | 'average' | 'fit'

export interface TripParams {
  /** Hours since last seen (0–72). Drives search zone expansion. */
  hoursSinceLastSeen: number
  /** Day number (1-based) for multi-day analysis. */
  day: number
  /** Walking pace — affects walk radius and rest point distance. */
  pace: Pace
  /** Pack weight — heavier = slower, more rest stops. */
  packWeight: PackWeight
  /** Experience — affects risk tolerance on steep terrain. */
  experience: ExperienceLevel
  /** Weather — affects shelter scoring and survival window. */
  weather: WeatherCondition
  /** Ambient temperature in °C. Drives heatstroke + dehydration risk. */
  temperatureC: number
  /** Time of day — midday sun = peak heatstroke risk. */
  timeOfDay: TimeOfDay
  /** Age group — elderly = higher heatstroke risk. */
  ageGroup: AgeGroup
  /** Fitness level — unfit = faster exhaustion, shorter range. */
  fitness: FitnessLevel
}

/** Derived constants from TripParams. */
export interface TripDerived {
  walkSpeedMps: number
  maxWalkDistanceM: number
  impassableSlopeDeg: number
  restIntervalMin: number
  shelterWeight: number
  survivalWindowHr: number
  heatstrokeRisk: number
  dehydrationRateLPerHr: number
  physioSpeedFactor: number
  shadeUrgency: number
  hoursToSevereDehydration: number
  riskLabel: 'low' | 'moderate' | 'high' | 'critical'
}

export type RoutePreference = 'least-effort' | 'shortest' | 'peak-ridge' | 'valley-contour' | 'scenic-trail'

export type PerceptionAccuracy = 'precise' | 'approximate' | 'exaggerated' | 'unreliable'
export type NavigationMethod = 'gps' | 'compass-map' | 'landmark' | 'none'
export type RiskTolerance = 'cautious' | 'moderate' | 'aggressive' | 'reckless'
export type GoalOrientation = 'transit' | 'exploration' | 'summit' | 'search' | 'lost'

export interface CalibrationAnchor {
  label: string
  point: LngLat
  hoursFromStart: number
  confidence: 'exact' | 'estimated' | 'approximate'
  isEndpoint: boolean
}

export interface HikerProfile {
  tripParams: TripParams
  perceptionAccuracy: PerceptionAccuracy
  navigationMethod: NavigationMethod
  riskTolerance: RiskTolerance
  goalOrientation: GoalOrientation
  claimedTripHours: number
  calibrationAnchors: CalibrationAnchor[]
  claimedMultiDay: boolean
  plannedDays: number
  hasCampingGear: boolean
}

export interface CalibratedHikerModel {
  actualWalkSpeedMps: number
  estimatedActualHours: number
  uncertaintyHours: number
  routePreference: RoutePreference
  effectiveSlopeThreshold: number
  disorientationRisk: number
  perceptionScale: number
  isMultiDay: boolean
  effectiveHoursPerDay: number
  totalTripHours: number
  lastKnownWaypoint?: {
    point: LngLat
    hoursFromStart: number
    maxBeyondLkpM: number
    probableBearing: number
  }
}

export interface HikerCalibrationRequest {
  profile: HikerProfile
}

export interface HikerCalibrationResponse {
  model: CalibratedHikerModel
  reachRadius: { nominalM: number; expandedM: number; contractedM: number }
  beyondLkpCone: {
    center: LngLat
    bearing: number
    angularSpreadDeg: number
    minRadiusM: number
    maxRadiusM: number
  } | null
}
