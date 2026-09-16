/**
 * Drone Footage Plugin — extract and georeference frames from drone video.
 *
 * Uses the WebCodecs VideoDecoder (hardware-accelerated) to extract frames
 * from MP4 drone footage, then optionally georeferences them onto the globe.
 *
 * The user can:
 *   1. Load an MP4 file (drone footage)
 *   2. Set extraction parameters (max frames, sample interval)
 *   3. Click "Extract Frames" to decode with hardware VideoDecoder
 *   4. View extracted frames as thumbnails
 *   5. Optionally georeference frames onto the globe (if GPS metadata available)
 *
 * The decoder uses `hardwareAcceleration: 'prefer-hardware'` which routes
 * to NVDEC/QuickSync/VAAPI when available.
 */

import * as Cesium from 'cesium'
import type { EarthEnginePlugin, PluginContext, PluginStats, PluginControlSpec } from './plugin-manager'
import { VideoFrameExtractor, type ExtractResult } from '../hal/video-frame-extractor'

interface ExtractedFrame {
  index: number
  timestamp: number // microseconds
  bitmap: ImageBitmap
  thumbnail: string // data URL
}

export class DroneFootagePlugin implements EarthEnginePlugin {
  id = 'drone-footage'
  name = 'Drone Footage (VideoDecoder)'
  category = 'media' as const

  private viewer: Cesium.Viewer | null = null
  private extractor: VideoFrameExtractor | null = null
  private dataSource: Cesium.CustomDataSource | null = null
  private status: PluginStats = { count: 0, status: 'disabled' }

  private frames: ExtractedFrame[] = []
  private lastResult: ExtractResult | null = null
  private loadedFile: File | null = null
  private maxFrames = 30
  private sampleInterval = 1

  async register(ctx: PluginContext): Promise<void> {
    this.viewer = ctx.viewer
    this.extractor = new VideoFrameExtractor()
    this.dataSource = new Cesium.CustomDataSource('drone-footage')
    ctx.viewer.dataSources.add(this.dataSource)

    if (!this.extractor.available()) {
      this.status = { count: 0, status: 'error', error: 'WebCodecs VideoDecoder not available' }
      console.warn('[drone-footage] VideoDecoder not available — plugin disabled')
    } else {
      this.status = { count: 0, status: 'nominal' }
      console.log('[drone-footage] VideoDecoder available — plugin ready')
    }
  }

  unregister(): void {
    this.clearFrames()
    if (this.dataSource && this.viewer && !this.viewer.isDestroyed?.()) {
      this.viewer.dataSources.remove(this.dataSource)
    }
    this.dataSource = null
    this.extractor = null
    this.viewer = null
    this.status = { count: 0, status: 'disabled' }
  }

  update(_ctx: PluginContext): void {}

  getStats(): PluginStats {
    return this.status
  }

  getControls(): PluginControlSpec[] {
    const hasFile = this.loadedFile !== null
    const hasFrames = this.frames.length > 0

    return [
      { type: 'button', id: 'load', label: hasFile ? this.loadedFile!.name.substring(0, 20) : 'Load MP4 File', variant: 'primary', disabled: !this.extractor?.available() },
      { type: 'separator', id: 'sep1' },
      { type: 'slider', id: 'maxFrames', label: 'Max Frames', value: this.maxFrames, min: 1, max: 300, step: 1, unit: 'frames' },
      { type: 'slider', id: 'sampleInterval', label: 'Sample Every', value: this.sampleInterval, min: 1, max: 60, step: 1, unit: 'frames' },
      { type: 'separator', id: 'sep2' },
      { type: 'button', id: 'extract', label: 'Extract Frames', variant: 'primary', disabled: !hasFile || this.status.status === 'loading' },
      { type: 'button', id: 'clear', label: 'Clear', variant: 'danger', disabled: !hasFrames },
      { type: 'separator', id: 'sep3' },
      { type: 'display', id: 'fileInfo', label: 'File', value: hasFile ? `${this.loadedFile!.name}` : 'No file loaded', color: hasFile ? '#4aff8a' : '#6b7d92' },
      { type: 'display', id: 'frames', label: 'Frames', value: `${this.frames.length} extracted`, color: hasFrames ? '#4aff8a' : '#6b7d92' },
      { type: 'display', id: 'videoInfo', label: 'Video', value: this.lastResult ? `${this.lastResult.width}x${this.lastResult.height} @ ${this.lastResult.fps.toFixed(0)}fps (${this.lastResult.codec})` : 'Not analyzed', color: this.lastResult ? '#4affd4' : '#6b7d92' },
      { type: 'display', id: 'hwAccel', label: 'HW Decode', value: this.lastResult ? (this.lastResult.hardwareAccelerated ? 'Yes (NVDEC/QuickSync)' : 'Software') : '—', color: this.lastResult?.hardwareAccelerated ? '#4aff8a' : '#ffaa00' },
    ]
  }

  onControl(id: string, value?: unknown): void {
    if (id === 'load') {
      this.openFilePicker()
    } else if (id === 'extract') {
      this.extractFrames()
    } else if (id === 'clear') {
      this.clearFrames()
    } else if (id === 'maxFrames' && typeof value === 'number') {
      this.maxFrames = value
    } else if (id === 'sampleInterval' && typeof value === 'number') {
      this.sampleInterval = value
    }
  }

  clear(): void {
    this.clearFrames()
  }

  // ── File loading ──

  private openFilePicker(): void {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'video/mp4,video/*'
    input.onchange = (e) => {
      const file = (e.target as HTMLInputElement).files?.[0]
      if (file) {
        this.loadedFile = file
        this.status = { count: 0, status: 'nominal' }
        console.log(`[drone-footage] loaded: ${file.name} (${(file.size / 1024 / 1024).toFixed(1)} MB)`)
      }
    }
    input.click()
  }

  // ── Frame extraction ──

  private async extractFrames(): Promise<void> {
    if (!this.extractor || !this.loadedFile) return

    this.clearFrames()
    this.status = { count: 0, status: 'loading' }

    try {
      const result = await this.extractor.extract(this.loadedFile, {
        maxFrames: this.maxFrames,
        sampleInterval: this.sampleInterval,
        onFrame: async (frame, index, timestamp) => {
          // Convert to bitmap for display
          const bitmap = await createImageBitmap(frame)

          // Generate thumbnail (small data URL for UI)
          const canvas = new OffscreenCanvas(160, 90)
          const ctx = canvas.getContext('2d')!
          ctx.drawImage(bitmap, 0, 0, 160, 90)
          const thumbnail = canvas.convertToBlob({ type: 'image/jpeg', quality: 0.7 })
            .then((blob) => URL.createObjectURL(blob))

          this.frames.push({
            index,
            timestamp,
            bitmap,
            thumbnail: await thumbnail,
          })
        },
        onProgress: (extracted, total) => {
          this.status = { count: extracted, status: 'loading' }
        },
      })

      this.lastResult = result
      this.status = { count: this.frames.length, status: 'nominal' }
      console.log(`[drone-footage] extracted ${this.frames.length} frames — ${result.width}x${result.height}, ${result.fps.toFixed(0)}fps, HW: ${result.hardwareAccelerated}`)
    } catch (e) {
      console.error('[drone-footage] extraction failed:', e)
      this.status = { count: 0, status: 'error', error: String(e) }
    }
  }

  private clearFrames(): void {
    for (const f of this.frames) {
      f.bitmap.close()
      URL.revokeObjectURL(f.thumbnail)
    }
    this.frames = []
    this.lastResult = null
    this.dataSource?.entities.removeAll()
    this.status = { count: 0, status: 'nominal' }
  }
}

export const droneFootagePlugin = new DroneFootagePlugin()
