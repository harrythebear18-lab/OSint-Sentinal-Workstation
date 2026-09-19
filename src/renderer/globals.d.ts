export {}

declare global {
  interface Window {
    api: {
      hello: () => Promise<string>
      send: (channel: string, ...args: unknown[]) => void
      invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
      on: (channel: string, callback: (...args: unknown[]) => void) => void
      off: (channel: string) => void

      scene: {
        get: () => Promise<unknown>
        set: (patch: unknown) => void
        onContext: (cb: (ctx: unknown) => void) => void
        setStack: (stack: string) => void
        sendViewport: (vp: unknown) => void
      }

      tiles: {
        get: (source: string, z: number, x: number, y: number) => Promise<ArrayBuffer | null>
        getStrategy: () => Promise<string>
        setStrategy: (s: string) => void
      }

      terrain: {
        demSample: (lng: number, lat: number) => Promise<{ elevation: number | null }>
        demProfile: (coords: unknown[]) => Promise<unknown>
        slopeAnalysis: (req: unknown) => Promise<{ bands: any[]; legend: any[] }>
        anomalyAnalysis: (req: unknown) => Promise<{ zones: any[] }>
        searchZones: (req: unknown) => Promise<{ zones: any[] }>
        restPoints: (req: unknown) => Promise<{ points: any[] }>
        routePlan: (req: unknown) => Promise<unknown>
        fallRisk: (req: unknown) => Promise<{ zones: any[] }>
        runoff: (req: unknown) => Promise<{ flowPaths: any[]; pools: any[]; floodZones: any[] }>
        canopy: (req: unknown) => Promise<{ zones: any[] }>
        behavior: (req: unknown) => Promise<{ paths: any[]; densityZones: any[] }>
        water: (bounds: unknown) => Promise<{ features: any[] }>
        roads: (bounds: unknown) => Promise<{ segments: any[]; bounds: any[] }>
        remainsCorridor: (req: unknown) => Promise<unknown>
      }

      infrastructure: {
        fetch: (bounds: unknown) => Promise<{ features: any[]; bounds: any[]; error?: string }>
      }

      history: {
        sites: (bounds: unknown, opts?: { includePost1945?: boolean }) => Promise<{ sites: any[]; bounds: any[]; error?: string }>
      }

      imagery: {
        search: (req: unknown) => Promise<unknown>
        layers: () => Promise<any[]>
        getTle: () => Promise<{ tles: { name: string; satnum: number; line1: string; line2: string }[]; error?: string }>
      }

      weather: {
        radar: () => Promise<any>
        forecast: (point: { lng: number; lat: number }) => Promise<any>
        rainfall: (bounds: unknown) => Promise<number>
      }

      live: {
        onUpdate: (cb: (update: unknown) => void) => void
        onAircraft: (cb: (update: unknown) => void) => void
        onEarthquake: (cb: (update: unknown) => void) => void
        onFire: (cb: (update: unknown) => void) => void
      }

      climate: {
        onUpdate: (cb: (update: unknown) => void) => () => void
        getCurrent: () => Promise<any>
        onIntegrity: (cb: (update: unknown) => void) => () => void
        getIntegrityCurrent: () => Promise<any>
        onAlert: (cb: (alert: unknown) => void) => () => void
        setViewport: (bounds: unknown) => void
        whitelist: (stationId: string) => Promise<unknown>
        unwhitelist: (stationId: string) => Promise<unknown>
      }

      ai: {
        health: () => Promise<{ running: boolean; models: { name: string; capabilities: string[] }[] }>
        createSession: () => Promise<{ sessionId: string; model: string; visionModel: string }>
        destroySession: (sessionId: string) => Promise<{ ok: boolean }>
        getSession: (sessionId: string) => Promise<{ sessionId: string; model: string; visionModel: string; messageCount: number; streaming: boolean } | { error: string }>
        chat: (sessionId: string, prompt: string, opts?: { image?: string; model?: string; mode?: 'active-sar' | 'legacy-research'; securityLevel?: number }) => Promise<{ content: string; error?: string }>
        vision: (prompt: string, image: string, model?: string) => Promise<{ content: string; error?: string }>
        registerTools: (tools: unknown[]) => Promise<{ count: number }>
        resolveTool: (callId: string, result: unknown) => Promise<{ ok: boolean }>
        rejectTool: (callId: string, error: string) => Promise<{ ok: boolean }>
        onStream: (cb: (data: { sessionId: string; type: string; token?: string; toolName?: string; args?: unknown; result?: unknown; content?: string; error?: string; callId?: string }) => void) => () => void
        chatLegacy: (prompt: string, model?: string, context?: string) => Promise<{ content: string; model: string; error?: string }>
        clipHealth: () => Promise<{ running: boolean; model?: string }>
        clipSearch: (query: string, bounds?: unknown) => Promise<{ results: any[]; error?: string }>
        webSearch: (query: string, limit?: number, securityLevel?: number) => Promise<{ results: any[] }>
      }

      files: {
        exportGeoJSON: (data: unknown) => Promise<string | null>
        exportKML: (data: unknown) => Promise<string | null>
        exportPNG: (dataUrl: string) => Promise<string | null>
        importKml: () => Promise<{ features: any[] } | null>
        caseProfiles: (id?: string) => Promise<unknown>
      }

      trip: {
        derive: (params: unknown) => Promise<unknown>
        calibrate: (profile: unknown) => Promise<unknown>
      }

      predictions: {
        onUpdate: (cb: (update: unknown) => void) => () => void
        getCurrent: () => Promise<any>
      }

      grid: {
        onUpdate: (cb: (update: unknown) => void) => () => void
        onAlert: (cb: (alert: unknown) => void) => () => void
        onIntegrity: (cb: (integrity: unknown) => void) => () => void
        onTraffic: (cb: (traffic: unknown) => void) => () => void
        whitelist: (assetId: string) => Promise<void>
        unwhitelist: (assetId: string) => Promise<void>
        getWhitelist: () => Promise<string[]>
        snooze: (minutes: number) => Promise<void>
        isSnoozed: () => Promise<boolean>
        getSettings: () => Promise<unknown>
        updateSettings: (partial: unknown) => Promise<void>
        setCrossDomain: (enabled: boolean) => Promise<void>
        getCrossDomain: () => Promise<boolean>
      }

      network: {
        onUpdate: (cb: (update: unknown) => void) => () => void
        onAlert: (cb: (alert: unknown) => void) => () => void
        onHealth: (cb: (health: unknown) => void) => () => void
        onOutage: (cb: (outage: unknown) => void) => () => void
        onVpn: (cb: (status: unknown) => void) => () => void
        onUserLocation: (cb: (loc: unknown) => void) => () => void
        refreshVpn: () => Promise<void>
        geoipLookup: (ip: string) => Promise<unknown>
        speedTest: () => Promise<unknown>
        dnsTest: () => Promise<unknown>
      }

      climateHelpers: {
        depth: (lat: number, lon: number) => Promise<{ depthM: number } | null>
        classify: (lat: number, lon: number, stationType?: string) => Promise<unknown>
      }
    }
  }
}

declare module 'pngjs' {
  export class PNG {
    static sync: {
      read(buf: Buffer): { width: number; height: number; data: Buffer }
    }
  }
}
