/**
 * Post-build obfuscation pass for the full release version.
 *
 * Runs after `npm run build` (production) and before `electron-builder`.
 * Obfuscates the main, preload, and renderer bundles while keeping
 * class/function names and critical globals intact so Cesium, WebGPU,
 * and the plugin registry still boot.
 *
 * Targets:
 *   - out/main/index.js
 *   - out/preload/index.js
 *   - out/renderer/assets/globe-*.js
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import JavaScriptObfuscator from 'javascript-obfuscator'

const outDir = resolve('out')

const reservedNames = [
  'Cesium', 'cesium',
  'window', 'document', 'navigator', 'console',
  'require', 'exports', 'module', '__dirname', '__filename',
  'process', 'Buffer', 'global',
  'WebAssembly', 'WebGPU', 'GPUCanvasContext',
  'performance', 'fetch', 'Request', 'Response', 'Headers',
]

const baseOptions = {
  compact: true,
  controlFlowFlattening: false,
  deadCodeInjection: false,
  debugProtection: false,
  disableConsoleOutput: false, // Terser already handles console stripping; obfuscator should not interfere
  identifierNamesGenerator: 'mangled-shuffled',
  keepFnames: true,
  keepClassNames: true,
  numbersToExpressions: true,
  renameGlobals: false,
  reservedNames,
  reservedStrings: reservedNames,
  rotateStringArray: true,
  selfDefending: false,
  shuffleStringArray: true,
  splitStrings: true,
  splitStringsChunkLength: 20,
  stringArray: true,
  stringArrayEncoding: ['base64'],
  stringArrayThreshold: 0.5,
  stringArrayWrappersCount: 1,
  transformObjectKeys: false,
  unicodeEscapeSequence: false,
}

function obfuscateFile(filePath, extraOptions = {}) {
  const code = readFileSync(filePath, 'utf8')
  const obfuscationResult = JavaScriptObfuscator.obfuscate(code, {
    ...baseOptions,
    ...extraOptions,
  })
  writeFileSync(filePath, obfuscationResult.getObfuscatedCode())
  const originalSize = Buffer.byteLength(code, 'utf8')
  const newSize = Buffer.byteLength(obfuscationResult.getObfuscatedCode(), 'utf8')
  console.log(`[obfuscate] ${filePath.replace(outDir, 'out')} ${(originalSize / 1024).toFixed(1)} kB → ${(newSize / 1024).toFixed(1)} kB`)
}

function findGlobeBundle() {
  const assetsDir = join(outDir, 'renderer', 'assets')
  if (!existsSync(assetsDir)) return null
  const files = readdirSync(assetsDir)
  const globe = files.find((f) => f.startsWith('globe-') && f.endsWith('.js'))
  return globe ? join(assetsDir, globe) : null
}

const targets = [
  { path: join(outDir, 'main', 'index.js'), label: 'main' },
  { path: join(outDir, 'preload', 'index.js'), label: 'preload' },
]

// NOTE: We intentionally do NOT obfuscate the renderer bundle. It contains
// Cesium + WebGPU shaders + Web Workers, and `javascript-obfuscator`'s
// string-array / split-string transforms can break Cesium's runtime string
// literals (worker source URLs, new Function(...) snippets, etc.).
// Main and preload hold HAL, services, and IPC — that is the real surface
// we want to harden.

for (const { path: filePath, label } of targets) {
  if (!existsSync(filePath)) {
    console.warn(`[obfuscate] ${label} bundle not found: ${filePath}`)
    continue
  }

  // Use a lighter string-array threshold on the massive Cesium-infused renderer bundle
  // to keep startup time and memory reasonable.
  const extraOptions = label === 'renderer' ? { stringArrayThreshold: 0.2 } : {}
  obfuscateFile(filePath, extraOptions)
}

console.log('[obfuscate] done')
