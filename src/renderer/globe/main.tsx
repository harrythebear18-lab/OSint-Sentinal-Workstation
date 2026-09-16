/// <reference types="vite/client" />

import { createRoot } from 'react-dom/client'
import App from './App'

console.log('═══════════════════════════════════════════════════')
console.log('  OSINT SENTINEL WORKSTATION — RENDERER START')
console.log('═══════════════════════════════════════════════════')
console.log('[renderer] location:', location.href)
console.log('[renderer] CESIUM_BASE_URL:', (window as any).CESIUM_BASE_URL)
console.log('[renderer] window.api exists:', typeof (window as any).api)
if ((window as any).api) {
  console.log('[renderer] api keys:', Object.keys((window as any).api))
}
console.log('[renderer] root element:', document.getElementById('root'))

// Catch errors — but filter out Cesium tile 404s (normal during panning)
window.addEventListener('error', (e) => {
  const msg = e.error?.message ?? e.message ?? ''
  const file = e.filename ?? ''
  // Skip Cesium tile load failures — they're normal during panning
  if (file.includes('cesium') || msg.includes('404') || msg.includes('texture') || msg.includes('Failed to fetch')) {
    return
  }
  console.error('[renderer:window-error]', e.error ?? e.message, e.filename, e.lineno)
})
window.addEventListener('unhandledrejection', (e) => {
  const reason = String(e.reason ?? '')
  if (reason.includes('404') || reason.includes('tile') || reason.includes('Failed to fetch')) return
  console.error('[renderer:unhandled-rejection]', e.reason)
})

// Log beforeunload to detect crashes
window.addEventListener('beforeunload', () => {
  console.log('[renderer] beforeunload — page is being unloaded')
})

try {
  const root = document.getElementById('root')
  if (!root) {
    console.error('[renderer] FATAL: #root element not found!')
  } else {
    console.log('[renderer] creating React root...')
    createRoot(root).render(<App />)
    console.log('[renderer] React root created')
  }
} catch (e) {
  console.error('[renderer] FATAL: React mount failed:', e)
}

// Plugin test harness — exposed for manual dev-console runs
;(window as any).runPluginTests = async (options?: any) => {
  const { runPluginTests } = await import('./plugins/plugin-harness')
  return runPluginTests(options)
}
