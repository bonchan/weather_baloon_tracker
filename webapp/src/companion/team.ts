import { sondes } from '../sonde/store'
import { KIND_BASE, posBody, sondeBody } from './protocol'
import { companionLink } from './serial'
import { companions, type CompanionDevice } from './store'

/**
 * The search team over LoRa, driven from here through the base station (a KIND_BASE companion):
 * answering join requests, and keeping the satellites up to date. The base hears every
 * satellite, but satellites far apart don't hear each other, so this relays them, and sends
 * the balloon the decoder is following.
 */

/** The balloon goes out at most this often (LoRa airtime is shared by the whole team). */
const SONDE_EVERY_MS = 2_000
/** Each team member's position is relayed at most this often. */
const RELAY_EVERY_MS = 15_000
/** Members not heard for this long aren't relayed any more. */
const RELAY_MAX_AGE_MS = 120_000
/** One transmission per tick, so relays never pile up on the air. */
const TICK_MS = 1_000

export function baseStation(devices: CompanionDevice[]): CompanionDevice | undefined {
  return devices.find((d) => d.kind === KIND_BASE && d.link === 'open')
}

function base(): CompanionDevice | undefined {
  return baseStation(companions.getState().devices)
}

export async function acceptJoin(loraId: string): Promise<boolean> {
  const b = base()
  if (!b) return false
  const ok = await companionLink.send(b.id, `PSTK,ACCEPT,${loraId}`)
  if (ok) companions.dropJoinRequest(loraId)
  return ok
}

export async function rejectJoin(loraId: string): Promise<boolean> {
  const b = base()
  if (!b) return false
  const ok = await companionLink.send(b.id, `PSTK,REJECT,${loraId}`)
  if (ok) companions.dropJoinRequest(loraId)
  return ok
}

/** New random network id: the base kicks everyone first, and every satellite has to ask again. */
export async function newNetwork(): Promise<boolean> {
  const b = base()
  if (!b) return false
  const ok = await companionLink.send(b.id, 'PSTK,NEWNET')
  if (ok) companions.clearTeam()
  return ok
}

/** Removes a satellite from the network; it has to ask to join again. */
export async function kickMember(device: string, trackerId: string): Promise<boolean> {
  const b = base()
  if (!b) return false
  const ok = await companionLink.send(b.id, `PSTK,KICK,${device}`)
  if (ok) companions.removeTracker(trackerId)
  return ok
}

let lastSondeAt = 0
let lastSondeKey = ''
const relayedAt = new Map<string, number>()

/** CLEAR lines waiting to go out; each goes twice, as one LoRa packet can get lost. */
const clears: string[] = []
let knownSerials = new Set(Object.keys(sondes.getState().tracks))
sondes.subscribe(() => {
  const now = new Set(Object.keys(sondes.getState().tracks))
  for (const serial of knownSerials) {
    if (!now.has(serial)) clears.push(serial, serial)
  }
  knownSerials = now
})

/** The balloon, if there is something new to tell. */
function sondeToSend(now: number): string | null {
  if (now - lastSondeAt < SONDE_EVERY_MS) return null
  const { active, tracks } = sondes.getState()
  const track = active ? tracks[active] : undefined
  const fix = track?.fixes[track.fixes.length - 1]
  if (!fix) return null
  const key = `${fix.serial}/${fix.frame}`
  if (key === lastSondeKey) return null
  lastSondeKey = key
  lastSondeAt = now
  return sondeBody({
    serial: fix.serial,
    frame: fix.frame,
    lat: fix.lat,
    lon: fix.lon,
    alt: fix.alt,
    climb: fix.climb,
    speed: fix.speed,
    course: fix.heading,
    utc: fix.time / 1000,
  })
}

/** The team member whose relay is most overdue, if any is due. */
function relayToSend(now: number): string | null {
  let due: { id: string; at: number } | null = null
  for (const t of Object.values(companions.getState().trackers)) {
    if (now - t.receivedAt > RELAY_MAX_AGE_MS) continue
    const at = relayedAt.get(t.id) ?? 0
    if (now - at < RELAY_EVERY_MS) continue
    if (!due || at < due.at) due = { id: t.id, at }
  }
  if (!due) return null
  const t = companions.getState().trackers[due.id]
  relayedAt.set(t.id, now)
  return posBody({ src: t.name, lat: t.lat, lon: t.lon, altMsl: t.alt, speed: t.speed, course: t.course, utc: t.utc, device: t.device })
}

let timer: ReturnType<typeof setInterval> | undefined

/** Starts relaying once; harmless to call again. */
export function startTeamRelay() {
  if (timer) return
  timer = setInterval(() => {
    const b = base()
    if (!b || !b.net) return
    const now = Date.now()
    const clear = clears.shift()
    const body = clear !== undefined ? `PSTK,CLEAR,${clear}` : (sondeToSend(now) ?? relayToSend(now))
    if (body) void companionLink.send(b.id, `PSTK,TX,${body}`)
  }, TICK_MS)
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    clearInterval(timer)
    timer = undefined
  })
}
