import AsyncStorage from '@react-native-async-storage/async-storage'
import { useSyncExternalStore } from 'react'

export type Settings = {
  callsign: string
  /** BLE id of the bound Heltec, reconnected automatically. */
  deviceId: string | null
  deviceName: string | null
  /** How often my position goes out over LoRa. Shorter means more airtime for everyone. */
  intervalS: number
}

export const INTERVAL_CHOICES = [10, 15, 30, 60]

const KEY = 'sondetracker.settings.v1'
let settings: Settings = { callsign: '', deviceId: null, deviceName: null, intervalS: 15 }
let loaded = false
const listeners = new Set<() => void>()

function emit() {
  for (const l of listeners) l()
}

export async function loadSettings(): Promise<Settings> {
  if (!loaded) {
    try {
      const raw = await AsyncStorage.getItem(KEY)
      if (raw) settings = { ...settings, ...(JSON.parse(raw) as Partial<Settings>) }
    } catch {
      // first run or unreadable; keep defaults
    }
    loaded = true
    emit()
  }
  return settings
}

export function getSettings(): Settings {
  return settings
}

export function updateSettings(patch: Partial<Settings>) {
  settings = { ...settings, ...patch }
  emit()
  void AsyncStorage.setItem(KEY, JSON.stringify(settings))
}

export function useSettings(): Settings {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => {
        listeners.delete(l)
      }
    },
    () => settings,
  )
}
