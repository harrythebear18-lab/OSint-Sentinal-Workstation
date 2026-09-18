/**
 * Compute Fallback (Main Process) — CPU worker pool handler for compute:task IPC.
 *
 * Listens on the compute:task IPC channel and routes to the worker pool.
 * This keeps existing CPU workers fully valid — they're now behind a clean contract.
 *
 * When the renderer dispatcher can't use WebGPU (unavailable or grid too small),
 * it falls back to this handler, which dispatches to the real OS thread pool.
 */

import { ipcMain } from 'electron'
import { getWorkerPool } from './hal/worker-pool'
import {
  type ComputeTask,
  type ComputePayload,
  type ComputeResponse,
  WORKER_TASK_MAP,
} from '@shared/compute-contract'

/**
 * Register the compute:task IPC handler.
 * Call once during app startup from registerIpcHandlers().
 */
export function registerComputeFallback(): void {
  ipcMain.handle('compute:task', async (_event, request: { task: ComputeTask; payload: ComputePayload }) => {
    const { task, payload } = request
    const start = Date.now()

    try {
      const workerTaskName = WORKER_TASK_MAP[task]
      if (!workerTaskName) {
        return {
          output: [],
          backend: 'noop' as const,
          durationMs: Date.now() - start,
          width: payload.width,
          height: payload.height,
        } satisfies ComputeResponse
      }

      const pool = getWorkerPool()

      // Convert input arrays back to Float32Array (IPC serializes to plain arrays)
      const input = payload.input instanceof Float32Array
        ? payload.input
        : new Float32Array(payload.input)

      const workerData: Record<string, unknown> = {
        elev: input,
        width: payload.width,
        height: payload.height,
      }

      // Task-specific params
      if (task === 'slope') {
        workerData.cellSizeX = payload.cellSizeX ?? payload.params?.[0] ?? 1
        workerData.cellSizeY = payload.cellSizeY ?? payload.params?.[1] ?? 1
      } else if (task === 'hillshade') {
        // Dispatcher sends degrees, worker expects radians
        const deg2rad = Math.PI / 180
        workerData.azimuth = (payload.params?.[0] ?? 315) * deg2rad
        workerData.altitude = (payload.params?.[1] ?? 45) * deg2rad
      } else if (task === 'anomaly') {
        workerData.blurRadius = payload.params?.[0] ?? 5
      } else if (task === 'runoff') {
        workerData.cellSize = payload.cellSizeX ?? payload.params?.[0] ?? 1
      }

      const result = await pool.exec(workerTaskName, workerData)

      if (result.ok && result.data) {
        // Extract the output array from worker result
        const data = result.data as Record<string, unknown>
        let outputArr: Float32Array | undefined

        // Different workers return different field names
        if (task === 'slope') outputArr = data.slope as Float32Array
        else if (task === 'hillshade') outputArr = data.hillshade as Float32Array
        else if (task === 'anomaly') outputArr = data.residuals as Float32Array
        else if (task === 'runoff') outputArr = data.filled as Float32Array
        else outputArr = data.output as Float32Array

        if (!outputArr) {
          console.warn(`[compute-fallback] worker returned no output for task ${task}`)
          return {
            output: [],
            backend: 'noop' as const,
            durationMs: Date.now() - start,
            width: payload.width,
            height: payload.height,
          } satisfies ComputeResponse
        }

        // Typed arrays structured-clone over IPC — no Array.from copy.
        const response: ComputeResponse = {
          output: outputArr,
          backend: 'cpu-worker',
          durationMs: result.durationMs,
          width: payload.width,
          height: payload.height,
        }

        console.log(`[compute-fallback] ${task} → worker "${workerTaskName}" — ${payload.width}x${payload.height} in ${result.durationMs}ms`)
        return response
      }

      // Worker failed
      console.warn(`[compute-fallback] worker ${workerTaskName} failed:`, result.error)
      return {
        output: [],
        backend: 'noop' as const,
        durationMs: Date.now() - start,
        width: payload.width,
        height: payload.height,
      } satisfies ComputeResponse
    } catch (e) {
      console.error(`[compute-fallback] ${task} error:`, e)
      return {
        output: [],
        backend: 'noop' as const,
        durationMs: Date.now() - start,
        width: payload.width,
        height: payload.height,
      } satisfies ComputeResponse
    }
  })

  console.log('[compute-fallback] registered compute:task IPC handler')
}
