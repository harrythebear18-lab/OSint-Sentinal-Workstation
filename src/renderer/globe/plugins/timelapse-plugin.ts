/**
 * Timelapse Plugin — satellite imagery timelapse export.
 *
 * Captures the Cesium globe view over time and encodes it as a
 * WebM video using hardware-accelerated WebCodecs VideoEncoder.
 *
 * The user can:
 *   1. Set FPS, duration, and quality
 *   2. Click "Record" to start capturing
 *   3. Animate the camera (orbit, fly-to, or manual)
 *   4. Click "Stop & Save" to finalize and save to disk
 *
 * The encoder uses `hardwareAcceleration: 'prefer-hardware'` which
 * routes to NVENC/QuickSync/VAAPI when available.
 *
 * This is real hardware video encoding — not software fallback.
 */

import * as Cesium from 'cesium'
import type { EarthEnginePlugin, PluginContext, PluginStats, PluginControlSpec } from './plugin-manager'
import { TimelapseExporter, type TimelapseOptions } from '../hal/timelapse-exporter'

type RecordState = 'idle' | 'recording' | 'encoding' | 'done' | 'error'

export class TimelapsePlugin implements EarthEnginePlugin {
  id = 'timelapse'
  name = 'Timelapse Export (WebCodecs VideoEncoder)'
  category = 'media' as const

  private viewer: Cesium.Viewer | null = null
  private exporter: TimelapseExporter | null = null
  private status: PluginStats = { count: 0, status: 'disabled' }

  // Recording state
  private recordState: RecordState = 'idle'
  private framesCaptured = 0
  private framesEncoded = 0
  private elapsedMs = 0
  private statusTimer: ReturnType<typeof setInterval> | null = null

  // Settings
  private fps = 30
  private durationSec = 10
  private bitrate = 5_000_000 // 5 Mbps
  private orbitMode = false
  private orbitSpeed = 0.5 // degrees per frame
  private originalCamera: { lon: number; lat: number; height: number } | null = null

  async register(ctx: PluginContext): Promise<void> {
    this.viewer = ctx.viewer
    this.exporter = new TimelapseExporter(ctx.viewer)

    if (!this.exporter.isSupported()) {
      this.status = { count: 0, status: 'error', error: 'WebCodecs VideoEncoder not available' }
      console.warn('[timelapse] VideoEncoder not available — plugin disabled')
    } else {
      this.status = { count: 0, status: 'nominal' }
      console.log('[timelapse] VideoEncoder available — plugin ready')
    }
  }

  unregister(): void {
    if (this.statusTimer) {
      clearInterval(this.statusTimer)
      this.statusTimer = null
    }
    if (this.exporter && this.recordState === 'recording') {
      this.exporter.cancel()
    }
    this.exporter = null
    this.viewer = null
    this.status = { count: 0, status: 'disabled' }
  }

  update(_ctx: PluginContext): void {
    // Orbit the camera if enabled
    if (this.orbitMode && this.recordState === 'recording' && this.viewer) {
      const camera = this.viewer.camera
      camera.rotate(Cesium.Cartesian3.ZERO, Cesium.Math.toRadians(this.orbitSpeed))
    }
  }

  getStats(): PluginStats {
    return this.status
  }

  getControls(): PluginControlSpec[] {
    const isRecording = this.recordState === 'recording'
    const isEncoding = this.recordState === 'encoding'

    return [
      { type: 'button', id: 'record', label: isRecording ? 'Stop & Save' : 'Record', variant: isRecording ? 'danger' : 'primary', disabled: isEncoding || !this.exporter?.isSupported() },
      { type: 'button', id: 'cancel', label: 'Cancel', variant: 'danger', disabled: !isRecording },
      { type: 'separator', id: 'sep1' },
      { type: 'slider', id: 'fps', label: 'Frame Rate', value: this.fps, min: 10, max: 60, step: 5, unit: 'fps', disabled: isRecording },
      { type: 'slider', id: 'duration', label: 'Duration', value: this.durationSec, min: 0, max: 120, step: 1, unit: 's', disabled: isRecording },
      { type: 'select', id: 'quality', label: 'Quality', value: String(this.bitrate), options: [
        { label: 'Low (1 Mbps)', value: '1000000' },
        { label: 'Medium (5 Mbps)', value: '5000000' },
        { label: 'High (10 Mbps)', value: '10000000' },
        { label: 'Ultra (20 Mbps)', value: '20000000' },
      ], disabled: isRecording },
      { type: 'separator', id: 'sep2' },
      { type: 'toggle', id: 'orbit', label: 'Auto-Orbit Camera', value: this.orbitMode, disabled: isRecording },
      { type: 'slider', id: 'orbitSpeed', label: 'Orbit Speed', value: this.orbitSpeed, min: 0.1, max: 5.0, step: 0.1, unit: '°/frame', disabled: isRecording || !this.orbitMode },
      { type: 'separator', id: 'sep3' },
      { type: 'display', id: 'state', label: 'State', value: this.recordState.toUpperCase(), color: this.getStateColor() },
      { type: 'display', id: 'frames', label: 'Frames', value: `${this.framesCaptured} captured / ${this.framesEncoded} encoded`, color: this.framesCaptured > 0 ? '#4aff8a' : '#6b7d92' },
      { type: 'display', id: 'elapsed', label: 'Elapsed', value: `${(this.elapsedMs / 1000).toFixed(1)}s`, color: this.recordState === 'recording' ? '#4affd4' : '#6b7d92' },
    ]
  }

  onControl(id: string, value?: unknown): void {
    if (id === 'record') {
      if (this.recordState === 'recording') {
        this.stopAndSave()
      } else {
        this.startRecording()
      }
    } else if (id === 'cancel') {
      this.cancelRecording()
    } else if (id === 'fps' && typeof value === 'number') {
      this.fps = value
    } else if (id === 'duration' && typeof value === 'number') {
      this.durationSec = value
    } else if (id === 'quality' && typeof value === 'string') {
      this.bitrate = parseInt(value)
    } else if (id === 'orbit' && typeof value === 'boolean') {
      this.orbitMode = value
    } else if (id === 'orbitSpeed' && typeof value === 'number') {
      this.orbitSpeed = value
    }
  }

  clear(): void {
    this.cancelRecording()
  }

  // ── Recording ──

  private async startRecording(): Promise<void> {
    if (!this.exporter || !this.viewer) return

    // Save original camera position for orbit mode
    if (this.orbitMode) {
      const carto = Cesium.Cartographic.fromCartesian(this.viewer.camera.position)
      this.originalCamera = {
        lon: Cesium.Math.toDegrees(carto.longitude),
        lat: Cesium.Math.toDegrees(carto.latitude),
        height: carto.height,
      }
    }

    const opts: TimelapseOptions = {
      fps: this.fps,
      durationSec: this.durationSec,
      bitrate: this.bitrate,
    }

    try {
      await this.exporter.start(opts)
      this.recordState = 'recording'
      this.framesCaptured = 0
      this.framesEncoded = 0
      this.elapsedMs = 0
      this.status = { count: 0, status: 'loading' }

      // Poll status every 100ms
      this.statusTimer = setInterval(() => {
        const s = this.exporter?.getStatus()
        if (s) {
          this.framesCaptured = s.framesCaptured
          this.framesEncoded = s.framesEncoded
          this.elapsedMs = s.elapsedMs
        }
      }, 100)

      console.log(`[timelapse] recording started — ${this.fps}fps, ${this.durationSec}s, ${this.bitrate}bps`)
    } catch (e) {
      console.error('[timelapse] start failed:', e)
      this.recordState = 'error'
      this.status = { count: 0, status: 'error', error: String(e) }
    }
  }

  private async stopAndSave(): Promise<void> {
    if (!this.exporter) return

    if (this.statusTimer) {
      clearInterval(this.statusTimer)
      this.statusTimer = null
    }

    this.recordState = 'encoding'

    try {
      const path = await this.exporter.stopAndSave()
      this.recordState = 'done'
      this.status = { count: this.framesEncoded, status: 'nominal' }
      console.log(`[timelapse] saved to ${path}`)

      // Restore camera if orbiting
      if (this.originalCamera && this.viewer) {
        this.viewer.camera.flyTo({
          destination: Cesium.Cartesian3.fromDegrees(
            this.originalCamera.lon,
            this.originalCamera.lat,
            this.originalCamera.height,
          ),
          duration: 1.0,
        })
        this.originalCamera = null
      }
    } catch (e) {
      console.error('[timelapse] save failed:', e)
      this.recordState = 'error'
      this.status = { count: 0, status: 'error', error: String(e) }
    }
  }

  private cancelRecording(): void {
    if (this.statusTimer) {
      clearInterval(this.statusTimer)
      this.statusTimer = null
    }
    if (this.exporter) {
      this.exporter.cancel()
    }
    this.recordState = 'idle'
    this.framesCaptured = 0
    this.framesEncoded = 0
    this.elapsedMs = 0
    this.status = { count: 0, status: 'nominal' }

    // Restore camera if orbiting
    if (this.originalCamera && this.viewer) {
      this.viewer.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(
          this.originalCamera.lon,
          this.originalCamera.lat,
          this.originalCamera.height,
        ),
        duration: 1.0,
      })
      this.originalCamera = null
    }
  }

  private getStateColor(): string {
    switch (this.recordState) {
      case 'recording': return '#ff4444'
      case 'encoding': return '#ffaa00'
      case 'done': return '#4aff8a'
      case 'error': return '#ff4444'
      default: return '#6b7d92'
    }
  }
}

export const timelapsePlugin = new TimelapsePlugin()
