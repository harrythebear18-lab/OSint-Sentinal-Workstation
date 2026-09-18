/**
 * Compute Contract — the single shared definition for all HAL compute tasks.
 *
 * "A compute task goes in, a buffer comes out, backend is tagged."
 *
 * This is the ONE mental model for hardware compute in the workstation.
 * Plugins, services, and the dispatcher all speak this contract.
 * No plugin cares how it ran — only that it did.
 *
 * Flow:
 *   Plugin → computeDispatcher.dispatch(task, payload)
 *     → WebGPU kernel (if available + grid large enough)
 *     → CPU worker pool via IPC (if WebGPU unavailable)
 *     → CPU inline (last resort)
 *   ← ComputeResult { output, backend, durationMs }
 */

// ── Tasks ──

export type ComputeTask =
  | 'slope'        // DEM slope (Horn's method) — per-pixel gradient
  | 'hillshade'    // DEM hillshade — per-pixel light/shadow
  | 'anomaly'      // Terrain anomaly — deviation from baseline
  | 'runoff'       // Priority-Flood depression filling
  | 'ndvi'         // Sentinel-2 NDVI (NIR - Red) / (NIR + Red)
  | 'ndwi'         // Sentinel-2 NDWI (Green - NIR) / (Green + NIR)
  | 'nbr'          // Sentinel-2 NBR (NIR - SWIR) / (NIR + SWIR)
  | 'color-transform' // Linear stretch / color mapping

// ── Backends ──

export type ComputeBackend =
  | 'webgpu'       // GPU compute shader (WGSL) — thousands of cores
  | 'wasm-simd'    // WebAssembly f32x4 SIMD — 4-wide vector units
  | 'cpu-worker'   // OS thread via worker_threads — real CPU parallelism
  | 'cpu-inline'   // Main thread JS — last resort fallback
  | 'noop'         // No-op (grid too small or feature disabled)

// ── Payload ──

export interface ComputePayload {
  /** Grid width in cells */
  width: number
  /** Grid height in cells */
  height: number
  /** Primary input data (elevation grid, NIR band, current frame, etc.) */
  input: Float32Array
  /** Secondary input for multi-band operations (red, green, SWIR, baseline, etc.) */
  input2?: Float32Array
  /** Tertiary input (for 3-band operations) */
  input3?: Float32Array
  /** Kernel-specific parameters:
   *  - slope: [cellSizeX, cellSizeY]
   *  - hillshade: [azimuth, altitude]
   *  - anomaly: [threshold]
   *  - runoff: [cellSize]
   */
  params?: Float32Array
  /** Cell size in meters (for slope/runoff calculations) */
  cellSizeX?: number
  cellSizeY?: number
  /** Color ramp for color-transform kernel: packed [value0, r0, g0, b0, value1, r1, g1, b1, ...] */
  ramp?: Float32Array
}

// ── Result ──

export interface ComputeResult {
  /** Output data as Float32Array (slope angles, hillshade values, NDVI, etc.) */
  output: Float32Array
  /** Which backend actually ran the computation */
  backend: ComputeBackend
  /** Wall-clock time including dispatch overhead */
  durationMs: number
  /** Which task was requested */
  task: ComputeTask
  /** Grid dimensions */
  width: number
  height: number
}

// ── IPC wire format (for main-process fallback) ──

export interface ComputeRequest {
  task: ComputeTask
  payload: ComputePayload
}

export interface ComputeResponse {
  /** Typed arrays structured-clone over IPC — Float32Array preferred, number[] accepted */
  output: number[] | Float32Array
  backend: ComputeBackend
  durationMs: number
  width: number
  height: number
}

// ── Telemetry ──

export interface ComputeStats {
  task: ComputeTask
  backend: ComputeBackend
  durationMs: number
  gridSize: number
  timestamp: number
}

// ── Backend capability map ──

export interface BackendCapabilities {
  webgpu: boolean
  cpuWorker: boolean
  wasmSimd: boolean
  webcodecs: boolean
}

// ── Kernel → WebGPU mapping ──

export const KERNEL_MAP: Record<ComputeTask, string> = {
  slope: 'dem-slope',
  hillshade: 'dem-hillshade',
  anomaly: 'anomaly',
  runoff: 'priority-flood',
  ndvi: 'ndvi',
  ndwi: 'ndwi',
  nbr: 'nbr',
  'color-transform': 'color-transform',
}

// ── Worker task name mapping ──

export const WORKER_TASK_MAP: Record<ComputeTask, string> = {
  slope: 'dem-slope',
  hillshade: 'dem-hillshade',
  anomaly: 'anomaly-blur',
  runoff: 'priority-flood',
  ndvi: 'dem-slope', // no dedicated worker — use GPU or inline
  ndwi: 'dem-slope',
  nbr: 'dem-slope',
  'color-transform': 'dem-slope',
}

// ── Grid size threshold: below this, CPU is faster (GPU dispatch overhead) ──

export const GPU_MIN_CELLS = 16384 // 128x128
