/**
 * Lightning feed — Blitzortung real-time lightning detections.
 * Uses Blitzortung WebSocket (same approach as OSINT-Global-OS).
 *
 * WebSocket: wss://ws1.blitzortung.org/ through wss://ws8.blitzortung.org/
 * The WebSocket delivers strikes in real-time. We accumulate them and serve on poll.
 *
 * Messages may be LZW-compressed (binary) or plain JSON.
 */

import type { LiveFeature } from '@shared/types'
import { WebSocket } from 'ws'

const WS_SERVERS = [
  'wss://ws1.blitzortung.org/',
  'wss://ws2.blitzortung.org/',
  'wss://ws3.blitzortung.org/',
  'wss://ws4.blitzortung.org/',
  'wss://ws5.blitzortung.org/',
  'wss://ws6.blitzortung.org/',
  'wss://ws7.blitzortung.org/',
  'wss://ws8.blitzortung.org/',
]

const STRIKE_LIFETIME = 30 * 60 * 1000  // 30 minutes
const MAX_STRIKES = 5000

interface Strike {
  id: string
  lat: number
  lon: number
  timestamp: number
  polarity: number
  current: number
}

class BlitzortungFeed {
  private strikes = new Map<string, Strike>()
  private ws: WebSocket | null = null
  private connected = false
  private reconnectTimer: NodeJS.Timeout | null = null
  private reconnectDelay = 5000
  private errorLogged = false
  private started = false

  start(): void {
    if (this.started) return
    this.started = true
    this.connect()
  }

  stop(): void {
    this.started = false
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.ws) {
      try { this.ws.close() } catch { /* ignore */ }
      this.ws = null
    }
    this.connected = false
  }

  getStrikes(): LiveFeature[] {
    const now = Date.now()
    const cutoff = now - STRIKE_LIFETIME
    // Prune old strikes
    for (const [id, s] of this.strikes) {
      if (s.timestamp < cutoff) this.strikes.delete(id)
    }
    // Keep only the newest MAX_STRIKES if we overflowed
    if (this.strikes.size > MAX_STRIKES) {
      const arr = Array.from(this.strikes.values()).sort((a, b) => a.timestamp - b.timestamp)
      const toRemove = arr.length - MAX_STRIKES
      for (let i = 0; i < toRemove; i++) {
        this.strikes.delete(arr[i].id)
      }
    }

    return Array.from(this.strikes.values()).map((s) => ({
      id: s.id,
      type: 'lightning' as const,
      position: { lon: s.lon, lat: s.lat, height: 0 },
      meta: {
        polarity: s.polarity,
        current: s.current,
        time: s.timestamp,
        color: s.polarity > 0 ? '#ff4aff' : '#ffea4a',
      },
      freshness: s.timestamp,
    }))
  }

  private connect(): void {
    if (this.connected && this.ws) return
    const url = WS_SERVERS[Math.floor(Math.random() * WS_SERVERS.length)]
    try {
      this.ws = new WebSocket(url)
      this.ws.on('open', () => {
        this.connected = true
        this.reconnectDelay = 5000
        this.errorLogged = false
        // Subscribe to all strikes (Blitzortung protocol)
        this.ws?.send(JSON.stringify({ a: 111 }))
        console.log(`[live/lightning] WebSocket connected to ${url}`)
      })

      this.ws.on('message', (data: Buffer) => {
        try {
          // Blitzortung sends LZW-compressed JSON. The LZW stream starts with
          // literal bytes (including '{' = 0x7b), so we can't detect compression
          // by checking the first byte. Always try LZW first, fall back to plain.
          let jsonStr: string
          let strike: any
          try {
            jsonStr = lzwDecode(data)
            strike = JSON.parse(jsonStr)
          } catch (_) {
            // Not LZW or LZW decode failed — try plain UTF-8 JSON
            jsonStr = data.toString('utf8')
            strike = JSON.parse(jsonStr)
          }

          // Debug: log first few messages to see actual field names
          if (this.strikes.size < 3) {
            console.log(`[live/lightning] strike fields:`, Object.keys(strike).join(','), '— sample:', jsonStr.slice(0, 120))
          }

          const lat = typeof strike.lat === 'number' ? strike.lat : parseFloat(strike.lat)
          const lon = typeof strike.lon === 'number' ? strike.lon : parseFloat(strike.lon)
          if (isNaN(lat) || isNaN(lon)) return

          const ts = typeof strike.time === 'number' ? Math.floor(strike.time / 1e6) : Date.now()
          const id = `lightning:${ts}:${lat.toFixed(4)}:${lon.toFixed(4)}`
          // Deduplicate by id; if the same strike arrives again, keep the latest
          this.strikes.set(id, {
            id,
            lat, lon,
            timestamp: ts,
            polarity: strike.polType ?? strike.pol ?? 0,
            current: strike.current ?? strike.amp ?? 0,
          })
        } catch (e) {
          if (this.strikes.size === 0) {
            console.warn(`[live/lightning] parse error: ${(e as Error).message}`)
          }
        }
      })

      this.ws.on('close', () => {
        this.connected = false
        this.ws = null
        if (this.started) {
          if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
          this.reconnectTimer = setTimeout(() => this.connect(), this.reconnectDelay)
        }
      })

      this.ws.on('error', (err: Error) => {
        if (!this.errorLogged) {
          console.warn(`[live/lightning] WebSocket error: ${err.message}`)
          this.errorLogged = true
        }
      })
    } catch (e) {
      console.warn('[live/lightning] WebSocket connect failed:', e)
      if (this.started) {
        this.reconnectTimer = setTimeout(() => this.connect(), this.reconnectDelay)
      }
    }
  }
}

// Singleton feed
const feed = new BlitzortungFeed()
let feedStarted = false

export function startLightningFeed(): void {
  if (!feedStarted) {
    feedStarted = true
    feed.start()
  }
}

export function stopLightningFeed(): void {
  feed.stop()
  feedStarted = false
}

export async function getLightningFeatures(): Promise<LiveFeature[]> {
  if (!feedStarted) {
    startLightningFeed()
    // Give it a moment to connect
    await new Promise((r) => setTimeout(r, 1000))
  }
  const strikes = feed.getStrikes()
  if (strikes.length > 0) {
    console.log(`[live/lightning] ${strikes.length} strikes from Blitzortung WebSocket`)
  }
  return strikes
}

// ── LZW Decoder for Blitzortung compressed messages ──
// Blitzortung uses a character-based LZW where each UTF-8 character IS a code.
// Code points < 256 are literals (the char at current position); code points
// >= 256 (from multi-byte UTF-8 sequences) are dictionary refs (code - 256).
// CRITICAL: must use 'utf8' NOT 'binary' — multi-byte UTF-8 sequences produce
// the code points >= 256 that form the dictionary. Binary mode corrupts them.
// Reference: blitzortung.org map viewer JS + docs.rs/blitzortung live.rs
function lzwDecode(data: Buffer): string {
  const str = data.toString('utf8')
  if (str.length === 0) return ''
  let c = str[0]
  let prev = c
  let out = c
  const dict: string[] = []  // indexed 0..N, code = dict_index + 256
  for (let i = 1; i < str.length; i++) {
    const code = str.charCodeAt(i)
    let val: string
    if (code < 256) {
      val = str[i]                       // literal: the char at current position
    } else {
      val = dict[code - 256] ?? (prev + c)  // dictionary ref
    }
    out += val
    c = val[0]
    dict.push(prev + c)                  // add new dict entry
    prev = val
  }
  return out
}
