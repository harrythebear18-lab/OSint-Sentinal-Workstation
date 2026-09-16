/**
 * WASM SIMD Loader — instantiates the precompiled simd-kernels.wasm
 * and exposes typed wrappers for each kernel.
 *
 * The .wasm binary is compiled from simd-kernels.wat by
 * scripts/compile-wasm.mjs (uses the `wabt` npm package).
 *
 * Kernels exposed:
 *   band_math(count, aOff, bOff, outOff)  — f32x4 SIMD, 4 floats/iter
 *   box_blur(width, height, inOff, outOff)  — scalar f32, 3x3
 *   slope(width, height, inOff, outOff, cellSize)  — scalar f32, Horn's method
 *   hillshade(width, height, inOff, outOff, cellSize, cosZen, sinZen, cosAz, sinAz)
 *
 * Memory layout (caller-managed via memory buffer):
 *   The WASM module exports its linear memory. Callers write input
 *   data into the memory at chosen offsets, call a kernel, then read
 *   the output from the output offset.
 *
 *   For a grid of N float32 values:
 *     Band A:  offset 0           .. N*4
 *     Band B:  offset N*4         .. N*8
 *     Output:  offset N*8         .. N*12
 *
 *   Maximum grid: 256×256 = 65536 floats × 4 bytes = 256KB per buffer.
 *   The module declares 16 pages = 1MB, enough for 3 buffers + headroom.
 */

let instance: WebAssembly.Instance | null = null
let memory: WebAssembly.Memory | null = null
let heapOffset = 0 // simple bump allocator

/** WASM function signatures. */
interface WasmExports {
  memory: WebAssembly.Memory
  band_math: (count: number, aOff: number, bOff: number, outOff: number) => void
  box_blur: (width: number, height: number, inOff: number, outOff: number) => void
  slope: (width: number, height: number, inOff: number, outOff: number, cellSize: number) => void
  hillshade: (
    width: number, height: number, inOff: number, outOff: number,
    cellSize: number, cosZen: number, sinZen: number, cosAz: number, sinAz: number,
  ) => void
}

let exports: WasmExports | null = null

/** Load and instantiate the WASM module. Call once at startup. */
export async function initWasmSimd(): Promise<boolean> {
  if (instance) return true

  try {
    // Try multiple paths: Vite dev server, production build, and file:// fallback
    let wasmBytes: ArrayBuffer | null = null

    // Resolve from the app HTML (globe/index.html), which is one level below
    // the renderer root in dev and prod. public/simd-kernels.wasm lives at the
    // Vite/Electron root, so "../../../" walks from globe/ to the app root.
    const base = typeof window !== 'undefined' ? window.location.href : import.meta.url
    const wasmUrl = new URL('../../../simd-kernels.wasm', base)
    const response = await fetch(wasmUrl)
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${wasmUrl}`)
    wasmBytes = await response.arrayBuffer()

    if (!wasmBytes) throw new Error('Could not load simd-kernels.wasm from any path')

    // Instantiate with SIMD support
    const result = await WebAssembly.instantiate(wasmBytes, {})
    instance = result.instance
    memory = instance.exports.memory as WebAssembly.Memory
    exports = instance.exports as unknown as WasmExports

    console.log(`[wasm-simd] loaded — ${wasmBytes.byteLength} bytes, ${memory.buffer.byteLength} memory`)
    return true
  } catch (err) {
    console.warn('[wasm-simd] failed to load:', err)
    return false
  }
}

/** Check if WASM SIMD is loaded and ready. */
export function isWasmReady(): boolean {
  return exports !== null && memory !== null
}

/**
 * Allocate `bytes` bytes from the WASM linear memory (bump allocator).
 * Returns the byte offset. Memory is never freed (reset per computation).
 */
export function alloc(bytes: number): number {
  if (!exports || !memory) throw new Error('WASM not initialized')
  // Align to 16 bytes for v128.load alignment
  heapOffset = Math.ceil(heapOffset / 16) * 16
  const off = heapOffset
  heapOffset += bytes

  // Grow memory if needed (each page = 64KB)
  const needed = heapOffset
  const current = memory.buffer.byteLength
  if (needed > current) {
    const pagesNeeded = Math.ceil((needed - current) / 65536)
    memory.grow(pagesNeeded)
  }

  return off
}

/** Reset the heap allocator (call before each computation). */
export function resetHeap(): void {
  heapOffset = 0
}

/** Write a Float32Array into WASM memory at the given offset. */
export function writeF32(data: Float32Array, offset: number): void {
  if (!memory) throw new Error('WASM not initialized')
  const view = new Float32Array(memory.buffer, offset, data.length)
  view.set(data)
}

/** Read a Float32Array from WASM memory at the given offset. */
export function readF32(offset: number, length: number): Float32Array {
  if (!memory) throw new Error('WASM not initialized')
  const view = new Float32Array(memory.buffer, offset, length)
  return new Float32Array(view) // copy
}

// ── High-level kernel wrappers ──

/**
 * Compute band math (NDVI/NDWI/NBR): (A - B) / (A + B).
 * Uses f32x4 SIMD — processes 4 floats per iteration.
 *
 * @param bandA  Input band A (e.g. NIR)
 * @param bandB  Input band B (e.g. Red)
 * @returns      Output Float32Array, same length as input
 */
export function wasmBandMath(bandA: Float32Array, bandB: Float32Array): Float32Array {
  if (!exports) throw new Error('WASM not initialized')
  resetHeap()

  const count = bandA.length
  const aOff = alloc(count * 4)
  const bOff = alloc(count * 4)
  const outOff = alloc(count * 4)

  writeF32(bandA, aOff)
  writeF32(bandB, bOff)

  // band_math processes `count` float32 values (count must be multiple of 4
  // for full SIMD lanes; remainder is handled by the loop condition)
  const simdCount = Math.floor(count / 4) * 4 * 4 // bytes for SIMD portion
  exports.band_math(simdCount, aOff, bOff, outOff)

  // Handle remainder (count not divisible by 4) with scalar fallback
  if (count % 4 !== 0) {
    const view = new Float32Array(memory!.buffer, outOff, count)
    for (let i = Math.floor(count / 4) * 4; i < count; i++) {
      const a = bandA[i]
      const b = bandB[i]
      view[i] = (a - b) / (a + b + 1e-10)
    }
  }

  return readF32(outOff, count)
}

/**
 * Compute 3x3 box blur (for anomaly detection).
 *
 * @param input   Input grid (width × height floats)
 * @param width   Grid width
 * @param height  Grid height
 * @returns       Blurred Float32Array
 */
export function wasmBoxBlur(input: Float32Array, width: number, height: number): Float32Array {
  if (!exports) throw new Error('WASM not initialized')
  resetHeap()

  const count = width * height
  const inOff = alloc(count * 4)
  const outOff = alloc(count * 4)

  writeF32(input, inOff)
  exports.box_blur(width, height, inOff, outOff)

  return readF32(outOff, count)
}

/**
 * Compute terrain slope using Horn's method.
 * Returns gradient magnitude (sqrt(dzdx² + dzdy²)).
 *
 * @param dem       Input DEM elevation grid
 * @param width     Grid width
 * @param height    Grid height
 * @param cellSize  Cell size in meters
 * @returns         Slope magnitude Float32Array
 */
export function wasmSlope(dem: Float32Array, width: number, height: number, cellSize: number): Float32Array {
  if (!exports) throw new Error('WASM not initialized')
  resetHeap()

  const count = width * height
  const inOff = alloc(count * 4)
  const outOff = alloc(count * 4)

  writeF32(dem, inOff)
  exports.slope(width, height, inOff, outOff, cellSize)

  return readF32(outOff, count)
}

/**
 * Compute hillshade using Horn's method with sun position.
 * Uses algebraic identities to avoid trig in WASM — the 4 sun
 * constants are precomputed in JS.
 *
 * @param dem        Input DEM elevation grid
 * @param width      Grid width
 * @param height     Grid height
 * @param cellSize   Cell size in meters
 * @param azimuth    Sun azimuth in degrees (0=N, 360=full circle)
 * @param elevation  Sun elevation in degrees (0=horizon, 90=zenith)
 * @returns          Hillshade Float32Array (0-255)
 */
export function wasmHillshade(
  dem: Float32Array, width: number, height: number, cellSize: number,
  azimuth: number, elevation: number,
): Float32Array {
  if (!exports) throw new Error('WASM not initialized')
  resetHeap()

  const count = width * height
  const inOff = alloc(count * 4)
  const outOff = alloc(count * 4)

  writeF32(dem, inOff)

  // Precompute sun constants in JS (trig done here, not in WASM)
  const deg2rad = Math.PI / 180
  const zenith = (90 - elevation) * deg2rad
  const azRad = (360 - azimuth) * deg2rad
  const cosZen = Math.cos(zenith)
  const sinZen = Math.sin(zenith)
  const cosAz = Math.cos(azRad)
  const sinAz = Math.sin(azRad)

  exports.hillshade(width, height, inOff, outOff, cellSize, cosZen, sinZen, cosAz, sinAz)

  return readF32(outOff, count)
}
