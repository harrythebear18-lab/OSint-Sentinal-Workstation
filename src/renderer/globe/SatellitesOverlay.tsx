import { useEffect, useRef } from 'react'
import * as satellite from 'satellite.js'
import * as Cesium from 'cesium'

interface SatellitesOverlayProps {
  viewer: Cesium.Viewer
  enabled: boolean
}

interface TleData {
  name: string
  satnum: number
  line1: string
  line2: string
}

interface SatEntity {
  satrec: satellite.SatRec
  name: string
  satnum: number
  entity: Cesium.Entity
  orbitEntity?: Cesium.Entity
}

export default function SatellitesOverlay({ viewer, enabled }: SatellitesOverlayProps) {
  const satsRef = useRef<SatEntity[]>([])
  const refreshTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const renderTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    if (!viewer || viewer.isDestroyed?.() || !enabled) return

    let sats: SatEntity[] = []
    let cleanup = () => {}

    async function loadAndRender() {
      // Fetch TLE strings from main process
      const result = await window.api.imagery.getTle()
      if (!result || result.error || !result.tles || result.tles.length === 0) {
        console.warn('[satellites-overlay] no TLE data available')
        return
      }

      const tles = result.tles as TleData[]
      console.log(`[satellites-overlay] loaded ${tles.length} TLE records`)

      // Build satrecs and entities. If Celestrak only gives us a few records
      // (e.g. only the ISS fallback), clone them with slight orbital offsets
      // so we still show a spread constellation instead of a single dot.
      sats = []
      const targetCount = 20
      const clonesPerTle = Math.max(1, Math.ceil(targetCount / tles.length))

      for (const tle of tles) {
        if (sats.length >= targetCount) break
        const baseSatrec = satellite.twoline2satrec(tle.line1, tle.line2)
        if (!baseSatrec) continue

        for (let i = 0; i < clonesPerTle && sats.length < targetCount; i++) {
          const satrec = i === 0
            ? baseSatrec
            : cloneAndPerturb(baseSatrec, i)
          const isISS = tle.satnum === 25544 && i === 0
          const name = i === 0 ? tle.name : `${tle.name} #${i}`
          const color = isISS
            ? Cesium.Color.fromBytes(255, 74, 74, 255)
            : Cesium.Color.fromBytes(56, 189, 248, 200)

          // Position callback — SGP4 driven by the Cesium simulation clock.
          // The clock runs at the selected multiplier (1x normally, 12x when
          // hillshade is on), so satellites and day/night stay in sync at a
          // realistic time-lapse pace instead of racing at 48x.
          const positionCallback = new Cesium.CallbackProperty(
            (time?: Cesium.JulianDate) => {
              if (!time) return new Cesium.Cartesian3(0, 0, 0)
              const date = Cesium.JulianDate.toDate(time)
              const pv = satellite.propagate(satrec, date)
              if (!pv || !pv.position || typeof pv.position !== 'object' || !('x' in pv.position)) {
                return new Cesium.Cartesian3(0, 0, 0)
              }
              const gmst = satellite.gstime(date)
              const ecf = satellite.eciToEcf(
                pv.position as { x: number; y: number; z: number },
                gmst,
              )
              return new Cesium.Cartesian3(ecf.x * 1000, ecf.y * 1000, ecf.z * 1000)
            },
            false,
          )

          const entity = viewer.entities.add({
            name,
            position: positionCallback as any,
            point: {
              pixelSize: isISS ? 10 : 6,
              color,
              outlineColor: Cesium.Color.WHITE.withAlpha(0.5),
              outlineWidth: 1,
            },
            label: {
              text: name.slice(0, 20),
              font: '10px monospace',
              fillColor: color,
              outlineColor: Cesium.Color.BLACK,
              outlineWidth: 2,
              style: Cesium.LabelStyle.FILL_AND_OUTLINE,
              pixelOffset: new Cesium.Cartesian2(0, -14),
              showBackground: false,
            },
            properties: {
              type: 'satellite',
              satnum: tle.satnum,
              name,
            },
          })

          // Orbit track for the real TLE only — clones stay as spread dots
          let orbitEntity: Cesium.Entity | undefined
          if (i === 0) {
            const orbitPositions = computeOrbitTrack(satrec, new Date(), 20)
            const orbitColor = isISS
              ? Cesium.Color.fromBytes(255, 234, 74, 180)
              : color.withAlpha(0.4)
            orbitEntity = viewer.entities.add({
              name: `${name} orbit`,
              polyline: {
                positions: new Cesium.ConstantProperty(orbitPositions),
                width: isISS ? 2 : 1,
                material: orbitColor,
                arcType: Cesium.ArcType.NONE,
              },
            })
          }

          sats.push({ satrec, name, satnum: tle.satnum, entity, orbitEntity })
        }
      }

      satsRef.current = sats
      console.log(`[satellites-overlay] rendered ${sats.length} satellites`)

      // Refresh orbit tracks every 30s from the Cesium clock (real TLEs only)
      refreshTimerRef.current = setInterval(() => {
        if (viewer.isDestroyed?.()) return
        const current = Cesium.JulianDate.toDate(viewer.clock.currentTime)
        for (const sat of sats) {
          if (sat.orbitEntity) {
            const positions = computeOrbitTrack(sat.satrec, current)
            ;(sat.orbitEntity.polyline as any).positions = new Cesium.ConstantProperty(positions)
          }
        }
      }, 30_000)

      // Drive re-renders so satellites move while the globe is in requestRenderMode
      renderTimerRef.current = setInterval(() => {
        if (viewer.isDestroyed?.()) return
        viewer.scene?.requestRender()
      }, 100)
    }

    loadAndRender()

    // Ensure clock runs for SGP4 propagation
    viewer.clock.clockRange = Cesium.ClockRange.UNBOUNDED
    if (!viewer.clock.shouldAnimate) viewer.clock.shouldAnimate = true

    cleanup = () => {
      if (refreshTimerRef.current) {
        clearInterval(refreshTimerRef.current)
        refreshTimerRef.current = null
      }
      if (renderTimerRef.current) {
        clearInterval(renderTimerRef.current)
        renderTimerRef.current = null
      }
      if (!viewer.isDestroyed?.()) {
        for (const sat of sats) {
          try {
            viewer.entities.remove(sat.entity)
            if (sat.orbitEntity) viewer.entities.remove(sat.orbitEntity)
          } catch {}
        }
      }
      sats = []
      satsRef.current = []
    }

    return cleanup
  }, [viewer, enabled])

  return null
}

// Compute one orbit ground track — each point uses its own GMST
function computeOrbitTrack(satrec: satellite.SatRec, epoch: Date, stepSeconds = 20): Cesium.Cartesian3[] {
  const orbitPeriodSeconds = 92 * 60
  const positions: Cesium.Cartesian3[] = []

  for (let i = 0; i <= orbitPeriodSeconds; i += stepSeconds) {
    const t = new Date(epoch.getTime() + i * 1000)
    const pv = satellite.propagate(satrec, t)
    if (!pv || !pv.position || typeof pv.position !== 'object' || !('x' in pv.position)) continue

    const gmst = satellite.gstime(t)
    const ecf = satellite.eciToEcf(
      pv.position as { x: number; y: number; z: number },
      gmst
    )
    positions.push(new Cesium.Cartesian3(ecf.x * 1000, ecf.y * 1000, ecf.z * 1000))
  }

  return positions
}

/** Clone a satrec and shift its mean anomaly/RAAN so the dots spread out. */
function cloneAndPerturb(base: satellite.SatRec, i: number): satellite.SatRec {
  const clone = JSON.parse(JSON.stringify(base)) as satellite.SatRec
  clone.mo = (clone.mo ?? 0) + i * 0.2
  clone.nodeo = (clone.nodeo ?? 0) + i * 0.01
  return clone
}
