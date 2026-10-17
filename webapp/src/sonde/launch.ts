import { useSyncExternalStore } from 'react'

export type LaunchSite = { lat: number; lon: number; alt: number }

/** Neuquén Aero, where the region's sondes go up. */
export const DEFAULT_LAUNCH: LaunchSite = { lat: -38.949, lon: -68.156, alt: 271 }

const LAUNCH_KEY = 'sondetracker.launch.v1'

function loadLaunchSite(): LaunchSite {
  try {
    const s = JSON.parse(localStorage.getItem(LAUNCH_KEY) ?? 'null') as LaunchSite | null
    if (s && Number.isFinite(s.lat) && Number.isFinite(s.lon)) return { lat: s.lat, lon: s.lon, alt: s.alt || 0 }
  } catch {
    // ignore
  }
  return DEFAULT_LAUNCH
}

/**
 * Where sondes are launched from. The demo flight starts here and the offline map can save
 * the area around it. A pre-launch flight prediction would start here too: subscribe and
 * predict again whenever the site moves.
 */
class LaunchSiteStore {
  private site = loadLaunchSite()
  private listeners = new Set<() => void>()

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getState = () => this.site

  set(site: LaunchSite) {
    try {
      localStorage.setItem(LAUNCH_KEY, JSON.stringify(site))
    } catch {
      // not fatal
    }
    this.site = site
    for (const l of this.listeners) l()
  }
}

export const launch = new LaunchSiteStore()

export function useLaunchSite(): LaunchSite {
  return useSyncExternalStore(launch.subscribe, launch.getState)
}
