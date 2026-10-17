import { offsetMeters } from '../geo'
import { launch } from './launch'
import { sondes } from './store'

const SERIAL = 'DEMO-001'
const BURST_ALTITUDE = 28_000
const ASCENT_RATE = 5
/** Simulated seconds per tick; ticks run every 100 ms, so the flight plays 20× faster. */
const SECONDS_PER_TICK = 2

/** Westerly wind growing to a jet stream near 11 km, typical over Patagonia. */
function wind(alt: number) {
  const jet = Math.exp(-(((alt - 11_000) / 4_000) ** 2))
  return { east: 6 + 34 * jet + alt / 3_000, north: -2 + 3 * jet }
}

/** Rough standard atmosphere: cooling up to the tropopause near 11 km, slowly warming above 20 km, drying out with height. */
function air(alt: number) {
  const km = alt / 1000
  return { temperature: km < 11 ? 18 - 6.5 * km : -53.5 + Math.max(0, km - 20), humidity: 45 * Math.exp(-km / 4) }
}

let timer: ReturnType<typeof setInterval> | undefined

export function isDemoRunning() {
  return timer !== undefined
}

/** Plays a fake ascent, burst and descent from the launch site so the map can be tried without a sonde. */
export function startDemo(onEnd: () => void) {
  stopDemo()
  sondes.clearTracks(true)
  const start = launch.getState()
  let { lat, lon } = start
  let alt = start.alt
  let burst = false
  let frame = 0
  const t0 = Date.now()

  timer = setInterval(() => {
    // Parachute descent: fast in thin air, ~6 m/s near the ground.
    const climb = burst ? -6 * Math.exp((alt - start.alt) / 14_000) : ASCENT_RATE
    alt += climb * SECONDS_PER_TICK
    if (!burst && alt >= BURST_ALTITUDE) burst = true
    const w = wind(alt)
    ;({ lat, lon } = offsetMeters(lat, lon, w.east * SECONDS_PER_TICK, w.north * SECONDS_PER_TICK))
    frame += SECONDS_PER_TICK
    const landed = burst && alt <= start.alt
    sondes.addFix(
      {
        serial: SERIAL,
        frame,
        time: t0 + frame * 1000,
        lat,
        lon,
        alt: Math.max(alt, start.alt),
        climb: landed ? 0 : climb,
        speed: Math.hypot(w.east, w.north),
        heading: (Math.atan2(w.east, w.north) * 180) / Math.PI,
        ...air(Math.max(alt, start.alt)),
        receivedAt: Date.now(),
      },
      true,
    )
    if (landed) {
      stopDemo()
      onEnd()
    }
  }, 100)
}

export function stopDemo() {
  clearInterval(timer)
  timer = undefined
}
