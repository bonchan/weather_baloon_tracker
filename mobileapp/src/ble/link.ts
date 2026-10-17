import { useSyncExternalStore } from 'react'
import { PermissionsAndroid, Platform } from 'react-native'
import { BleManager, State, type Device, type Subscription } from 'react-native-ble-plx'
import { LineSplitter, parseLine } from '../protocol/pstk'
import { applyMessage } from '../team/store'
import { getSettings, updateSettings } from '../team/settings'

// Nordic UART service, as advertised by arduino/heltec_companion.
export const UART_SERVICE = '6E400001-B5A3-F393-E0A9-E50E24DCCA9E'
const UART_RX = '6E400002-B5A3-F393-E0A9-E50E24DCCA9E' // phone writes, the node transmits over LoRa
const UART_TX = '6E400003-B5A3-F393-E0A9-E50E24DCCA9E' // node notifies what it heard over LoRa
/** A $PSTK line is ~80 bytes; the default 23-byte MTU would cut it. */
const WANTED_MTU = 185
const RECONNECT_MS = 5000
const SCAN_MS = 12_000

export type LinkPhase = 'idle' | 'scanning' | 'connecting' | 'connected' | 'error'
export type LinkProblem = 'bluetoothOff' | 'permissionDenied' | null
export type FoundNode = { id: string; name: string; rssi: number | null }

export type LinkState = {
  phase: LinkPhase
  found: FoundNode[]
  problem: LinkProblem
  error: string | null
  lastSentAt: number | null
}

let state: LinkState = { phase: 'idle', found: [], problem: null, error: null, lastSentAt: null }
const listeners = new Set<() => void>()
function set(patch: Partial<LinkState>) {
  state = { ...state, ...patch }
  for (const l of listeners) l()
}

let manager: BleManager | null = null
const ble = () => (manager ??= new BleManager())

let device: Device | null = null
let subscriptions: Subscription[] = []
let reconnectTimer: ReturnType<typeof setTimeout> | undefined
let scanTimer: ReturnType<typeof setTimeout> | undefined
const splitter = new LineSplitter()

// Hermes provides atob/btoa; $PSTK lines are plain ASCII, so no UTF-8 handling is needed.
const toBase64 = (text: string) => btoa(text)
const fromBase64 = (b64: string) => atob(b64)

async function ensurePermissions(): Promise<boolean> {
  if (Platform.OS !== 'android') return true
  const wanted =
    Number(Platform.Version) >= 31
      ? [PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN, PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT]
      : // Android 11 and older (the J2 Core is 8.1) only allow BLE scans with location permission.
        [PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION]
  const result = await PermissionsAndroid.requestMultiple(wanted)
  return wanted.every((p) => result[p] === PermissionsAndroid.RESULTS.GRANTED)
}

async function ready(): Promise<boolean> {
  if (!(await ensurePermissions())) {
    set({ problem: 'permissionDenied', phase: 'idle' })
    return false
  }
  if ((await ble().state()) !== State.PoweredOn) {
    set({ problem: 'bluetoothOff', phase: 'idle' })
    return false
  }
  set({ problem: null })
  return true
}

export async function startScan() {
  if (!(await ready())) return
  await ble().stopDeviceScan()
  set({ phase: 'scanning', found: [], error: null })
  void ble().startDeviceScan([UART_SERVICE], null, (error, d) => {
    if (error) {
      set({ phase: 'error', error: error.message })
      return
    }
    if (!d || state.found.some((f) => f.id === d.id)) return
    set({ found: [...state.found, { id: d.id, name: d.name ?? d.localName ?? d.id, rssi: d.rssi }] })
  })
  clearTimeout(scanTimer)
  scanTimer = setTimeout(() => void stopScan(), SCAN_MS)
}

export async function stopScan() {
  clearTimeout(scanTimer)
  await ble().stopDeviceScan()
  if (state.phase === 'scanning') set({ phase: 'idle' })
}

/** Binds to a node and connects; the binding is remembered and reconnected on later launches. */
export async function connect(id: string, name: string) {
  updateSettings({ deviceId: id, deviceName: name })
  await stopScan()
  await open(id)
}

async function open(id: string) {
  clearTimeout(reconnectTimer)
  if (!(await ready())) return scheduleReconnect()
  set({ phase: 'connecting', error: null })
  try {
    let d = await ble().connectToDevice(id, { timeout: 10_000 })
    if (Platform.OS === 'android') d = await d.requestMTU(WANTED_MTU)
    d = await d.discoverAllServicesAndCharacteristics()
    device = d
    subscriptions.forEach((s) => s.remove())
    subscriptions = [
      d.monitorCharacteristicForService(UART_SERVICE, UART_TX, (error, c) => {
        if (error || !c?.value) return
        for (const line of splitter.push(fromBase64(c.value))) {
          const msg = parseLine(line)
          if (msg) applyMessage(msg, getSettings().callsign)
        }
      }),
      d.onDisconnected(() => {
        device = null
        set({ phase: 'idle' })
        scheduleReconnect()
      }),
    ]
    set({ phase: 'connected' })
  } catch (e) {
    device = null
    set({ phase: 'error', error: e instanceof Error ? e.message : String(e) })
    scheduleReconnect()
  }
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer)
  const id = getSettings().deviceId
  if (id) reconnectTimer = setTimeout(() => void open(id), RECONNECT_MS)
}

export async function disconnect() {
  clearTimeout(reconnectTimer)
  const d = device
  device = null
  subscriptions.forEach((s) => s.remove())
  subscriptions = []
  if (d) await d.cancelConnection().catch(() => {})
  set({ phase: 'idle' })
}

export async function forget() {
  updateSettings({ deviceId: null, deviceName: null })
  await disconnect()
}

/** Reconnects to the bound node, if any. Call once at startup. */
export function resume() {
  const id = getSettings().deviceId
  if (id && !device) void open(id)
}

/** Sends one line to the node, which transmits it over LoRa. */
export async function send(line: string): Promise<boolean> {
  if (!device || state.phase !== 'connected') return false
  try {
    await device.writeCharacteristicWithResponseForService(UART_SERVICE, UART_RX, toBase64(line))
    set({ lastSentAt: Date.now() })
    return true
  } catch (e) {
    set({ error: e instanceof Error ? e.message : String(e) })
    return false
  }
}

export function useLink(): LinkState {
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
