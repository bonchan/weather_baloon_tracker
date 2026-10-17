import * as Location from 'expo-location'
import { resume, send } from '../ble/link'
import { FIX_OK, isValidCallsign, posSentence } from '../protocol/pstk'
import { getSettings, loadSettings } from './settings'
import { getTeam, setMe } from './store'

/** A phone fix older than this isn't worth broadcasting. */
const STALE_FIX_MS = 30_000

let started = false
let sendTimer: ReturnType<typeof setTimeout> | undefined

/** Starts the phone GPS, reconnects the bound Heltec and begins broadcasting my position. Idempotent. */
export async function startNetwork() {
  if (started) return
  started = true
  await loadSettings()
  resume()
  void watchMe()
  scheduleSend()
}

async function watchMe() {
  const { status } = await Location.requestForegroundPermissionsAsync()
  if (status !== 'granted') return
  await Location.watchPositionAsync(
    { accuracy: Location.Accuracy.High, timeInterval: 2000, distanceInterval: 2 },
    (p) =>
      setMe({
        lat: p.coords.latitude,
        lon: p.coords.longitude,
        alt: p.coords.altitude ?? undefined,
        speed: p.coords.speed !== null && p.coords.speed >= 0 ? p.coords.speed : undefined,
        course: p.coords.heading !== null && p.coords.heading >= 0 ? p.coords.heading : undefined,
        accuracy: p.coords.accuracy ?? undefined,
        at: p.timestamp,
      }),
  )
}

function scheduleSend() {
  clearTimeout(sendTimer)
  const { intervalS } = getSettings()
  // A little jitter so phones that started together don't keep colliding on air.
  sendTimer = setTimeout(() => void sendMine().finally(scheduleSend), intervalS * 1000 + Math.random() * 2000)
}

async function sendMine() {
  const { callsign } = getSettings()
  const me = getTeam().me
  if (!me || !isValidCallsign(callsign) || Date.now() - me.at > STALE_FIX_MS) return
  await send(
    posSentence({
      src: callsign,
      fix: FIX_OK,
      lat: me.lat,
      lon: me.lon,
      alt: me.alt,
      speed: me.speed,
      course: me.course,
      utc: Math.round(me.at / 1000),
    }),
  )
}
