/**
 * Plugin registry — all available plugins.
 * Import this to get the full list of registered plugins.
 */

import { pluginManager } from './plugin-manager'
import { weatherPlugin } from './weather-plugin'
import { earthquakesPlugin } from './earthquakes-plugin'
import { volcanoPlugin } from './volcano-plugin'
import { acousticPlugin } from './acoustic-plugin'
import { timelapsePlugin } from './timelapse-plugin'
import { droneFootagePlugin } from './drone-footage-plugin'
import { sentinelStacPlugin } from './sentinel-stac-plugin'
import { slopeBandsPlugin } from './slope-plugin'
import { benchmarkPlugin } from './benchmark-plugin'
import { hillshadePlugin } from './hillshade-plugin'
import { bandMathPlugin } from './band-math-plugin'
import { anomalyPlugin } from './anomaly-plugin'
import { hydrologyPlugin } from './hydrology-plugin'
import { waterPlugin } from './water-plugin'
import { roadsPlugin } from './roads-plugin'
import { infrastructurePlugin } from './infrastructure-plugin'
import { routesPlugin } from './routes-plugin'
import { canopyPlugin } from './canopy-plugin'
import { behaviorEnginePlugin } from './behavior-plugin'
import { firesPlugin } from './fires-plugin'
import { aircraftPlugin } from './aircraft-plugin'
import { vesselsPlugin } from './vessels-plugin'
import { lightningPlugin } from './lightning-plugin'
import { clipPlugin } from './clip-plugin'
import { visionPlugin } from './vision-plugin'
import { webSearchPlugin } from './web-search-plugin'
import { searchZonesPlugin } from './search-zones-plugin'
import { restPointsPlugin } from './rest-points-plugin'
import { fallRiskPlugin } from './fall-risk-plugin'
import { remainsCorridorPlugin } from './remains-corridor-plugin'
import { caseProfilesPlugin } from './case-profiles-plugin'
import { exportImportPlugin } from './export-import-plugin'
import { hikerProfilePlugin } from './hiker-profile-plugin'
import { vrPlugin } from './vr-plugin'
import { climateStationsPlugin } from './climate-stations-plugin'
import { stormsPlugin } from './storms-plugin'
import { spaceWeatherPlugin } from './space-weather-plugin'
import { gridAssetsPlugin } from './grid-assets-plugin'
import { networkPlugin } from './network-plugin'
import { predictionsPlugin } from './predictions-plugin'
import { detectionPlugin } from './detection-plugin'

// Register all plugins (doesn't activate them)
pluginManager.register([
  // Terrain & DEM
  slopeBandsPlugin,
  hillshadePlugin,
  anomalyPlugin,
  hydrologyPlugin,
  acousticPlugin,
  // Imagery & Spectral
  sentinelStacPlugin,
  bandMathPlugin,
  canopyPlugin,
  // Maps & Routing
  waterPlugin,
  roadsPlugin,
  routesPlugin,
  // Mission & SAR
  behaviorEnginePlugin,
  predictionsPlugin,
  searchZonesPlugin,
  restPointsPlugin,
  fallRiskPlugin,
  remainsCorridorPlugin,
  caseProfilesPlugin,
  hikerProfilePlugin,
  // Live Feeds
  weatherPlugin,
  earthquakesPlugin,
  volcanoPlugin,
  firesPlugin,
  aircraftPlugin,
  vesselsPlugin,
  lightningPlugin,
  // Climate & Ocean
  climateStationsPlugin,
  stormsPlugin,
  spaceWeatherPlugin,
  // Infrastructure
  infrastructurePlugin,
  gridAssetsPlugin,
  networkPlugin,
  // AI & Vision
  clipPlugin,
  visionPlugin,
  webSearchPlugin,
  detectionPlugin,
  // Media & Export
  timelapsePlugin,
  droneFootagePlugin,
  exportImportPlugin,
  // System
  benchmarkPlugin,
  // VR / OpenXR
  vrPlugin,
])

export {
  pluginManager,
  weatherPlugin,
  earthquakesPlugin,
  volcanoPlugin,
  acousticPlugin,
  timelapsePlugin,
  droneFootagePlugin,
  sentinelStacPlugin,
  benchmarkPlugin,
  slopeBandsPlugin,
  hillshadePlugin,
  bandMathPlugin,
  anomalyPlugin,
  hydrologyPlugin,
  waterPlugin,
  roadsPlugin,
  infrastructurePlugin,
  routesPlugin,
  canopyPlugin,
  behaviorEnginePlugin,
  firesPlugin,
  aircraftPlugin,
  vesselsPlugin,
  lightningPlugin,
  climateStationsPlugin,
  stormsPlugin,
  spaceWeatherPlugin,
  gridAssetsPlugin,
  networkPlugin,
  predictionsPlugin,
  detectionPlugin,
  clipPlugin,
  visionPlugin,
  webSearchPlugin,
  searchZonesPlugin,
  restPointsPlugin,
  fallRiskPlugin,
  remainsCorridorPlugin,
  caseProfilesPlugin,
  exportImportPlugin,
  hikerProfilePlugin,
  vrPlugin,
}
export type { EarthEnginePlugin, PluginContext, PluginStats, PluginControlSpec } from './plugin-manager'
