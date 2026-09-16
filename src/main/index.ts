import { app, BrowserWindow } from 'electron'
import { join } from 'path'
import os from 'node:os'
import { registerIpcHandlers } from './ipc-handlers'
import { registerWindow } from './windows'
import { initImageDecodeBridge } from './services/image-decode-bridge'
import { liveData } from './services/live/live-data'
import { climateMonitor } from './services/climate/climate-monitor'
import { predictionEngine } from './services/prediction/prediction-engine'
import { gridMonitor } from './services/grid/grid-monitor'
import { networkMonitor } from './services/network/network-monitor'
import { vrManager } from './services/vr/vr-manager'
import { startClipServer, stopClipServer } from './services/clip-manager'
import { isProd, isDev, prodLog } from './utils/is-prod'

// ── Platform-aware memory tiers ──
// Adjust V8 heap limits and Ollama settings based on platform and available RAM.
// This prevents OOM crashes on low-RAM systems and allows more headroom on high-RAM.
const totalMemMB = Math.round(os.totalmem() / (1024 * 1024))
const isMac = process.platform === 'darwin'
const isLowMem = totalMemMB <= 16384

let heapLimitMB: number
let ollamaCtx: number
let ollamaKeepAlive: string

if (isMac && isLowMem) {
  // macOS portable (<=16 GB) — conservative
  heapLimitMB = 384
  ollamaCtx = 2048
  ollamaKeepAlive = '2m'
} else if (isMac && !isLowMem) {
  // macOS desktop (>16 GB) — generous
  heapLimitMB = 6144
  ollamaCtx = 4096
  ollamaKeepAlive = '5m'
} else if (!isMac && isLowMem) {
  // Windows low (<=16 GB) — moderate
  heapLimitMB = 2048
  ollamaCtx = 4096
  ollamaKeepAlive = '5m'
} else {
  // Windows high (>16 GB) — generous
  heapLimitMB = 4096
  ollamaCtx = 4096
  ollamaKeepAlive = '5m'
}

// Apply V8 heap limit to the renderer process
app.commandLine.appendSwitch('js-flags', `--max-old-space-size=${heapLimitMB}`)

console.log('═══════════════════════════════════════════════════')
console.log('  OSINT SENTINEL WORKSTATION — MAIN PROCESS START')
console.log('═══════════════════════════════════════════════════')
console.log(`[main] Electron: ${process.versions.electron}`)
console.log(`[main] Node: ${process.versions.node}`)
console.log(`[main] Chromium: ${process.versions.chrome}`)
console.log(`[main] Platform: ${process.platform} ${process.arch}`)
console.log(`[main] Total RAM: ${totalMemMB} MB`)
console.log(`[main] Memory tier: heap=${heapLimitMB} MB, ollama_ctx=${ollamaCtx}, keep_alive=${ollamaKeepAlive}`)
console.log(`[main] isDev: ${isDev}`)
console.log(`[main] ELECTRON_RENDERER_URL: ${process.env['ELECTRON_RENDERER_URL'] ?? '(not set)'}`)
console.log(`[main] ELECTRON_RUN_AS_NODE: ${process.env['ELECTRON_RUN_AS_NODE'] ?? '(not set)'}`)
console.log(`[main] __dirname: ${__dirname}`)
console.log(`[main] preload path: ${join(__dirname, '../preload/index.js')}`)
console.log(`[main] renderer path: ${isDev ? process.env['ELECTRON_RENDERER_URL'] + '/globe/index.html' : join(__dirname, '../renderer/globe/index.html')}`)

function createCockpitWindow(): BrowserWindow {
  console.log('[main] createCockpitWindow() — creating BrowserWindow...')

  const win = new BrowserWindow({
    width: 1600,
    height: 1000,
    title: 'OSINT Sentinel Workstation',
    backgroundColor: '#0b0f14',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false,
    },
  })

  console.log('[main] BrowserWindow created, id:', win.id)

  // Log all window events
  win.on('closed', () => console.log('[main] window closed'))
  win.on('unresponsive', () => console.error('[main] window UNRESPONSIVE'))
  win.on('responsive', () => console.log('[main] window responsive again'))
  win.on('show', () => console.log('[main] window shown'))
  win.on('hide', () => console.log('[main] window hidden'))

  // Log webContents lifecycle
  win.webContents.on('did-start-loading', () => console.log('[main] webContents: did-start-loading'))
  win.webContents.on('did-stop-loading', () => console.log('[main] webContents: did-stop-loading'))
  win.webContents.on('dom-ready', () => console.log('[main] webContents: dom-ready'))
  win.webContents.on('did-finish-load', () => console.log('[main] webContents: did-finish-load'))
  win.webContents.on('did-fail-load', (_e, code, desc, url) =>
    console.error(`[main] webContents: did-fail-load code=${code} desc="${desc}" url=${url}`))
  win.webContents.on('render-gone' as any, (_e: any, details: any) =>
    console.error(`[main] webContents: RENDER GONE — ${JSON.stringify(details)}`))
  win.webContents.on('preload-error', (_e, path, err) =>
    console.error(`[main] webContents: PRELOAD ERROR in ${path}: ${err}`))

  // Log renderer console messages to main terminal with full detail
  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    const tag = ['LOG', 'WARN', 'ERROR'][level] || `LVL${level}`
    console.log(`[renderer:${tag}] ${message} (${sourceId}:${line})`)
  })

  // Log crashes
  ;(win.webContents as any).on('crashed', () => console.error('[main] webContents: CRASHED'))
  ;(win.webContents as any).on('destroyed', () => console.error('[main] webContents: destroyed'))

  if (isDev) {
    const url = `${process.env['ELECTRON_RENDERER_URL']}/globe/index.html`
    console.log(`[main] loading dev URL: ${url}`)
    win.loadURL(url).then(() => console.log('[main] loadURL resolved')).catch((e) => console.error('[main] loadURL failed:', e))
    console.log('[main] opening devtools...')
    win.webContents.openDevTools({ mode: 'detach' })
  } else {
    const file = join(__dirname, '../renderer/globe/index.html')
    console.log(`[main] loading file: ${file}`)
    win.loadFile(file).then(() => console.log('[main] loadFile resolved')).catch((e) => console.error('[main] loadFile failed:', e))
  }

  registerWindow(win.webContents)
  console.log('[main] window registered')

  // Initialize image decode bridge — main process can now ask renderer
  // to decode PNG/JPEG via WebCodecs hardware
  initImageDecodeBridge()

  return win
}

console.log('[main] waiting for app.whenReady()...')

// ── GPU ACCELERATION FLAGS ──
// Keep GPU rasterization for Cesium performance, but avoid experimental
// Vulkan/WebGPU which can crash unstable GPU drivers (BSOD).
app.commandLine.appendSwitch('enable-gpu')
app.commandLine.appendSwitch('enable-gpu-rasterization')
app.commandLine.appendSwitch('enable-zero-copy')
app.commandLine.appendSwitch('ignore-gpu-blocklist')
app.commandLine.appendSwitch('enable-native-gpu-memory-buffers')
;(app as any).disableHardwareAcceleration = false
console.log('[main] GPU flags set — rasterization, zero-copy (Vulkan/WebGPU disabled for stability)')

app.whenReady().then(() => {
  console.log('[main] app.whenReady() fired')

  // ── CORS FIX: Inject Access-Control-Allow-Origin for tile servers ──
  // RainViewer and some other tile servers don't send CORS headers, causing
  // Chromium to block imagery requests. Inject the header into responses.
  const { session } = require('electron')
  session.defaultSession.webRequest.onHeadersReceived((details: any, callback: any) => {
    const url = details.url as string
    const needsCors = url.includes('rainviewer.com') ||
                      url.includes('tile.meteologix.com') ||
                      url.includes('maps.owm.io')
    if (needsCors) {
      const headers = details.responseHeaders || {}
      headers['Access-Control-Allow-Origin'] = ['*']
      callback({ responseHeaders: headers })
    } else {
      callback({})
    }
  })
  console.log('[main] CORS header injection active for tile servers')

  console.log('[main] registering IPC handlers...')
  registerIpcHandlers()
  console.log('[main] IPC handlers registered')

  console.log('[main] creating cockpit window...')
  createCockpitWindow()

  console.log('[main] starting live data...')
  liveData.start()
  console.log('[main] live data started')

  console.log('[main] starting climate monitor...')
  climateMonitor.start()
  console.log('[main] climate monitor started')

  console.log('[main] starting prediction engine...')
  climateMonitor.setPredictionEngine?.(predictionEngine)
  predictionEngine.start()
  console.log('[main] prediction engine started')

  console.log('[main] starting grid monitor...')
  gridMonitor.start()
  console.log('[main] grid monitor started')

  console.log('[main] starting network monitor...')
  networkMonitor.start()
  console.log('[main] network monitor started')

  console.log('[main] initializing VR manager...')
  vrManager.init()
  console.log('[main] VR manager initialized')

  console.log('[main] starting CLIP server...')
  startClipServer()
  console.log('[main] CLIP server start requested')

  // Initialize HAL — log hardware capabilities
  import('./services/hal/hal-manager').then(({ halManager }) => {
    console.log(halManager.summary())
  })

  // Bound on-disk caches — DEM + imagery tiles grow unbounded otherwise.
  // Evict at startup and once a day while the app runs.
  const evictCaches = () => {
    import('./services/tile-cache').then(({ TileCache }) =>
      TileCache.evict(1024 * 1024 * 1024, 45).catch((e) => console.warn('[cache] evict failed:', e)))
    import('./services/dem-tiles').then(({ evictDemCache }) => evictDemCache())
  }
  setTimeout(evictCaches, 30_000)
  setInterval(evictCaches, 24 * 60 * 60 * 1000)
})

app.on('window-all-closed', () => {
  console.log('[main] window-all-closed — stopping services and quitting')
  liveData.stop()
  climateMonitor.stop()
  predictionEngine.stop()
  gridMonitor.stop()
  networkMonitor.stop()
  vrManager.shutdown()
  stopClipServer()
  if (process.platform !== 'darwin') app.quit()
})

// Catch uncaught errors in main process
process.on('uncaughtException', (err) => {
  console.error('[main] UNCAUGHT EXCEPTION:', err)
})
process.on('unhandledRejection', (reason) => {
  console.error('[main] UNHANDLED REJECTION:', reason)
})
