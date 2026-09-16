import { pluginManager } from './plugin-manager'
import type { EarthEnginePlugin, PluginContext, PluginStats, PluginControlSpec } from './plugin-manager'

// Ensure the plugin registry is loaded
import './index'

export interface PluginTestResult {
  id: string
  name: string
  initTimeMs: number
  updateTimeMs: number
  register: boolean
  getStats: boolean
  getControls: boolean
  update: boolean
  onControl: boolean
  unregister: boolean
  errors: string[]
}

export interface PluginTestReport {
  total: number
  passed: number
  failed: number
  results: PluginTestResult[]
}

export interface HarnessOptions {
  /** Pause between plugins to keep the renderer responsive */
  yieldBetweenMs?: number
  /** How many consecutive test steps are allowed before a forced yield */
  stepsBeforeYield?: number
  /** Per-lifecycle step timeout. Synchronous heavy plugins may still block. */
  stepTimeoutMs?: number
}

let mockId = 0
function nextId() {
  mockId++
  return `mock-${mockId}`
}

/** A recursive everything-mock that is both callable and property-accessible. */
function createMock(): any {
  const target = () => {}
  return new Proxy(target, {
    get(_, prop: string | symbol) {
      // Mocks are thenable: await/.then resolve to undefined so plugin code
      // like `result?.profiles || []` falls through to real empty values.
      if (prop === 'then') return (cb: any) => Promise.resolve(undefined).then(cb)
      if (prop === 'toString' || prop === 'valueOf' || prop === Symbol.toPrimitive) {
        return () => '[mock]'
      }
      return createMock()
    },
    apply() {
      return createMock()
    },
    set() {
      return true
    },
  })
}

/** Wrap a concrete object so any missing property falls back to a mock. */
function wrap<T extends object>(target: T): T {
  return new Proxy(target, {
    get(t, prop: string | symbol) {
      if (prop === 'then') return undefined
      if (prop === 'toString' || prop === 'valueOf' || prop === Symbol.toPrimitive) {
        return () => '[mock]'
      }
      if (prop in t) {
        const val = (t as any)[prop]
        return typeof val === 'function' ? val.bind(t) : val
      }
      return createMock()
    },
    set(t, prop: string | symbol, value: any) {
      ;(t as any)[prop] = value
      return true
    },
  }) as T
}

function createEvent() {
  const listeners: any[] = []
  return wrap({
    addEventListener: (listener: any, thisObject?: any) => {
      const wrapped = thisObject ? listener.bind(thisObject) : listener
      listeners.push(wrapped)
      return () => {
        const i = listeners.indexOf(wrapped)
        if (i >= 0) listeners.splice(i, 1)
      }
    },
    removeEventListener: (listener: any) => {
      const i = listeners.indexOf(listener)
      if (i >= 0) listeners.splice(i, 1)
    },
    raiseEvent: (...args: any[]) => {
      listeners.forEach((l) => l(...args))
    },
  })
}

/** A recursive everything-mock for the renderer IPC object. */
function makeMockIpc(): any {
  return createMock()
}

function makeMockWorldOverlay(): any {
  return wrap({
    registerCard: () => {},
    registerLabel: () => {},
    remove: () => {},
    update: () => {},
    clear: () => {},
  })
}

/** Headless Cesium-viewer-shaped mock. No WebGL, no real canvas, no feeds. */
function makeMockViewer(): any {
  const canvas = typeof document !== 'undefined' ? document.createElement('canvas') : undefined
  const container = typeof document !== 'undefined' ? document.createElement('div') : undefined

  function createCollection() {
    const byId = new Map<string, any>()
    let list: any[] = []
    return {
      add: (x: any) => {
        const id = x?.id ?? nextId()
        const wrapped = wrap({ ...x, id, show: true })
        byId.set(id, wrapped)
        list.push(wrapped)
        return wrapped
      },
      addImageryProvider: (provider: any) => {
        const id = nextId()
        const wrapped = wrap({ id, show: true, imageryProvider: provider })
        byId.set(id, wrapped)
        list.push(wrapped)
        return wrapped
      },
      remove: (x: any) => {
        const id = typeof x === 'string' ? x : x?.id
        if (id) {
          byId.delete(id)
          list = list.filter((i) => i.id !== id)
        }
        return true
      },
      removeAll: () => {
        byId.clear()
        list.length = 0
      },
      get: (i: number) => list[i],
      getById: (id: string) => byId.get(id),
      getByName: (name: string) => list.find((i) => i.name === name),
      getByShown: () => undefined,
      contains: (x: any) => {
        const id = typeof x === 'string' ? x : x?.id
        return id ? byId.has(id) : false
      },
      get length() {
        return list.length
      },
      get values() {
        return list.slice()
      },
    }
  }

  const entitiesById = new Map<string, any>()
  let entitiesList: any[] = []
  const entities = wrap({
    add: (e: any) => {
      const id = e?.id ?? nextId()
      const wrapped = wrap({ ...e, id, show: true })
      entitiesById.set(id, wrapped)
      entitiesList.push(wrapped)
      return wrapped
    },
    remove: (x: any) => {
      const id = typeof x === 'string' ? x : x?.id
      if (id) {
        entitiesById.delete(id)
        entitiesList = entitiesList.filter((i) => i.id !== id)
      }
      return true
    },
    removeAll: () => {
      entitiesById.clear()
      entitiesList.length = 0
    },
    get: (i: number) => entitiesList[i],
    getById: (id: string) => entitiesById.get(id),
    getOrCreateEntity: (id: string) => {
      if (!entitiesById.has(id)) {
        const wrapped = wrap({ id, show: true })
        entitiesById.set(id, wrapped)
        entitiesList.push(wrapped)
      }
      return entitiesById.get(id)
    },
    getByShown: () => undefined,
    contains: (x: any) => {
      const id = typeof x === 'string' ? x : x?.id
      return id ? entitiesById.has(id) : false
    },
    get length() {
      return entitiesList.length
    },
    get values() {
      return entitiesList.slice()
    },
    collectionChanged: createEvent(),
  })

  const dataSourceById = new Map<string, any>()
  let dataSourceList: any[] = []
  const dataSources = wrap({
    add: (ds: any) => {
      const id = ds?.id ?? ds?.name ?? nextId()
      const wrapped = wrap({ ...ds, id, show: true })
      dataSourceById.set(id, wrapped)
      dataSourceList.push(wrapped)
      return Promise.resolve(wrapped)
    },
    remove: (x: any) => {
      const id = typeof x === 'string' ? x : x?.id
      if (id) {
        dataSourceById.delete(id)
        dataSourceList = dataSourceList.filter((i) => i.id !== id)
      }
      return true
    },
    removeAll: () => {
      dataSourceById.clear()
      dataSourceList.length = 0
      return Promise.resolve()
    },
    get: (i: number) => dataSourceList[i],
    getById: (id: string) => dataSourceById.get(id),
    getByName: (name: string) => dataSourceList.find((i) => i.name === name),
    contains: (x: any) => {
      const id = typeof x === 'string' ? x : x?.id
      return id ? dataSourceById.has(id) : false
    },
    get length() {
      return dataSourceList.length
    },
    get values() {
      return dataSourceList.slice()
    },
    dataSourceAdded: createEvent(),
    dataSourceRemoved: createEvent(),
    dataSourceMoved: createEvent(),
  })

  const imageryLayers = wrap({
    ...createCollection(),
    layerAdded: createEvent(),
    layerRemoved: createEvent(),
    layerShownOrHidden: createEvent(),
    layerMoved: createEvent(),
  })

  const primitives = wrap(createCollection())

  const groundPrimitives = wrap(createCollection())

  const postProcessStages = wrap(createCollection())

  const terrainProvider = wrap({
    ready: true,
    availability: wrap({
      contains: () => true,
      computeMaximumRectangleAtAnyLevel: () => ({ west: 0, south: 0, east: 0, north: 0 }),
    }),
    hasVertexNormals: false,
    hasWaterMask: false,
    tilingScheme: wrap({
      getNumberOfXTilesAtLevel: () => 1,
      getNumberOfYTilesAtLevel: () => 1,
      getExtent: () => ({ west: 0, south: 0, east: 0, north: 0 }),
    }),
  })

  const globe = wrap({
    depthTestAgainstTerrain: false,
    terrainProvider,
    imageryLayers: wrap({
      ...createCollection(),
      layerAdded: createEvent(),
      layerRemoved: createEvent(),
      layerShownOrHidden: createEvent(),
    }),
    show: true,
    lightingFadeInDistance: 0,
    lightingFadeOutDistance: 0,
    enableLighting: true,
    baseColor: { red: 0, green: 0, blue: 0, alpha: 0, withAlpha: (a: number) => ({ red: 0, green: 0, blue: 0, alpha: a }) },
    undergroundColor: { red: 0, green: 0, blue: 0, alpha: 1, withAlpha: (a: number) => ({ red: 0, green: 0, blue: 0, alpha: a }) },
    dynamicAtmosphereLighting: false,
    dynamicAtmosphereLightingFromSun: false,
    terrainProviderChanged: createEvent(),
  })

  const camera = wrap({
    position: { x: 0, y: 0, z: 0 },
    positionCartographic: { longitude: 0, latitude: 0, height: 20_000_000 },
    heading: 0,
    pitch: -1.5707963267948966,
    roll: 0,
    up: { x: 0, y: 0, z: 1 },
    direction: { x: 0, y: 0, z: -1 },
    right: { x: 1, y: 0, z: 0 },
    flyTo: () => Promise.resolve(),
    setView: () => {},
    lookAt: () => {},
    viewBoundingSphere: () => Promise.resolve(),
    zoomIn: () => {},
    zoomOut: () => {},
    move: () => {},
    rotate: () => {},
    look: () => {},
    twist: () => {},
    lookUp: () => {},
    lookDown: () => {},
    lookLeft: () => {},
    lookRight: () => {},
    computeViewRectangle: () => undefined,
    pickEllipsoid: () => undefined,
    getPickRay: () => ({ origin: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 0, z: -1 } }),
    changed: createEvent(),
    moveStart: createEvent(),
    moveEnd: createEvent(),
  })

  const scene = wrap({
    globe,
    camera,
    canvas,
    primitives,
    groundPrimitives,
    imageryLayers,
    postProcessStages,
    pick: () => undefined,
    pickPosition: () => ({ x: 0, y: 0, z: 0 }),
    drillPick: () => [],
    pickTranslucentDepth: () => 0,
    requestRender: () => {},
    preUpdate: createEvent(),
    postUpdate: createEvent(),
    screenSpaceCameraController: wrap({
      enableRotate: true,
      enableTranslate: true,
      enableZoom: true,
      enableTilt: true,
      enableLook: true,
      enableInputs: true,
      minimumZoomDistance: 1,
      maximumZoomDistance: 2_000_000_000,
      enableCollisionDetection: true,
    }),
    mode: 3,
    mapProjection: wrap({
      project: () => ({ x: 0, y: 0 }),
      unproject: () => ({ longitude: 0, latitude: 0 }),
    }),
    backgroundColor: { red: 0, green: 0, blue: 0, alpha: 1, withAlpha: (a: number) => ({ red: 0, green: 0, blue: 0, alpha: a }) },
    useDepthPicking: false,
    highDynamicRange: false,
    verticalExaggeration: 1,
    fxaa: true,
    sun: wrap({ show: true }),
    moon: wrap({ show: true }),
    skyAtmosphere: wrap({ show: true, hueShift: 0, saturationShift: 0, brightnessShift: 0 }),
    fog: wrap({ enabled: true, density: 2e-4, screenSpaceErrorFactor: 2 }),
  })

  const clock = wrap({
    currentTime: { dayNumber: 0, secondsOfDay: 0 },
    onTick: createEvent(),
    shouldAnimate: true,
    clockRange: 0,
    multiplier: 1,
    startTime: { dayNumber: 0, secondsOfDay: 0 },
    stopTime: { dayNumber: 0, secondsOfDay: 86400 },
    tick: () => {},
  })

  const cesiumWidget = wrap({
    canvas,
    container,
    clock,
    screenSpaceEventHandler: wrap({
      getInputAction: () => undefined,
      setInputAction: () => {},
      removeInputAction: () => {},
    }),
  })

  const viewer = wrap({
    id: 'mock-viewer',
    scene,
    camera,
    clock,
    container,
    canvas,
    cesiumWidget,
    entities,
    dataSources,
    imageryLayers,
    primitives,
    groundPrimitives,
    postProcessStages,
    terrainProvider,
    trackedEntity: undefined,
    selectedEntity: undefined,
    targetFrameRate: undefined,
    resolutionScale: 1,
    useDefaultRenderLoop: true,
    scene3DOnly: false,
    shadows: 0,
    terrainShadows: 0,
    isDestroyed: () => false,
    destroy: () => {},
    flyTo: () => Promise.resolve(),
    zoomTo: () => Promise.resolve(),
    flyToBoundingSphere: () => Promise.resolve(),
    extend: () => {},
    trackedEntityChanged: createEvent(),
    selectedEntityChanged: createEvent(),
  })

  return viewer
}

function makeMockContext(): PluginContext {
  return {
    viewer: makeMockViewer() as any,
    sceneContext: {},
    ipc: makeMockIpc(),
    worldOverlay: makeMockWorldOverlay() as any,
  }
}

function yieldToMain(ms = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function withTimeout<T>(promise: Promise<T> | T, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms)
    Promise.resolve(promise)
      .then((val) => {
        clearTimeout(timer)
        resolve(val)
      })
      .catch((err) => {
        clearTimeout(timer)
        reject(err)
      })
  })
}

export async function runPluginTests(options: HarnessOptions = {}): Promise<PluginTestReport> {
  const { yieldBetweenMs = 10, stepsBeforeYield = 4, stepTimeoutMs = 15000 } = options
  const plugins = pluginManager.getPlugins()
  const results: PluginTestResult[] = []

  console.log('[plugin-harness] starting staged plugin test run...')
  console.log(`[plugin-harness] ${plugins.length} plugins registered`)

  // Stub network so headless runs never hit real feeds
  const realFetch = globalThis.fetch
  globalThis.fetch = (async () =>
    new Response('{}', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof fetch

  let stepCount = 0
  try {
    for (let i = 0; i < plugins.length; i++) {
      const p = plugins[i]
      console.log(`[plugin-harness] [${i + 1}/${plugins.length}] testing ${p.id}...`)
      const result = await testPlugin(p, stepTimeoutMs)
      results.push(result)

      stepCount++
      if (stepCount % stepsBeforeYield === 0) {
        await yieldToMain(yieldBetweenMs)
      }
    }
  } finally {
    globalThis.fetch = realFetch
  }

  // Final yield so the last logs can flush before the summary
  await yieldToMain(0)

  const failed = results.filter((r) => r.errors.length > 0).length
  const passed = results.length - failed
  const report: PluginTestReport = { total: results.length, passed, failed, results }

  console.log('[plugin-harness] ===================================')
  console.log(`[plugin-harness] Plugins tested: ${report.total}`)
  console.log(`[plugin-harness] Passed: ${report.passed}`)
  console.log(`[plugin-harness] Failed: ${report.failed}`)
  console.log('[plugin-harness] Full report:', report)
  console.log('[plugin-harness] ===================================')

  return report
}

async function timedStep(
  label: string,
  fn: () => Promise<void> | void,
  timeoutMs: number,
): Promise<void> {
  // Schedule on a fresh macrotask so a long synchronous plugin doesn't
  // starve the renderer *between* plugins. Timeouts catch slow async work.
  await withTimeout(
    new Promise<void>((resolve, reject) => {
      setTimeout(() => {
        try {
          const out = fn()
          Promise.resolve(out).then(resolve).catch(reject)
        } catch (err) {
          reject(err)
        }
      }, 0)
    }),
    timeoutMs,
  )
}

async function testPlugin(p: EarthEnginePlugin, stepTimeoutMs: number): Promise<PluginTestResult> {
  const res: PluginTestResult = {
    id: p.id,
    name: p.name,
    initTimeMs: 0,
    updateTimeMs: 0,
    register: false,
    getStats: false,
    getControls: false,
    update: false,
    onControl: false,
    unregister: false,
    errors: [],
  }

  const ctx = makeMockContext()

  const initStart = performance.now()
  try {
    await timedStep('register', () => p.register(ctx), stepTimeoutMs)
    res.register = true
  } catch (err) {
    res.errors.push(`register: ${err}`)
  }
  res.initTimeMs = performance.now() - initStart
  await yieldToMain(0)

  if (p.getStats) {
    try {
      await timedStep('getStats', () => {
        const stats: PluginStats | undefined = p.getStats!()
        if (stats && typeof stats.count === 'number' && stats.status) res.getStats = true
        else res.errors.push('getStats returned invalid shape')
      }, stepTimeoutMs)
    } catch (err) {
      res.errors.push(`getStats: ${err}`)
    }
  } else {
    res.getStats = true
  }
  await yieldToMain(0)

  let controls: PluginControlSpec[] | undefined
  if (p.getControls) {
    try {
      await timedStep('getControls', () => {
        controls = p.getControls!()
        if (Array.isArray(controls)) res.getControls = true
        else res.errors.push('getControls did not return an array')
      }, stepTimeoutMs)
    } catch (err) {
      res.errors.push(`getControls: ${err}`)
    }
  } else {
    res.getControls = true
  }
  await yieldToMain(0)

  const updateStart = performance.now()
  if (p.update) {
    try {
      await timedStep('update', () => p.update!(ctx), stepTimeoutMs)
      res.update = true
    } catch (err) {
      res.errors.push(`update: ${err}`)
    }
  } else {
    res.update = true
  }
  res.updateTimeMs = performance.now() - updateStart
  await yieldToMain(0)

  if (p.onControl && controls) {
    try {
      await timedStep('onControl', () => {
        for (const c of controls!) {
          if (c.type === 'toggle') p.onControl!(c.id, c.value)
          else if (c.type === 'button') p.onControl!(c.id, undefined)
          else if (c.type === 'slider') p.onControl!(c.id, c.value)
          else if (c.type === 'select') p.onControl!(c.id, c.value)
          else if (c.type === 'input') p.onControl!(c.id, c.value)
        }
      }, stepTimeoutMs)
      res.onControl = true
    } catch (err) {
      res.errors.push(`onControl: ${err}`)
    }
  } else {
    res.onControl = true
  }
  await yieldToMain(0)

  try {
    await timedStep('unregister', () => p.unregister(), stepTimeoutMs)
    res.unregister = true
  } catch (err) {
    res.errors.push(`unregister: ${err}`)
  }
  await yieldToMain(0)

  const failed = res.errors.length > 0
  console.log(`[plugin-harness] ${failed ? 'FAIL' : 'PASS'} ${p.id}: ${res.errors.join(' | ') || 'ok'}`)

  return res
}
