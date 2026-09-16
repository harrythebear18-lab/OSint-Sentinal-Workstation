/**
 * Plugin Architecture — adapted from GEV's DataLayerManager pattern.
 *
 * Each module is a self-contained plugin with a standard interface:
 * - register(viewer, sceneContext, ipc) — attach to globe
 * - unregister() — detach cleanly
 * - update(sceneContext) — react to scene changes
 * - getStats() — health/status for UI
 * - getControls() — declarative UI controls for the inspector panel
 * - onControl(id, value) — handle control interactions
 *
 * Plugins own their own UI panels (collapsible, toggleable).
 * The plugin manager handles lifecycle, ordering, and shared state.
 */

import * as Cesium from 'cesium'
import type { WorldOverlay } from '../WorldOverlay'

export interface PluginContext {
  viewer: Cesium.Viewer
  sceneContext: unknown
  ipc: any  // typeof window.api — typed as any to allow dynamic property access
  worldOverlay?: WorldOverlay  // shared label/card layer with collision management
}

export interface PluginStats {
  count: number
  status: 'nominal' | 'loading' | 'degraded' | 'stale' | 'error' | 'disabled'
  error?: string
}

/* ── Declarative control specs for the inspector panel ── */

export type PluginControlSpec =
  | PluginButtonSpec
  | PluginToggleSpec
  | PluginSliderSpec
  | PluginSelectSpec
  | PluginInputSpec
  | PluginDisplaySpec
  | PluginSeparatorSpec

export interface PluginButtonSpec {
  type: 'button'
  id: string
  label: string
  variant?: 'primary' | 'danger' | 'default'
  disabled?: boolean
}

export interface PluginToggleSpec {
  type: 'toggle'
  id: string
  label: string
  value: boolean
  disabled?: boolean
}

export interface PluginSliderSpec {
  type: 'slider'
  id: string
  label: string
  value: number
  min: number
  max: number
  step?: number
  unit?: string
  disabled?: boolean
}

export interface PluginSelectSpec {
  type: 'select'
  id: string
  label: string
  value: string
  options: { label: string; value: string }[]
  disabled?: boolean
}

export interface PluginInputSpec {
  type: 'input'
  id: string
  label: string
  value: string
  placeholder?: string
}

export interface PluginDisplaySpec {
  type: 'display'
  id: string
  label: string
  value: string
  color?: string
}

export interface PluginSeparatorSpec {
  type: 'separator'
  id: string
  label?: string
}

export interface EarthEnginePlugin {
  /** Unique plugin ID */
  id: string
  /** Human-readable name */
  name: string
  /** Category for UI grouping */
  category: 'terrain' | 'imagery' | 'mapping' | 'mission' | 'live' | 'climate' | 'infrastructure' | 'ai' | 'media' | 'system' | 'vr'
  /** Attach to globe — called once when plugin is enabled */
  register(ctx: PluginContext): void
  /** Detach cleanly — called when plugin is disabled or app closes */
  unregister(): void
  /** React to scene context changes (camera move, layer change, etc.) */
  update?(ctx: PluginContext): void
  /** Health/status for UI */
  getStats?(): PluginStats
  /** Declarative controls for the inspector panel */
  getControls?(): PluginControlSpec[]
  /** Handle a control interaction (button click, slider change, etc.) */
  onControl?(id: string, value?: unknown): void
  /** Clear all rendered entities without deactivating the plugin */
  clear?(): void
}

class PluginManager {
  private plugins = new Map<string, EarthEnginePlugin>()
  private activePlugins = new Set<string>()
  private ctx: PluginContext | null = null

  /** Register a plugin definition (doesn't activate it) */
  register(plugins: EarthEnginePlugin | EarthEnginePlugin[]): void {
    const arr = Array.isArray(plugins) ? plugins : [plugins]
    for (const p of arr) {
      this.plugins.set(p.id, p)
    }
  }

  /** Set the shared context (viewer + scene + ipc) */
  setContext(ctx: PluginContext): void {
    this.ctx = ctx
  }

  /** Activate a plugin by ID */
  async activate(id: string): Promise<boolean> {
    if (!this.ctx) return false
    const plugin = this.plugins.get(id)
    if (!plugin || this.activePlugins.has(id)) return false
    try {
      plugin.register(this.ctx)
      this.activePlugins.add(id)
      console.log(`[plugins] activated: ${id}`)
      return true
    } catch (err) {
      console.error(`[plugins] failed to activate ${id}:`, err)
      return false
    }
  }

  /** Deactivate a plugin by ID */
  deactivate(id: string): void {
    const plugin = this.plugins.get(id)
    if (!plugin || !this.activePlugins.has(id)) return
    try {
      plugin.unregister()
      this.activePlugins.delete(id)
      console.log(`[plugins] deactivated: ${id}`)
    } catch (err) {
      console.error(`[plugins] failed to deactivate ${id}:`, err)
    }
  }

  /** Toggle a plugin */
  toggle(id: string): void {
    if (this.activePlugins.has(id)) {
      this.deactivate(id)
    } else {
      this.activate(id)
    }
  }

  /** Check if a plugin is active */
  isActive(id: string): boolean {
    return this.activePlugins.has(id)
  }

  /** Get all registered plugin definitions */
  getPlugins(): EarthEnginePlugin[] {
    return [...this.plugins.values()]
  }

  /** Get active plugin IDs */
  getActive(): string[] {
    return [...this.activePlugins]
  }

  /** Get stats for a plugin */
  getStats(id: string): PluginStats | null {
    const plugin = this.plugins.get(id)
    if (!plugin || !this.activePlugins.has(id)) return null
    return plugin.getStats?.() ?? { count: 0, status: 'nominal' }
  }

  /** Broadcast scene context update to all active plugins */
  updateAll(ctx: PluginContext): void {
    for (const id of this.activePlugins) {
      const plugin = this.plugins.get(id)
      plugin?.update?.(ctx)
    }
  }

  /** Deactivate all plugins (on app close) */
  shutdown(): void {
    for (const id of [...this.activePlugins]) {
      this.deactivate(id)
    }
  }
}

export const pluginManager = new PluginManager()
