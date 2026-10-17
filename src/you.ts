import { useMemo, useSyncExternalStore } from 'react'
import { useCompanions, type MyPosition } from './companion/store'

/** Where the user put themselves by hand, for when no GPS has a fix (a fixed antenna at home). */
export type Pin = {
  lat: number
  lon: number
  alt: number
  /** Date.now() when placed. */
  placedAt: number
}

/** Where you are: what distance, bearing and elevation to the sonde are measured from. */
export type You = {
  lat: number
  lon: number
  /** Above the WGS84 ellipsoid when known, like sonde altitudes. */
  alt?: number
  source: 'gps' | 'pin'
  /** m/s, from the GPS. */
  speed?: number
  /** Degrees true, from the GPS. */
  course?: number
  /** The GPS lost its fix or went away, and no pin was placed since: its last position. */
  stale: boolean
}

/**
 * The live GPS fix when there is one. Without it, whichever is newer: the GPS's last
 * position (a fix lost for a moment while chasing) or a pin placed since.
 */
export function currentYou(me: MyPosition | null, pin: Pin | null): You | null {
  if (pin && (!me || (me.lost && pin.placedAt > me.receivedAt))) {
    return { lat: pin.lat, lon: pin.lon, alt: pin.alt, source: 'pin', stale: false }
  }
  if (!me) return null
  return { lat: me.lat, lon: me.lon, alt: me.alt, speed: me.speed, course: me.course, source: 'gps', stale: me.lost }
}

const PIN_KEY = 'sondetracker.you.v1'
/** Older versions saved a fixed "station", which is now the pin. */
const OLD_STATION_KEY = 'sondetracker.station.v1'

type KeyValueStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

function browserStorage(): KeyValueStorage | undefined {
  try {
    return localStorage
  } catch {
    return undefined
  }
}

export function loadPin(storage = browserStorage()): Pin | null {
  if (!storage) return null
  try {
    const old = storage.getItem(OLD_STATION_KEY)
    if (old !== null) {
      // Moved over once, so a station saved by an older version doesn't silently disappear.
      if (storage.getItem(PIN_KEY) === null) storage.setItem(PIN_KEY, old)
      storage.removeItem(OLD_STATION_KEY)
    }
    const p = JSON.parse(storage.getItem(PIN_KEY) ?? 'null') as Partial<Pin> | null
    if (p && Number.isFinite(p.lat) && Number.isFinite(p.lon)) {
      return { lat: p.lat!, lon: p.lon!, alt: p.alt || 0, placedAt: p.placedAt || 0 }
    }
  } catch {
    // ignore
  }
  return null
}

class PinStore {
  private pin = loadPin()
  private listeners = new Set<() => void>()

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getState = () => this.pin

  set(pin: Pin | null) {
    try {
      if (pin) localStorage.setItem(PIN_KEY, JSON.stringify(pin))
      else localStorage.removeItem(PIN_KEY)
    } catch {
      // not fatal
    }
    this.pin = pin
    for (const l of this.listeners) l()
  }
}

export const youPin = new PinStore()

export function useYou(): You | null {
  const { me } = useCompanions()
  const pin = useSyncExternalStore(youPin.subscribe, youPin.getState)
  return useMemo(() => currentYou(me, pin), [me, pin])
}
