export const IPC = {
  // App / scene
  APP_HELLO: 'app:hello',
  GLOBE_VIEWPORT: 'globe:viewport',
  GLOBE_SET_STACK: 'globe:set-stack',
  SCENE_CONTEXT_CHANGED: 'scene:context-changed',
  GET_SCENE_CONTEXT: 'scene:get-context',
  SET_SCENE_CONTEXT: 'scene:set-context',

  // Tile / offline
  TILE_REQUEST: 'tile:request',
  GET_OFFLINE_STRATEGY: 'offline:get-strategy',
  SET_OFFLINE_STRATEGY: 'offline:set-strategy',

  // Terrain / SAR analysis (ported from OGOS)
  DEM_SAMPLE: 'terrain:dem:sample',
  DEM_PROFILE: 'terrain:dem:profile',
  DEM_RAW: 'terrain:dem:raw',
  SLOPE_ANALYSIS: 'terrain:slope:analysis',
  ANOMALY_ANALYSIS: 'terrain:anomaly:analysis',
  SEARCH_ZONES: 'terrain:search:zones',
  REST_POINTS: 'terrain:rest:points',
  RUNOFF_ANALYSIS: 'terrain:runoff:analysis',
  ROUTE_PLAN: 'terrain:route:plan',
  FALL_RISK: 'terrain:fall-risk',
  REMAINS_CORRIDOR: 'terrain:remains-corridor',
  CANOPY_ANALYSIS: 'terrain:canopy:analysis',
  BEHAVIOR_ENGINE: 'terrain:behavior:engine',
  WATER_FETCH: 'terrain:water:fetch',
  ROAD_FETCH: 'terrain:road:fetch',
  INFRA_FETCH: 'infra:fetch',

  // Satellite imagery (GIBS)
  SENTINEL_SEARCH: 'imagery:sentinel:search',
  SENTINEL_LAYERS: 'imagery:sentinel:layers',

  // Satellite TLE data (for renderer-side SGP4 propagation)
  SAT_TLE_GET: 'sat:tle:get',

  // Weather
  WEATHER_RADAR: 'weather:radar',
  WEATHER_FORECAST: 'weather:forecast',
  WEATHER_RAINFALL: 'weather:rainfall',

  // Live data feeds (pushed from main to renderer)
  LIVE_UPDATE: 'live:update',
  CLIMATE_UPDATE: 'climate:update',
  CLIMATE_GET_CURRENT: 'climate:get-current',
  AIRCRAFT_UPDATE: 'aircraft:update',
  EARTHQUAKE_UPDATE: 'earthquake:update',
  FIRE_UPDATE: 'fire:update',
  VESSEL_UPDATE: 'vessel:update',
  LIGHTNING_UPDATE: 'lightning:update',

  // Climate / Ocean (pushed from main to renderer)
  CLIMATE_INTEGRITY: 'climate:integrity',
  CLIMATE_INTEGRITY_GET_CURRENT: 'climate:integrity:get-current',
  CLIMATE_ALERT: 'climate:alert',
  CLIMATE_TRAFFIC: 'climate:traffic',
  CLIMATE_SET_VIEWPORT: 'climate:set-viewport',
  CLIMATE_WHITELIST: 'climate:whitelist',
  CLIMATE_UNWHITELIST: 'climate:unwhitelist',
  CLIMATE_SNOOZE: 'climate:snooze',
  CLIMATE_GET_SNOOZE: 'climate:get-snooze',

  // Storms (pushed)
  STORM_UPDATE: 'storm:update',
  STORM_TRACK_UPDATE: 'storm:track:update',

  // Space weather (pushed)
  SPACE_WEATHER_UPDATE: 'space-weather:update',

  // Predictions (pushed)
  PREDICTION_UPDATE: 'prediction:update',
  PREDICTION_GET_CURRENT: 'prediction:get-current',

  // Aircraft weather alerts (pushed)
  AIRCRAFT_WEATHER_ALERTS: 'aircraft:weather-alerts',
  AIRCRAFT_METADATA: 'aircraft:metadata',
  AIRCRAFT_TRACK: 'aircraft:track',

  // Grid (pushed + invoke)
  GRID_UPDATE: 'grid:update',
  GRID_INTEGRITY: 'grid:integrity',
  GRID_ALERT: 'grid:alert',
  GRID_TRAFFIC: 'grid:traffic',
  GRID_SETTINGS: 'grid:settings',
  GRID_WHITELIST: 'grid:whitelist',
  GRID_UNWHITELIST: 'grid:unwhitelist',
  GRID_GET_WHITELIST: 'grid:get-whitelist',
  GRID_SNOOZE: 'grid:snooze',
  GRID_GET_SNOOZE: 'grid:get-snooze',
  GRID_GET_SETTINGS: 'grid:get-settings',
  GRID_UPDATE_SETTINGS: 'grid:update-settings',
  GRID_SET_CROSS_DOMAIN: 'grid:set-cross-domain',
  GRID_GET_CROSS_DOMAIN: 'grid:get-cross-domain',

  // Network (pushed + invoke)
  NET_UPDATE: 'net:update',
  NET_TRAFFIC: 'net:traffic',
  NET_ALERT: 'net:alert',
  NET_HEALTH: 'net:health',
  NET_OUTAGE: 'net:outage',
  NET_VPN: 'net:vpn',
  NET_USER_LOCATION: 'net:userLocation',
  NET_VPN_REFRESH: 'net:vpn:refresh',
  NET_GEOIP_LOOKUP: 'net:geoip:lookup',
  NET_SPEEDTEST_RUN: 'net:speedtest:run',
  NET_DNSTEST_RUN: 'net:dnstest:run',
  SPEEDTEST_PROGRESS: 'speedtest:progress',

  // AI
  AI_CHAT: 'ai:chat',
  AI_CHAT_STREAM: 'ai:chat:stream',
  AI_VISION: 'ai:vision',
  AI_HEALTH: 'ai:health',
  AI_CLIP_HEALTH: 'ai:clip:health',
  AI_CLIP_EMBED_TEXT: 'ai:clip:embed-text',
  AI_CLIP_EMBED_IMAGE: 'ai:clip:embed-image',
  AI_CLIP_SIMILARITY: 'ai:clip:similarity',
  AI_CLIP_SEARCH: 'ai:clip:search',
  WEB_SEARCH: 'ai:web-search',

  // Export / Import / Case profiles
  EXPORT_GEOJSON: 'export:geojson',
  EXPORT_KML: 'export:kml',
  EXPORT_PNG: 'export:png',
  EXPORT_VIDEO: 'export:video',
  IMPORT_KML: 'import:kml',
  CASE_PROFILES: 'case:profiles',

  // Trip params + Hiker calibration
  TRIP_DERIVE: 'trip:derive',
  HIKER_CALIBRATE: 'hiker:calibrate',

  // Climate helpers
  BATHYMETRY_DEPTH: 'climate:bathymetry:depth',
  REGION_CLASSIFY: 'climate:region:classify',

  // VR / OpenXR (Quest 3S via PC Link)
  XR_START: 'xr:start',
  XR_STOP: 'xr:stop',
  XR_STATUS: 'xr:status',
  XR_POSE: 'xr:pose',
  XR_FRAME: 'xr:frame',
  XR_CONTROLLERS: 'xr:controllers',

  // License / activation (monetization)
  LICENSE_STATUS: 'license:status',
  LICENSE_ACTIVATE: 'license:activate',
  LICENSE_DEACTIVATE: 'license:deactivate',
  LICENSE_MACHINE_ID: 'license:machine-id',

  // Compute dispatcher (HAL backend selection)
  COMPUTE_TASK: 'compute:task',

  // Image decode bridge (main → renderer WebCodecs)
  IMAGE_DECODE_REQUEST: 'image:decode-request',
  IMAGE_DECODE_RESPONSE: 'image:decode-response',

  // HAL fetch (streaming I/O for renderer-initiated downloads)
  HAL_FETCH_BUFFER: 'hal:fetch-buffer',

  // STAC/COG — real Sentinel-2 ingestion
  STAC_COG_COMPUTE: 'stac:cog:compute',
  STAC_COG_BANDS: 'stac:cog:bands',
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]
