import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '@shared/ipc'

/**
 * Subscribe to an IPC channel and return an unsubscribe function.
 * This is the standard pattern for all pushed-event subscriptions.
 */
function subscribe<T>(
  channel: string,
  cb: (payload: T) => void,
): () => void {
  const handler = (_e: Electron.IpcRendererEvent, payload: T) => cb(payload)
  ipcRenderer.on(channel, handler)
  return () => {
    ipcRenderer.removeListener(channel, handler)
  }
}

/**
 * Typed preload API. Mirrors OGOS's window.terrain / window.ai / window.climate
 * pattern but routed through our IPC contract.
 */
const api = {
  /* ── Generic ── */
  hello: () => ipcRenderer.invoke(IPC.APP_HELLO),
  send: (channel: string, ...args: unknown[]) => ipcRenderer.send(channel, ...args),
  invoke: (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args),
  on: (channel: string, callback: (...args: unknown[]) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, ...args: unknown[]) => callback(...args)
    ipcRenderer.on(channel, handler)
    return () => ipcRenderer.removeListener(channel, handler)
  },
  off: (channel: string) => {
    ipcRenderer.removeAllListeners(channel)
  },

  /* ── Scene ── */
  scene: {
    get: () => ipcRenderer.invoke(IPC.GET_SCENE_CONTEXT),
    set: (patch: unknown) => ipcRenderer.send(IPC.SET_SCENE_CONTEXT, patch),
    onContext: (cb: (ctx: unknown) => void) => subscribe(IPC.SCENE_CONTEXT_CHANGED, cb),
    setStack: (stack: string) => ipcRenderer.send(IPC.GLOBE_SET_STACK, stack),
    sendViewport: (vp: unknown) => ipcRenderer.send(IPC.GLOBE_VIEWPORT, vp),
  },

  /* ── Tiles / offline ── */
  tiles: {
    get: (source: string, z: number, x: number, y: number) =>
      ipcRenderer.invoke(IPC.TILE_REQUEST, { source, z, x, y }),
    getStrategy: () => ipcRenderer.invoke(IPC.GET_OFFLINE_STRATEGY),
    setStrategy: (s: string) => ipcRenderer.send(IPC.SET_OFFLINE_STRATEGY, s),
  },

  /* ── Terrain / SAR ── */
  terrain: {
    demSample: (lng: number, lat: number) => ipcRenderer.invoke(IPC.DEM_SAMPLE, { lng, lat }),
    demProfile: (coords: unknown[]) => ipcRenderer.invoke(IPC.DEM_PROFILE, { coords }),
    slopeAnalysis: (req: unknown) => ipcRenderer.invoke(IPC.SLOPE_ANALYSIS, req),
    anomalyAnalysis: (req: unknown) => ipcRenderer.invoke(IPC.ANOMALY_ANALYSIS, req),
    searchZones: (req: unknown) => ipcRenderer.invoke(IPC.SEARCH_ZONES, req),
    restPoints: (req: unknown) => ipcRenderer.invoke(IPC.REST_POINTS, req),
    routePlan: (req: unknown) => ipcRenderer.invoke(IPC.ROUTE_PLAN, req),
    fallRisk: (req: unknown) => ipcRenderer.invoke(IPC.FALL_RISK, req),
    remainsCorridor: (req: unknown) => ipcRenderer.invoke(IPC.REMAINS_CORRIDOR, req),
    runoff: (req: unknown) => ipcRenderer.invoke(IPC.RUNOFF_ANALYSIS, req),
    canopy: (req: unknown) => ipcRenderer.invoke(IPC.CANOPY_ANALYSIS, req),
    behavior: (req: unknown) => ipcRenderer.invoke(IPC.BEHAVIOR_ENGINE, req),
    water: (bounds: unknown) => ipcRenderer.invoke(IPC.WATER_FETCH, { bounds }),
    roads: (bounds: unknown) => ipcRenderer.invoke(IPC.ROAD_FETCH, { bounds }),
  },

  /* ── Infrastructure (OSM Overpass — airports, power, substations, buoys) ── */
  infrastructure: {
    fetch: (bounds: unknown) => ipcRenderer.invoke(IPC.INFRA_FETCH, { bounds }),
  },

  /* ── History & Research (OSM Overpass historic=*, era-classified) ── */
  history: {
    sites: (bounds: unknown, opts?: { includePost1945?: boolean }) =>
      ipcRenderer.invoke(IPC.HISTORY_FETCH, { bounds, opts }),
  },

  /* ── Imagery ── */
  imagery: {
    search: (req: unknown) => ipcRenderer.invoke(IPC.SENTINEL_SEARCH, req),
    layers: () => ipcRenderer.invoke(IPC.SENTINEL_LAYERS),
    getTle: () => ipcRenderer.invoke(IPC.SAT_TLE_GET),
  },

  /* ── Weather ── */
  weather: {
    radar: () => ipcRenderer.invoke(IPC.WEATHER_RADAR),
    forecast: (point: { lng: number; lat: number }) => ipcRenderer.invoke(IPC.WEATHER_FORECAST, point),
    rainfall: (bounds: unknown) => ipcRenderer.invoke(IPC.WEATHER_RAINFALL, { bounds }),
  },

  /* ── Live data (pushed from main) ── */
  live: {
    onUpdate: (cb: (update: unknown) => void) => subscribe(IPC.LIVE_UPDATE, cb),
    onAircraft: (cb: (update: unknown) => void) => subscribe(IPC.AIRCRAFT_UPDATE, cb),
    onEarthquake: (cb: (update: unknown) => void) => subscribe(IPC.EARTHQUAKE_UPDATE, cb),
    onFire: (cb: (update: unknown) => void) => subscribe(IPC.FIRE_UPDATE, cb),
    onVessel: (cb: (update: unknown) => void) => subscribe(IPC.VESSEL_UPDATE, cb),
    onLightning: (cb: (update: unknown) => void) => subscribe(IPC.LIGHTNING_UPDATE, cb),
  },

  /* ── Climate / Ocean (pushed from main) ── */
  climate: {
    onUpdate: (cb: (update: unknown) => void) => subscribe(IPC.CLIMATE_UPDATE, cb),
    getCurrent: () => ipcRenderer.invoke(IPC.CLIMATE_GET_CURRENT),
    onIntegrity: (cb: (update: unknown) => void) => subscribe(IPC.CLIMATE_INTEGRITY, cb),
    getIntegrityCurrent: () => ipcRenderer.invoke(IPC.CLIMATE_INTEGRITY_GET_CURRENT),
    onAlert: (cb: (alert: unknown) => void) => subscribe(IPC.CLIMATE_ALERT, cb),
    setViewport: (bounds: unknown) => ipcRenderer.send(IPC.CLIMATE_SET_VIEWPORT, bounds),
    whitelist: (stationId: string) => ipcRenderer.invoke(IPC.CLIMATE_WHITELIST, stationId),
    unwhitelist: (stationId: string) => ipcRenderer.invoke(IPC.CLIMATE_UNWHITELIST, stationId),
  },

  /* ── Storms (pushed) ── */
  storms: {
    onUpdate: (cb: (storms: unknown) => void) => subscribe(IPC.STORM_UPDATE, cb),
    onTrackUpdate: (cb: (tracks: unknown) => void) => subscribe(IPC.STORM_TRACK_UPDATE, cb),
  },

  /* ── Space weather (pushed) ── */
  spaceWeather: {
    onUpdate: (cb: (data: unknown) => void) => subscribe(IPC.SPACE_WEATHER_UPDATE, cb),
  },

  /* ── Predictions (pushed) ── */
  predictions: {
    onUpdate: (cb: (update: unknown) => void) => subscribe(IPC.PREDICTION_UPDATE, cb),
    getCurrent: () => ipcRenderer.invoke(IPC.PREDICTION_GET_CURRENT),
  },

  /* ── Grid (pushed + invoke) ── */
  grid: {
    onUpdate: (cb: (update: unknown) => void) => subscribe(IPC.GRID_UPDATE, cb),
    onAlert: (cb: (alert: unknown) => void) => subscribe(IPC.GRID_ALERT, cb),
    onIntegrity: (cb: (integrity: unknown) => void) => subscribe(IPC.GRID_INTEGRITY, cb),
    onTraffic: (cb: (traffic: unknown) => void) => subscribe(IPC.GRID_TRAFFIC, cb),
    whitelist: (assetId: string) => ipcRenderer.invoke(IPC.GRID_WHITELIST, assetId),
    unwhitelist: (assetId: string) => ipcRenderer.invoke(IPC.GRID_UNWHITELIST, assetId),
    getWhitelist: () => ipcRenderer.invoke(IPC.GRID_GET_WHITELIST),
    snooze: (minutes: number) => ipcRenderer.invoke(IPC.GRID_SNOOZE, minutes),
    isSnoozed: () => ipcRenderer.invoke(IPC.GRID_GET_SNOOZE),
    getSettings: () => ipcRenderer.invoke(IPC.GRID_GET_SETTINGS),
    updateSettings: (partial: unknown) => ipcRenderer.invoke(IPC.GRID_UPDATE_SETTINGS, partial),
    setCrossDomain: (enabled: boolean) => ipcRenderer.invoke(IPC.GRID_SET_CROSS_DOMAIN, enabled),
    getCrossDomain: () => ipcRenderer.invoke(IPC.GRID_GET_CROSS_DOMAIN),
  },

  /* ── Network (pushed + invoke) ── */
  network: {
    onUpdate: (cb: (update: unknown) => void) => subscribe(IPC.NET_UPDATE, cb),
    onAlert: (cb: (alert: unknown) => void) => subscribe(IPC.NET_ALERT, cb),
    onHealth: (cb: (health: unknown) => void) => subscribe(IPC.NET_HEALTH, cb),
    onOutage: (cb: (outage: unknown) => void) => subscribe(IPC.NET_OUTAGE, cb),
    onVpn: (cb: (status: unknown) => void) => subscribe(IPC.NET_VPN, cb),
    onUserLocation: (cb: (loc: unknown) => void) => subscribe(IPC.NET_USER_LOCATION, cb),
    refreshVpn: () => ipcRenderer.invoke(IPC.NET_VPN_REFRESH),
    geoipLookup: (ip: string) => ipcRenderer.invoke(IPC.NET_GEOIP_LOOKUP, ip),
    speedTest: () => ipcRenderer.invoke(IPC.NET_SPEEDTEST_RUN),
    dnsTest: () => ipcRenderer.invoke(IPC.NET_DNSTEST_RUN),
  },

  /* ── AI Bridge ── */
  ai: {
    health: () => ipcRenderer.invoke(IPC.AI_HEALTH),

    // Session management
    createSession: () => ipcRenderer.invoke('ai:session:create'),
    destroySession: (sessionId: string) => ipcRenderer.invoke('ai:session:destroy', { sessionId }),
    getSession: (sessionId: string) => ipcRenderer.invoke('ai:session:get', { sessionId }),

    // Chat with tools (streaming via ai:chat:stream events)
    chat: (sessionId: string, prompt: string, opts?: { image?: string; model?: string; mode?: 'active-sar' | 'legacy-research'; securityLevel?: number }) =>
      ipcRenderer.invoke(IPC.AI_CHAT, { sessionId, prompt, image: opts?.image, model: opts?.model, mode: opts?.mode, securityLevel: opts?.securityLevel }),

    // Vision (one-shot viewport analysis)
    vision: (prompt: string, image: string, model?: string) =>
      ipcRenderer.invoke(IPC.AI_VISION, { prompt, image, model }),

    // Tool registration (renderer registers action-runner tools)
    registerTools: (tools: unknown[]) => ipcRenderer.invoke('ai:tools:register', { tools }),

    // Tool call resolution (renderer sends back tool results)
    resolveTool: (callId: string, result: unknown) =>
      ipcRenderer.invoke('ai:tool:resolve', { callId, result }),
    rejectTool: (callId: string, error: string) =>
      ipcRenderer.invoke('ai:tool:reject', { callId, error }),

    // Stream listener — renderer subscribes to tokens, tool calls, done
    onStream: (cb: (data: { sessionId: string; type: string; token?: string; toolName?: string; args?: unknown; result?: unknown; content?: string; error?: string; callId?: string }) => void) => {
      const handler = (_event: unknown, data: unknown) => cb(data as any)
      ipcRenderer.on(IPC.AI_CHAT_STREAM, handler)
      return () => ipcRenderer.off(IPC.AI_CHAT_STREAM, handler)
    },

    // Legacy chat (backward compat)
    chatLegacy: (prompt: string, model?: string, context?: string) =>
      ipcRenderer.invoke('ai:chat:legacy', { prompt, model, context }),

    clipHealth: () => ipcRenderer.invoke(IPC.AI_CLIP_HEALTH),
    clipSearch: (query: string, bounds?: unknown) =>
      ipcRenderer.invoke(IPC.AI_CLIP_SEARCH, { query, bounds }),
    webSearch: (query: string, limit?: number, securityLevel?: number) =>
      ipcRenderer.invoke(IPC.WEB_SEARCH, { query, limit, securityLevel }),
  },

  /* ── Export / Import / Case profiles ── */
  files: {
    exportGeoJSON: (data: unknown) => ipcRenderer.invoke(IPC.EXPORT_GEOJSON, data),
    exportKML: (data: unknown) => ipcRenderer.invoke(IPC.EXPORT_KML, data),
    exportPNG: (dataUrl: string) => ipcRenderer.invoke(IPC.EXPORT_PNG, { dataUrl }),
    importKml: () => ipcRenderer.invoke(IPC.IMPORT_KML),
    caseProfiles: (id?: string) => ipcRenderer.invoke(IPC.CASE_PROFILES, id ? { id } : {}),
  },

  /* ── Trip params + Hiker calibration ── */
  trip: {
    derive: (params: unknown) => ipcRenderer.invoke(IPC.TRIP_DERIVE, { params }),
    calibrate: (profile: unknown) => ipcRenderer.invoke(IPC.HIKER_CALIBRATE, { profile }),
  },

  /* ── Climate helpers (bathymetry + region classification) ── */
  climateHelpers: {
    depth: (lat: number, lon: number) => ipcRenderer.invoke(IPC.BATHYMETRY_DEPTH, { lat, lon }),
    classify: (lat: number, lon: number, stationType?: string) =>
      ipcRenderer.invoke(IPC.REGION_CLASSIFY, { lat, lon, stationType }),
  },
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
