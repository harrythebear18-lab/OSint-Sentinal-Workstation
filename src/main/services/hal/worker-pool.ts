/**
 * Worker Pool — real CPU parallelism via worker_threads.
 *
 * Spawns a pool of OS threads (one per logical core by default) and
 * dispatches tasks to them. Uses SharedArrayBuffer + Atomics for
 * zero-copy data transfer where possible.
 *
 * This is NOT a Promise queue. Each worker is a real OS thread
 * scheduled by the kernel. Tasks run in true parallel.
 *
 * Usage:
 *   const pool = getWorkerPool()
 *   const result = await pool.exec('dem-slope', { grid: sharedBuffer, width, height })
 *
 * Workers live in src/main/services/hal/workers/ and are loaded by path.
 */

import { Worker, isMainThread, parentPort, workerData } from 'worker_threads'
import { availableParallelism } from 'os'
import { join } from 'path'
import { existsSync, readdirSync } from 'fs'

export interface WorkerTask {
  type: string
  data: unknown
  /** Transferable objects (ArrayBuffer, MessagePort) to transfer (not copy) */
  transferList?: (ArrayBuffer | MessagePort)[]
}

export interface WorkerResult {
  ok: boolean
  data?: unknown
  error?: string
  durationMs: number
}

type PendingTask = {
  resolve: (result: WorkerResult) => void
  reject: (error: Error) => void
  task: WorkerTask
  startTime: number
}

interface PoolWorker {
  worker: Worker
  busy: boolean
  currentTask: PendingTask | null
}

class WorkerPool {
  private workers: PoolWorker[] = []
  private queue: PendingTask[] = []
  private maxWorkers: number
  private initialized = false
  private taskHandlers: Map<string, string> = new Map() // task type → worker script path

  constructor() {
    // Cap at half the logical cores (min 2, max 6) — the worker pool must
    // never saturate the machine. Cesium, main, and the OS all need cores.
    this.maxWorkers = Math.max(2, Math.min(6, Math.ceil(availableParallelism() / 2)))
  }

  /** Initialize the pool — spawns worker threads. Call once on app startup. */
  init(): void {
    if (this.initialized) return
    this.initialized = true

    // Discover available worker scripts
    const workersDir = join(__dirname, 'workers')
    if (existsSync(workersDir)) {
      for (const file of readdirSync(workersDir)) {
        if (file.endsWith('.worker.js') || file.endsWith('.worker.ts')) {
          const name = file.replace(/\.worker\.(js|ts)$/, '')
          this.taskHandlers.set(name, join(workersDir, file))
        }
      }
    }

    // Spawn workers
    for (let i = 0; i < this.maxWorkers; i++) {
      this.spawnWorker(i)
    }

    console.log(`[hal/worker-pool] initialized: ${this.maxWorkers} workers, ${this.taskHandlers.size} task types`)
  }

  private spawnWorker(index: number): void {
    // Each worker is a generic executor that loads task scripts on demand
    const workerScript = `
      const { parentPort, workerData } = require('worker_threads');
      const path = require('path');
      const fs = require('fs');

      const handlers = new Map();

      // Load all .worker.js files in the workers directory
      const workersDir = ${JSON.stringify(join(__dirname, 'workers'))};
      if (fs.existsSync(workersDir)) {
        for (const file of fs.readdirSync(workersDir)) {
          if (file.endsWith('.worker.js')) {
            const name = file.replace(/\\.worker\\.js$/, '');
            try {
              handlers.set(name, require(path.join(workersDir, file)));
            } catch (e) {
              console.error('Failed to load worker', file, e.message);
            }
          }
        }
      }

      parentPort.on('message', async (msg) => {
        const { id, type, data, transferList } = msg;
        const handler = handlers.get(type);
        if (!handler) {
          parentPort.postMessage({ id, ok: false, error: 'No handler for: ' + type });
          return;
        }
        const start = Date.now();
        try {
          const result = await handler(data, { transferList });
          parentPort.postMessage({
            id, ok: true, data: result,
            durationMs: Date.now() - start,
          }, result?.transferList);
        } catch (e) {
          parentPort.postMessage({
            id, ok: false, error: e.message,
            durationMs: Date.now() - start,
          });
        }
      });
    `

    const worker = new Worker(workerScript, { eval: true })
    const poolWorker: PoolWorker = { worker, busy: false, currentTask: null }

    worker.on('message', (msg: any) => {
      if (!poolWorker.currentTask) return
      const task = poolWorker.currentTask
      poolWorker.busy = false
      poolWorker.currentTask = null

      if (msg.ok) {
        task.resolve({ ok: true, data: msg.data, durationMs: msg.durationMs })
      } else {
        task.resolve({ ok: false, error: msg.error, durationMs: msg.durationMs })
      }

      // Dispatch next queued task
      this.dispatchNext()
    })

    worker.on('error', (err) => {
      console.error(`[hal/worker-pool] worker ${index} error:`, err.message)
      if (poolWorker.currentTask) {
        const task = poolWorker.currentTask
        poolWorker.busy = false
        poolWorker.currentTask = null
        task.reject(err)
      }
      // Respawn
      this.spawnWorker(index)
    })

    worker.on('exit', (code) => {
      if (code !== 0) {
        console.warn(`[hal/worker-pool] worker ${index} exited with code ${code}`)
      }
    })

    this.workers[index] = poolWorker
  }

  /** Execute a task on the worker pool. Returns when a worker finishes. */
  exec(type: string, data: unknown, transferList?: (ArrayBuffer | MessagePort)[]): Promise<WorkerResult> {
    if (!this.initialized) this.init()

    return new Promise((resolve, reject) => {
      const task: PendingTask = {
        resolve,
        reject,
        task: { type, data, transferList },
        startTime: Date.now(),
      }
      this.queue.push(task)
      this.dispatchNext()
    })
  }

  private dispatchNext(): void {
    if (this.queue.length === 0) return

    // Find a free worker
    const freeWorker = this.workers.find((w) => !w.busy)
    if (!freeWorker) return

    const task = this.queue.shift()!
    freeWorker.busy = true
    freeWorker.currentTask = task

    freeWorker.worker.postMessage({
      id: Date.now() + Math.random(),
      type: task.task.type,
      data: task.task.data,
    }, task.task.transferList as any)
  }

  /** Allocate a SharedArrayBuffer for zero-copy data transfer. */
  allocShared(byteLength: number): SharedArrayBuffer {
    return new SharedArrayBuffer(byteLength)
  }

  /** Get pool stats for monitoring. */
  stats(): { total: number; busy: number; queued: number } {
    return {
      total: this.workers.length,
      busy: this.workers.filter((w) => w.busy).length,
      queued: this.queue.length,
    }
  }

  /** Shutdown all workers gracefully. */
  shutdown(): void {
    for (const w of this.workers) {
      try { w.worker.terminate() } catch { /* ignore */ }
    }
    this.workers = []
    this.initialized = false
  }
}

// Singleton
let pool: WorkerPool | null = null

export function getWorkerPool(): WorkerPool {
  if (!pool) {
    pool = new WorkerPool()
    pool.init()
  }
  return pool
}

export function shutdownWorkerPool(): void {
  if (pool) {
    pool.shutdown()
    pool = null
  }
}
