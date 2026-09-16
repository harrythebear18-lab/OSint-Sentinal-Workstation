/**
 * HAL Benchmark Plugin — measure WebGPU / WASM SIMD / CPU worker
 * for real compute workloads: NDVI, slope, hillshade, anomaly.
 *
 * This answers the question: which backend should the dispatcher
 * choose for a given workload size? It reports time to first result,
 * steady-state throughput (M cells/s), and fastest backend per task.
 */

import * as Cesium from 'cesium'
import type { EarthEnginePlugin, PluginContext, PluginStats, PluginControlSpec } from './plugin-manager'
import { computeDispatcher } from '../hal/compute-dispatcher'
import { makeBenchPayload, downloadReport, type BenchReport } from '../hal/compute-bench'
import type { ComputeTask, ComputePayload } from '@shared/compute-contract'

interface BenchmarkRun {
  workload: string
  width: number
  height: number
  results: Array<{ backend: string; durationMs: number; throughputMCells: number; error?: string }>
  preferred: string
  cesiumFps: number
}

const WORKLOADS: { label: string; task: ComputeTask; width: number; height: number }[] = [
  { label: 'NDVI 256x256', task: 'ndvi', width: 256, height: 256 },
  { label: 'NDVI 512x512', task: 'ndvi', width: 512, height: 512 },
  { label: 'Slope 512x512', task: 'slope', width: 512, height: 512 },
  { label: 'Hillshade 512x512', task: 'hillshade', width: 512, height: 512 },
  { label: 'Anomaly 256x256', task: 'anomaly', width: 256, height: 256 },
  { label: 'Anomaly 1024x1024', task: 'anomaly', width: 1024, height: 1024 },
]

export class BenchmarkPlugin implements EarthEnginePlugin {
  id = 'benchmark'
  name = 'HAL Benchmark'
  category = 'system' as const

  private status: PluginStats = { count: 0, status: 'nominal' }
  private running = false
  private runs: BenchmarkRun[] = []
  private cesiumFps = 0

  register(_ctx: PluginContext): void {
    this.status = { count: 0, status: 'nominal' }
  }

  unregister(): void {
    this.status = { count: 0, status: 'disabled' }
  }

  update(): void {
    this.cesiumFps = (window as any).__cesiumFps ?? 0
  }

  getStats(): PluginStats {
    return this.status
  }

  getControls(): PluginControlSpec[] {
    return [
      { type: 'button', id: 'run', label: this.running ? 'Running...' : 'Run Benchmarks', variant: 'primary', disabled: this.running },
      { type: 'button', id: 'clear', label: 'Clear Results', variant: 'danger', disabled: this.runs.length === 0 },
      { type: 'button', id: 'download', label: 'Download JSON', variant: 'default', disabled: this.runs.length === 0 },
      { type: 'separator', id: 'sep1' },
      { type: 'display', id: 'fps', label: 'Cesium FPS', value: this.cesiumFps.toFixed(0), color: this.cesiumFps > 50 ? '#4aff8a' : this.cesiumFps > 25 ? '#ffaa00' : '#ff4a4a' },
      { type: 'display', id: 'summary', label: 'Fastest', value: this.getFastestSummary(), color: '#4affd4' },
      ...this.runs.map((run, idx) => ({
        type: 'display' as const,
        id: `run-${idx}`,
        label: `${run.workload} (${run.width}x${run.height})`,
        value: `${run.preferred} ${this.formatThroughput(run.results.find((r) => r.backend === run.preferred)?.throughputMCells ?? 0)}`,
        color: this.preferredColor(run.preferred),
      })),
    ]
  }

  onControl(id: string): void {
    if (id === 'run') {
      this.runBenchmarks()
    } else if (id === 'clear') {
      this.runs = []
      this.status = { count: 0, status: 'nominal' }
    } else if (id === 'download') {
      this.downloadJson()
    }
  }

  private async runBenchmarks(): Promise<void> {
    if (this.running) return
    this.running = true
    this.runs = []
    this.status = { count: 0, status: 'loading' }

    for (const w of WORKLOADS) {
      const payload = makeBenchPayload(w.task, w.width, w.height)
      const run = await this.benchmarkOne(w.label, w.task, payload)
      this.runs.push(run)
      this.status = { count: this.runs.length, status: 'loading' }
      // Yield to let UI + Cesium breathe
      await new Promise((resolve) => setTimeout(resolve, 10))
    }

    this.running = false
    this.status = { count: this.runs.length, status: 'nominal' }
  }

  private async benchmarkOne(label: string, task: ComputeTask, payload: ComputePayload): Promise<BenchmarkRun> {
    const fps = (window as any).__cesiumFps ?? 0
    try {
      const { results, preferred } = await computeDispatcher.benchmark(task, payload, 5)
      return {
        workload: label,
        width: payload.width,
        height: payload.height,
        results: results.map((r) => ({
          backend: r.backend,
          durationMs: r.durationMs,
          throughputMCells: r.throughputMCells,
          error: r.error,
        })),
        preferred,
        cesiumFps: fps,
      }
    } catch (e) {
      return {
        workload: label,
        width: payload.width,
        height: payload.height,
        results: [],
        preferred: 'error',
        cesiumFps: fps,
      }
    }
  }

  private downloadJson(): void {
    const reports: BenchReport[] = this.runs.map((run) => ({
      workload: run.workload,
      task: this.guessTask(run.workload),
      width: run.width,
      height: run.height,
      cesiumFps: run.cesiumFps,
      results: run.results.map((r) => ({
        backend: this.mapBackend(r.backend),
        durationMs: r.durationMs,
        throughputMCells: r.throughputMCells,
        samples: [],
        error: r.error,
      })),
      preferred: this.mapBackend(run.preferred),
      generatedAt: new Date().toISOString(),
    }))
    downloadReport(reports)
  }

  private guessTask(workload: string): ComputeTask {
    const name = workload.split('_')[0].toLowerCase()
    return name as ComputeTask
  }

  private mapBackend(b: string): 'inline' | 'worker' | 'wasm-simd' | 'webgpu' {
    if (b === 'cpu-inline') return 'inline'
    if (b === 'cpu-worker') return 'worker'
    if (b === 'wasm-simd') return 'wasm-simd'
    if (b === 'webgpu') return 'webgpu'
    return 'inline'
  }

  private getFastestSummary(): string {
    if (this.runs.length === 0) return '—'
    const fastest = this.runs.reduce((a, b) => {
      const at = a.results.find((r) => r.backend === a.preferred)?.throughputMCells ?? 0
      const bt = b.results.find((r) => r.backend === b.preferred)?.throughputMCells ?? 0
      return at > bt ? a : b
    })
    return `${fastest.preferred}`
  }

  private formatThroughput(m: number): string {
    return m > 0 ? `${m.toFixed(1)}M cells/s` : '—'
  }

  private preferredColor(backend: string): string {
    if (backend === 'webgpu') return '#4aff8a'
    if (backend === 'wasm-simd') return '#4affd4'
    if (backend === 'cpu-worker') return '#ffaa00'
    if (backend === 'cpu-inline') return '#ff4a4a'
    return '#6b7d92'
  }
}

export const benchmarkPlugin = new BenchmarkPlugin()
