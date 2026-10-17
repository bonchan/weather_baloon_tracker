import { LINK_BAUD, LineSplitter, sentence } from './protocol'
import { companions } from './store'

/**
 * What arrives this soon after opening was queued in the device while nobody read the
 * port, maybe hours ago. Fresh lines come once a second, so little is lost by skipping it.
 */
const BACKLOG_MS = 500

export function isWebSerialAvailable(): boolean {
  return typeof navigator !== 'undefined' && navigator.serial !== undefined
}

/** The user closed the port picker without choosing anything. */
export function isUserCancel(e: unknown): boolean {
  return e instanceof DOMException && e.name === 'NotFoundError'
}

type Link = {
  port: SerialPort
  id: number
  reader: ReadableStreamDefaultReader<Uint8Array> | null
  closing: boolean
  /** Settles once the HELLO write lets go of the port. */
  hello: Promise<void>
  /** Settles once reading stopped and the port is closed. */
  done: Promise<void>
}

/**
 * Owns the companions' serial ports: opens them, reads lines into the companion store and
 * notices unplugging. Ports this site was given before open by themselves, at load and
 * when plugged in, unless the user disconnected them.
 */
class CompanionLink {
  readonly supported = isWebSerialAvailable()
  private links = new Map<SerialPort, Link>()
  private ids = new Map<SerialPort, number>()
  private ports = new Map<number, SerialPort>()
  /** Disconnected by the user; not reopened automatically. */
  private held = new WeakSet<SerialPort>()

  /** `released`: a previous instance (before a hot reload) still letting go of the ports. */
  constructor(released?: Promise<void>) {
    const serial = navigator.serial
    if (!serial) return
    serial.addEventListener('connect', this.handlePlug)
    serial.addEventListener('disconnect', this.handleUnplug)
    void Promise.resolve(released)
      .then(() => serial.getPorts())
      .then((ports) => {
        for (const port of ports) void this.open(port)
      })
  }

  /** Shows the browser's port picker, so it must run from a click. Throws unless the user just cancelled. */
  async choose(): Promise<void> {
    let port: SerialPort
    try {
      port = await navigator.serial!.requestPort()
    } catch (e) {
      if (isUserCancel(e)) return
      throw e
    }
    this.held.delete(port)
    await this.open(port)
  }

  async connect(id: number) {
    const port = this.ports.get(id)
    if (!port) return
    this.held.delete(port)
    await this.open(port)
  }

  async disconnect(id: number) {
    const port = this.ports.get(id)
    if (!port) return
    this.held.add(port)
    await this.close(port)
    companions.setLink(id, 'closed')
  }

  /** Closes it and drops the site's permission, so it won't open by itself anymore. */
  async forget(id: number) {
    const port = this.ports.get(id)
    if (!port) return
    await this.disconnect(id)
    await port.forget?.().catch(() => {})
    this.drop(id)
  }

  /** Removes a device that is gone from the list. */
  drop(id: number) {
    const port = this.ports.get(id)
    if (port) this.ids.delete(port)
    this.ports.delete(id)
    companions.removeDevice(id)
  }

  /** Closes every port and forgets its devices; used when Vite hot-reloads this module. */
  async dispose() {
    const serial = navigator.serial
    if (!serial) return
    serial.removeEventListener('connect', this.handlePlug)
    serial.removeEventListener('disconnect', this.handleUnplug)
    await Promise.all([...this.links.keys()].map((port) => this.close(port)))
    for (const id of this.ports.keys()) companions.removeDevice(id)
  }

  // ---------------------------------------------------------------------------

  private async open(port: SerialPort) {
    if (this.links.has(port)) return
    let id = this.ids.get(port)
    if (id === undefined) {
      id = companions.addDevice(port.getInfo())
      this.ids.set(port, id)
      this.ports.set(id, port)
    } else {
      companions.setLink(id, 'opening')
    }
    const link: Link = { port, id, reader: null, closing: false, hello: Promise.resolve(), done: Promise.resolve() }
    this.links.set(port, link)

    try {
      await port.open({ baudRate: LINK_BAUD })
    } catch (e) {
      this.links.delete(port)
      // Usually another program (or another tab of this page) has the port.
      companions.setLink(id, 'failed', e instanceof Error ? e.message : String(e))
      return
    }
    if (link.closing) {
      this.links.delete(port)
      await port.close().catch(() => {})
      return
    }
    companions.setLink(id, 'open')
    link.hello = this.hello(port)
    link.done = this.read(link)
  }

  private async close(port: SerialPort) {
    const link = this.links.get(port)
    if (!link) return
    link.closing = true
    await link.reader?.cancel().catch(() => {})
    await link.done
  }

  private async read(link: Link) {
    const { port, id } = link
    const decoder = new TextDecoder()
    const lines = new LineSplitter()
    const openedAt = performance.now()
    let ended = false
    let previous: ReadableStream<Uint8Array> | null = null
    // Framing, parity and overrun errors leave a fresh port.readable to carry on with;
    // an unplugged device leaves none.
    while (!ended && !link.closing && port.readable && port.readable !== previous) {
      previous = port.readable
      const reader = previous.getReader()
      link.reader = reader
      try {
        for (;;) {
          const { value, done } = await reader.read()
          if (done) {
            ended = true
            break
          }
          const now = Date.now()
          const backlog = performance.now() - openedAt < BACKLOG_MS
          for (const line of lines.push(decoder.decode(value, { stream: true }))) {
            companions.handleLine(id, line, now, backlog)
          }
        }
      } catch {
        // see the loop condition
      } finally {
        reader.releaseLock()
        link.reader = null
      }
    }
    this.links.delete(port)
    await link.hello
    await port.close().catch(() => {})
    if (!link.closing) companions.setLink(id, 'lost')
  }

  /** Asks a companion for its ID line. A plain NMEA GPS just ignores it. */
  private hello(port: SerialPort): Promise<void> {
    // not fatal when it fails: the device also sends its ID at power-on
    return this.write(port, 'PSTK,HELLO').then(() => {})
  }

  /** Sends a command (a sentence body like "PSTK,ACCEPT,A1B2C3") to a device. False when it couldn't. */
  send(deviceId: number, body: string): Promise<boolean> {
    const port = this.ports.get(deviceId)
    if (!port || !this.links.has(port)) return Promise.resolve(false)
    return this.write(port, body)
  }

  /** Writes go one after another: a port has a single writer at a time. */
  private writes = new WeakMap<SerialPort, Promise<boolean>>()

  private write(port: SerialPort, body: string): Promise<boolean> {
    const previous = this.writes.get(port) ?? Promise.resolve(true)
    const next = previous.then(async () => {
      const writer = port.writable?.getWriter()
      if (!writer) return false
      try {
        await writer.write(new TextEncoder().encode(sentence(body)))
        return true
      } catch {
        return false
      } finally {
        writer.releaseLock()
      }
    })
    this.writes.set(port, next)
    return next
  }

  private handlePlug = (event: Event) => {
    const port = event.target as SerialPort
    if (!this.held.has(port)) void this.open(port)
  }

  private handleUnplug = (event: Event) => {
    const port = event.target as SerialPort
    const id = this.ids.get(port)
    if (id === undefined || this.links.has(port)) return
    // An open port finds out from its reader and shows as unplugged; one that wasn't open just goes away.
    const link = companions.getState().devices.find((d) => d.id === id)?.link
    if (link === 'closed' || link === 'failed') this.drop(id)
  }
}

export const companionLink = new CompanionLink(import.meta.hot?.data.released)

if (import.meta.hot) {
  import.meta.hot.dispose((data) => {
    data.released = companionLink.dispose()
  })
}
