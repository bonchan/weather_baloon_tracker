import { useSyncExternalStore } from 'react'
import { FIX_OK, NmeaFixer, parseLine, SRC_SELF, type Fix, type PositionReport } from './protocol'

/** Where a device's port stands. `lost`: unplugged while open; `failed`: it would not open. */
export type LinkState = 'opening' | 'open' | 'closed' | 'lost' | 'failed'

export type LogLine = { time: number; text: string; error: boolean }

export type CompanionDevice = {
  /** Local to this page session. */
  id: number
  usbVendorId?: number
  usbProductId?: number
  link: LinkState
  /** Why the port would not open, as the browser said it. */
  problem?: string
  /** From its ID line. */
  kind?: string
  name?: string
  firmware?: string
  /** LoRa devices: the team network id (NO_NET when none) and the chip id. */
  net?: string
  loraId?: string
  /** 'pstk' once it speaks the Sonde Tracker link, 'nmea' for a plain GPS. */
  protocol: 'pstk' | 'nmea' | null
  /** Of its own GPS. */
  fix: Fix | null
  sats?: number
  hdop?: number
  /** Date.now() of the last line understood. */
  lastSeen: number | null
  logs: LogLine[]
}

/** My live position, from the SELF fix of a companion. */
export type MyPosition = {
  lat: number
  lon: number
  /** Above the WGS84 ellipsoid when the geoid separation is known, else above sea level. */
  alt?: number
  speed?: number
  course?: number
  receivedAt: number
  deviceId: number
  /** The fix was lost or the device went away; this is the last known spot. */
  lost: boolean
}

export type RemoteTracker = {
  id: string
  lat: number
  lon: number
  alt?: number
  speed?: number
  course?: number
  rssi?: number
  snr?: number
  receivedAt: number
  deviceId: number
  /** Fix time from the sender, Unix s. */
  utc?: number
}

/** A satellite asking the base station to join the team network. */
export type JoinRequest = {
  /** The satellite's chip id. */
  loraId: string
  callsign: string
  rssi?: number
  snr?: number
  receivedAt: number
  /** The base station that heard it. */
  deviceId: number
}

export type CompanionState = {
  devices: CompanionDevice[]
  me: MyPosition | null
  trackers: Record<string, RemoteTracker>
  joinRequests: JoinRequest[]
}

const MAX_LOGS = 5
/** A fix this recent from one device keeps another from taking over, so two GPSes don't make me jitter. */
const ME_HOLD_MS = 5_000
/** A companion's own POS lines win over its forwarded NMEA for this long. */
const PSTK_HOLD_MS = 5_000

function ellipsoidHeight(p: PositionReport): number | undefined {
  return p.altMsl === undefined ? undefined : p.altMsl + (p.geoidSep ?? 0)
}

/**
 * Companion devices, my position and remote trackers. The serial link feeds handleLine();
 * the panel and the map read the state.
 */
class CompanionStore {
  private state: CompanionState = { devices: [], me: null, trackers: {}, joinRequests: [] }
  private listeners = new Set<() => void>()
  private nextId = 1
  private nmea = new Map<number, NmeaFixer>()
  private pstkAt = new Map<number, number>()

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getState = () => this.state

  addDevice(usb: { usbVendorId?: number; usbProductId?: number }): number {
    const id = this.nextId++
    // A device plugged back in can come back as a new port; drop what is left of it.
    const devices = this.state.devices.filter(
      (d) => !(d.link === 'lost' && d.usbVendorId === usb.usbVendorId && d.usbProductId === usb.usbProductId),
    )
    const device: CompanionDevice = { id, ...usb, link: 'opening', protocol: null, fix: null, lastSeen: null, logs: [] }
    this.set({ devices: [...devices, device] })
    return id
  }

  /** Forgets a join request once it was answered. */
  dropJoinRequest(loraId: string) {
    this.set({ joinRequests: this.state.joinRequests.filter((r) => r.loraId !== loraId) })
  }

  removeDevice(id: number) {
    this.nmea.delete(id)
    this.pstkAt.delete(id)
    this.loseMe(id)
    this.set({ devices: this.state.devices.filter((d) => d.id !== id) })
  }

  setLink(id: number, link: LinkState, problem?: string) {
    if (link !== 'open' && link !== 'opening') this.loseMe(id)
    if (link === 'opening') {
      this.nmea.delete(id)
      this.pstkAt.delete(id)
    }
    this.patch(id, { link, problem })
  }

  /** `backlog`: the line was queued in the device before the port opened, so its position is old news. */
  handleLine(id: number, line: string, now = Date.now(), backlog = false) {
    const msg = parseLine(line)
    const device = this.state.devices.find((d) => d.id === id)
    if (!msg || !device) return
    switch (msg.type) {
      case 'id':
        this.patch(id, {
          kind: msg.kind,
          name: msg.name,
          firmware: msg.firmware,
          net: msg.net,
          loraId: msg.device,
          protocol: 'pstk',
          lastSeen: now,
        })
        return
      case 'heard':
        // A team member's position, heard over LoRa by this base station.
        if (msg.inner?.type === 'pos' && msg.inner.pos.src !== SRC_SELF) {
          this.position(device, { ...msg.inner.pos, rssi: msg.rssi, snr: msg.snr }, 'pstk', now, backlog)
        } else {
          this.patch(id, { lastSeen: now })
        }
        return
      case 'joinreq': {
        if (backlog) return
        const others = this.state.joinRequests.filter((r) => r.loraId !== msg.device)
        const request: JoinRequest = {
          loraId: msg.device,
          callsign: msg.callsign,
          rssi: msg.rssi,
          snr: msg.snr,
          receivedAt: now,
          deviceId: id,
        }
        this.set({ joinRequests: [...others, request] })
        this.patch(id, { lastSeen: now })
        return
      }
      case 'log':
      case 'err': {
        const logs = [...device.logs, { time: now, text: msg.text, error: msg.type === 'err' }].slice(-MAX_LOGS)
        this.patch(id, { logs, protocol: 'pstk', lastSeen: now })
        return
      }
      case 'pos':
        this.pstkAt.set(id, now)
        this.position(device, msg.pos, 'pstk', now, backlog)
        return
      case 'gga':
      case 'rmc': {
        // A companion forwards its module's NMEA too; its own POS lines say the same, better.
        const companion = device.protocol === 'pstk' || now - (this.pstkAt.get(id) ?? -Infinity) < PSTK_HOLD_MS
        if (companion || backlog) return
        let fixer = this.nmea.get(id)
        if (!fixer) this.nmea.set(id, (fixer = new NmeaFixer()))
        const report = fixer.push(msg)
        if (report) this.position(device, report, 'nmea', now, false)
      }
    }
  }

  // ---------------------------------------------------------------------------

  private position(device: CompanionDevice, p: PositionReport, protocol: 'pstk' | 'nmea', now: number, backlog: boolean) {
    if (backlog) {
      this.patch(device.id, { lastSeen: now })
      return
    }
    const hasPosition = p.fix === FIX_OK && p.lat !== undefined && p.lon !== undefined
    if (p.src !== SRC_SELF) {
      this.patch(device.id, { lastSeen: now })
      if (hasPosition) {
        const tracker: RemoteTracker = {
          id: p.src,
          lat: p.lat!,
          lon: p.lon!,
          alt: ellipsoidHeight(p),
          speed: p.speed,
          course: p.course,
          rssi: p.rssi,
          snr: p.snr,
          receivedAt: now,
          deviceId: device.id,
          utc: p.utc,
        }
        this.set({ trackers: { ...this.state.trackers, [p.src]: tracker } })
      }
      return
    }

    this.patch(device.id, { fix: p.fix, sats: p.sats, hdop: p.hdop, lastSeen: now, protocol: device.protocol ?? protocol })
    const me = this.state.me
    const mine = me?.deviceId === device.id
    if (hasPosition) {
      if (me && !mine && !me.lost && now - me.receivedAt < ME_HOLD_MS) return
      this.set({
        me: {
          lat: p.lat!,
          lon: p.lon!,
          alt: ellipsoidHeight(p),
          speed: p.speed,
          course: p.course,
          receivedAt: now,
          deviceId: device.id,
          lost: false,
        },
      })
    } else if (mine) {
      this.loseMe(device.id)
    }
  }

  private loseMe(deviceId: number) {
    const me = this.state.me
    if (me && me.deviceId === deviceId && !me.lost) this.set({ me: { ...me, lost: true } })
  }

  private patch(id: number, patch: Partial<CompanionDevice>) {
    this.set({ devices: this.state.devices.map((d) => (d.id === id ? { ...d, ...patch } : d)) })
  }

  private set(patch: Partial<CompanionState>) {
    this.state = { ...this.state, ...patch }
    for (const l of this.listeners) l()
  }
}

export const companions = new CompanionStore()

export function useCompanions(): CompanionState {
  return useSyncExternalStore(companions.subscribe, companions.getState)
}
