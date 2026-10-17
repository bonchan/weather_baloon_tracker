import { useSyncExternalStore } from 'react'
import { sdr, type SdrState } from './controller'

export function useSdrState(): SdrState {
  return useSyncExternalStore(sdr.subscribe, sdr.getState)
}
