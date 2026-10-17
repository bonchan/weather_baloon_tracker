import { useSyncExternalStore } from 'react'
import { BASE_ID, type Message, type Position, type SondeReport } from '../protocol/pstk'

export type Member = Position & {
  /** Date.now() when the packet arrived. */
  heardAt: number
}

export type SondePoint = SondeReport & { heardAt: number }

export type Me = { lat: number; lon: number; alt?: number; speed?: number; course?: number; accuracy?: number; at: number }

export type TeamState = {
  /** Other satellites by callsign. */
  members: Record<string, Member>
  base: Member | null
  /** Track of the balloon the base station is decoding (latest last). */
  sonde: SondePoint[]
  me: Me | null
}

let state: TeamState = { members: {}, base: null, sonde: [], me: null }
const listeners = new Set<() => void>()

function set(patch: Partial<TeamState>) {
  state = { ...state, ...patch }
  for (const l of listeners) l()
}

/** Applies a message heard over LoRa. My own callsign is ignored (the base may echo it back). */
export function applyMessage(msg: Message, myCallsign: string) {
  const heardAt = Date.now()
  if (msg.type === 'pos') {
    const p = msg.pos
    if (p.src === myCallsign) return
    if (p.src === BASE_ID) set({ base: { ...p, heardAt } })
    else set({ members: { ...state.members, [p.src]: { ...p, heardAt } } })
    return
  }
  const last = state.sonde[state.sonde.length - 1]
  // A new serial means a new flight; start its track over.
  const track = last && last.serial !== msg.sonde.serial ? [] : state.sonde
  if (last && last.serial === msg.sonde.serial && last.frame === msg.sonde.frame) return
  set({ sonde: [...track, { ...msg.sonde, heardAt }] })
}

export function setMe(me: Me | null) {
  set({ me })
}

export function getTeam(): TeamState {
  return state
}

export function useTeam(): TeamState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => {
        listeners.delete(l)
      }
    },
    () => state,
  )
}
