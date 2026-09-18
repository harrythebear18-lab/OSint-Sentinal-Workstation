/**
 * Compute Dispatcher (Renderer) — routes compute tasks to the best backend.
 *
 * On startup:
 *   1. Probe WebGPU (compile all WGSL kernels)
 *   2. Probe WebCodecs (hardware image/video codecs)
 *   3. Register available backends
 *
 * API:
 *   const result = await computeDispatcher.dispatch("slope", payload)
 *
 * Internally:
 *   1. If WebGPU available + grid large enough → dispatch on GPU
 *   2. If not → IPC to main process → CPU worker pool
 *   3. If WASM SIMD ever lands → slot in as another backend
 *
 * No plugin cares how it ran — only that it did.
 */

import { gpuCompute, type ComputeKernel } from './gpu-compute'
import { webCodecs } from './webcodecs'
import { halLog } from './is-prod'
import { computeInline, type BenchSample } from './compute-bench'
import {
  initWasmSimd,
  isWasmReady,
  wasmBandMath,
  wasmSlope,
  wasmHillshade,
  wasmBoxBlur,
} from './wasm/wasm-loader'
import {
  type ComputeTask,
  type ComputePayload,
  type ComputeResult,
  type ComputeBackend,
  type ComputeStats,
  type BackendCapabilities,
  KERNEL_MAP,
  GPU_MIN_CELLS,
} from '@shared/compute-contract'

class ComputeDispatcher {
  private capabilities: BackendCapabilities = {
    webgpu: false,
    cpuWorker: true, // always available via IPC
    wasmSimd: false,
    webcodecs: false,
  }
  private stats: ComputeStats[] = []
  private maxStats = 100
  private initialized = false

  /** Initialize — probe all backends. Call on app startup. */
  async init(): Promise<void> {
    if (this.initialized) return
    this.initialized = true

    // Probe WebGPU
    this.capabilities.webgpu = await gpuCompute.init()

    // Probe WebCodecs
    this.capabilities.webcodecs = webCodecs.probe()

    // Probe WASM SIMD — compile a minimal module with a v128.const instruction
    try {
      const testModule = new WebAssembly.Module(new Uint8Array([
        0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
        0x01, 0x04, 0x01, 0x60, 0x00, 0x00,
        0x03, 0x02, 0x01, 0x00,
        0x07, 0x08, 0x01, 0x04, 0x73, 0x69, 0x6d, 0x64, 0x00, 0x00,
        0x0a, 0x17, 0x01, 0x15, 0x00,
        0xfd, 0x0c,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x1a, 0x0b,
      ]))
      new WebAssembly.Instance(testModule)
      this.capabilities.wasmSimd = true
    } catch {
      this.capabilities.wasmSimd = false
    }

    // Load the full WASM SIMD kernel module (band_math, slope, hillshade, box_blur)
    if (this.capabilities.wasmSimd) {
      const loaded = await initWasmSimd()
      if (!loaded) {
        this.capabilities.wasmSimd = false
        halLog.warn('[hal/dispatcher] WASM SIMD probe passed but kernel module failed to load')
      }
    }

    halLog.log(`[hal/dispatcher] backends: webgpu=${this.capabilities.webgpu}, cpuWorker=${this.capabilities.cpuWorker}, wasmSimd=${this.capabilities.wasmSimd}, webcodecs=${this.capabilities.webcodecs}`)
  }

  /** Get current backend capabilities. */
  getCapabilities(): BackendCapabilities {
    return { ...this.capabilities }
  }

  /**
   * Dispatch a compute task to the best available backend.
   *
   * @param task What to compute (slope, hillshade, anomaly, etc.)
   * @param payload Input data + dimensions + params
   * @returns Result with output buffer, backend tag, and timing
   */
  async dispatch(task: ComputeTask, payload: ComputePayload): Promise<ComputeResult> {
    const cellCount = payload.width * payload.height
    const start = performance.now()

    // Try preferred backend first, then fall back in priority order.
    const priority = this.selectBackendPriority(task, payload)

    for (const backend of priority) {
      try {
        const result = await this.dispatchBackend(task, payload, backend)
        this.recordStats(task, result.backend, result.durationMs, cellCount)
        halLog.log(`[hal/dispatcher] ${task} → ${result.backend} — ${cellCount} cells in ${result.durationMs.toFixed(1)}ms`)
        return result
      } catch (e) {
        halLog.warn(`[hal/dispatcher] ${task} backend ${backend} failed, trying next`, e)
      }
    }

    // Nothing succeeded — record as noop
    const durationMs = performance.now() - start
    this.recordStats(task, 'noop', durationMs, cellCount)
    halLog.warn(`[hal/dispatcher] ${task} → all backends failed`)
    return {
      output: new Float32Array(cellCount),
      backend: 'noop',
      durationMs,
      task,
      width: payload.width,
      height: payload.height,
    }
  }

  /**
   * Threshold-based backend selection.
   *
   *   < 128×128   → inline JS (GPU dispatch overhead dominates)
   *   >= 128×128  → WebGPU → WASM SIMD → worker → inline
   */
  private selectBackendPriority(task: ComputeTask, payload: ComputePayload): ComputeBackend[] {
    const cellCount = payload.width * payload.height
    const small: ComputeBackend[] = ['cpu-inline']
    const medium: ComputeBackend[] = []
    // GPU first even at medium sizes — a ~1ms dispatch beats serializing
    // 16K+ cells through IPC to the worker pool.
    if (this.canRunBackend('webgpu', task, payload)) medium.push('webgpu')
    if (this.canRunBackend('wasm-simd', task, payload)) medium.push('wasm-simd')
    if (this.canRunBackend('cpu-worker', task, payload)) medium.push('cpu-worker')
    medium.push('cpu-inline')

    const large: ComputeBackend[] = []
    if (this.canRunBackend('webgpu', task, payload)) large.push('webgpu')
    if (this.canRunBackend('wasm-simd', task, payload)) large.push('wasm-simd')
    if (this.canRunBackend('cpu-worker', task, payload)) large.push('cpu-worker')
    large.push('cpu-inline')

    if (cellCount < 128 * 128) return small
    if (cellCount < 512 * 512) return medium
    return large
  }

  /** Check if WebGPU is available for a given grid size. */
  shouldUseGpu(width: number, height: number): boolean {
    return this.capabilities.webgpu && width * height >= GPU_MIN_CELLS
  }

  /**
   * Benchmark a workload across all available backends.
   *
   * For each eligible backend, the task is run once to warm up and then
   * `samples` times. Returns throughput (M cells/s), duration, and
   * per-sample timings. The `preferred` field is the suggested backend
   * for this workload.
   */
  async benchmark(
    task: ComputeTask,
    payload: ComputePayload,
    samples = 5,
  ): Promise<{
    results: Array<{ backend: ComputeBackend; durationMs: number; throughputMCells: number; samples: number[]; error?: string }>
    preferred: ComputeBackend
  }> {
    const results: Awaited<ReturnType<ComputeDispatcher['benchmark']>>['results'] = []
    const backends: ComputeBackend[] = ['webgpu', 'wasm-simd', 'cpu-worker', 'cpu-inline']

    for (const backend of backends) {
      if (!this.canRunBackend(backend, task, payload)) continue
      const timings: number[] = []
      let error: string | undefined

      try {
        // Warm-up
        await this.dispatchBackend(task, payload, backend)

        for (let i = 0; i < samples; i++) {
          const r = await this.dispatchBackend(task, payload, backend)
          timings.push(r.durationMs)
        }

        const avg = timings.reduce((a, b) => a + b, 0) / timings.length
        const cellCount = payload.width * payload.height
        const throughputMCells = (cellCount / avg) / 1_000_000
        results.push({ backend, durationMs: avg, throughputMCells, samples: timings })
      } catch (e) {
        error = String(e)
        results.push({ backend, durationMs: 0, throughputMCells: 0, samples: [], error })
      }
    }

    // Preferred backend: fastest above the CPU- (only if no errors)
    const successful = results.filter((r) => !r.error)
    const preferred = successful.length > 0
      ? successful.reduce((a, b) => (a.durationMs <= b.durationMs ? a : b)).backend
      : 'noop'

    return { results, preferred }
  }

  /** Dispatch to a specific backend (used for benchmarking). */
  private async dispatchBackend(task: ComputeTask, payload: ComputePayload, backend: ComputeBackend): Promise<ComputeResult> {
    const start = performance.now()
    const cellCount = payload.width * payload.height

    if (backend === 'webgpu') {
      const kernel = KERNEL_MAP[task] as ComputeKernel
      const inputs = payload.input2
        ? (payload.input3 ? [payload.input, payload.input2, payload.input3] : [payload.input, payload.input2])
        : [payload.input]
      // Convert hillshade params from degrees to radians for the GPU shader
      let uniforms = payload.params
      if (task === 'hillshade' && payload.params) {
        const deg2rad = Math.PI / 180
        uniforms = new Float32Array([payload.params[0] * deg2rad, payload.params[1] * deg2rad])
      }
      const result = await gpuCompute.execute(kernel, {
        width: payload.width,
        height: payload.height,
        input: inputs,
        uniforms,
        ramp: payload.ramp,
      })
      return {
        output: result.output,
        backend: 'webgpu',
        durationMs: result.durationMs,
        task,
        width: payload.width,
        height: payload.height,
      }
    }

    if (backend === 'wasm-simd') {
      let output: Float32Array | null = null
      if (task === 'ndvi' || task === 'ndwi' || task === 'nbr') {
        if (payload.input && payload.input2) output = wasmBandMath(payload.input, payload.input2)
      } else if (task === 'slope') {
        if (payload.input) output = wasmSlope(payload.input, payload.width, payload.height, payload.cellSizeX || 30)
      } else if (task === 'hillshade') {
        if (payload.input && payload.params) {
          output = wasmHillshade(payload.input, payload.width, payload.height, payload.cellSizeX || 30, payload.params[0] || 315, payload.params[1] || 45)
        }
      } else if (task === 'anomaly') {
        if (payload.input) output = wasmBoxBlur(payload.input, payload.width, payload.height)
      }
      if (!output) throw new Error('WASM SIMD cannot run this task')
      return {
        output,
        backend: 'wasm-simd',
        durationMs: performance.now() - start,
        task,
        width: payload.width,
        height: payload.height,
      }
    }

    if (backend === 'cpu-worker') {
      const response = await window.api.invoke('compute:task', {
        task,
        payload: {
          width: payload.width,
          height: payload.height,
          // Typed arrays structured-clone over IPC — no Array.from copy.
          input: payload.input,
          input2: payload.input2,
          input3: payload.input3,
          params: payload.params,
          cellSizeX: payload.cellSizeX,
          cellSizeY: payload.cellSizeY,
        },
      }) as { output: number[] | Float32Array; backend: ComputeBackend; durationMs: number; width: number; height: number } | null
      if (!response || !response.output) throw new Error('CPU worker returned empty')
      return {
        output: response.output instanceof Float32Array ? response.output : new Float32Array(response.output),
        backend: response.backend || 'cpu-worker',
        durationMs: performance.now() - start,
        task,
        width: response.width,
        height: response.height,
      }
    }

    // cpu-inline / noop
    if (backend === 'cpu-inline') {
      return computeInline(task, payload)
    }
    return {
      output: new Float32Array(cellCount),
      backend: 'noop',
      durationMs: performance.now() - start,
      task,
      width: payload.width,
      height: payload.height,
    }
  }

  private canRunBackend(backend: ComputeBackend, task: ComputeTask, payload: ComputePayload): boolean {
    const cellCount = payload.width * payload.height
    switch (backend) {
      case 'webgpu':
        return this.capabilities.webgpu && cellCount >= GPU_MIN_CELLS
      case 'wasm-simd':
        // Slope is excluded because the current WAT implementation returns
        // raw gradient magnitude, not degrees; hillshade/NDVI/band math are fine.
        return this.capabilities.wasmSimd && isWasmReady() && ['ndvi', 'ndwi', 'nbr', 'hillshade', 'anomaly'].includes(task)
      case 'cpu-worker':
        return this.capabilities.cpuWorker
      case 'cpu-inline':
        return true
      default:
        return false
    }
  }

  /** Get compute telemetry for HUD display. */
  getStats(): ComputeStats[] {
    return this.stats.slice(-20)
  }

  /** Get a summary of which backends are being used. */
  getBackendSummary(): Record<ComputeBackend, number> {
    const summary: Record<ComputeBackend, number> = {
      webgpu: 0,
      'wasm-simd': 0,
      'cpu-worker': 0,
      'cpu-inline': 0,
      noop: 0,
    }
    for (const s of this.stats) {
      summary[s.backend]++
    }
    return summary
  }

  private recordStats(task: ComputeTask, backend: ComputeBackend, durationMs: number, gridSize: number): void {
    this.stats.push({ task, backend, durationMs, gridSize, timestamp: Date.now() })
    if (this.stats.length > this.maxStats) {
      this.stats.shift()
    }
  }
}

export const computeDispatcher = new ComputeDispatcher()
