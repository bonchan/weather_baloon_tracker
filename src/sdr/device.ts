import { RTL2832U, type RtlDevice } from '@jtarrio/webrtlsdr/rtlsdr.js'
import { R820T } from '@jtarrio/webrtlsdr/rtlsdr/r820t.js'
import { R828D } from '@jtarrio/webrtlsdr/rtlsdr/r828d.js'
import type { IqBlock, SdrDeviceInfo, SdrSettings } from './types'

/** USB IDs of RTL2832U dongles (generic DVB-T sticks, RTL-SDR Blog, NooElec...). */
export const RTL_USB_FILTERS: USBDeviceFilter[] = [
  { vendorId: 0x0bda, productId: 0x2832 },
  { vendorId: 0x0bda, productId: 0x2838 },
]

/** Bulk transfers kept in flight, so the dongle's small FIFO never overflows between reads. */
const PARALLEL_TRANSFERS = 2
/** Transfers per second; sets how many samples each transfer carries. */
const BLOCKS_PER_SECOND = 20
/** How long stop() waits for in-flight transfers before giving up on them. */
const HALT_TIMEOUT_MS = 1500

export function isWebUsbAvailable(): boolean {
  return typeof navigator !== 'undefined' && 'usb' in navigator
}

function isRtlDongle(d: USBDevice): boolean {
  return RTL_USB_FILTERS.some((f) => f.vendorId === d.vendorId && f.productId === d.productId)
}

export function deviceLabel(d: USBDevice): string {
  return [d.manufacturerName, d.productName].filter(Boolean).join(' ') || 'RTL-SDR'
}

/** A dongle this site was already granted, which can be opened without the picker. */
export async function findAuthorizedDevice(): Promise<USBDevice | undefined> {
  if (!isWebUsbAvailable()) return undefined
  const devices = await navigator.usb.getDevices()
  return devices.find(isRtlDongle)
}

/** Shows the browser's device picker. Must be called from a click handler. */
export function requestDevice(): Promise<USBDevice> {
  return navigator.usb.requestDevice({ filters: RTL_USB_FILTERS })
}

function describeTuner(usb: USBDevice, rtl: RtlDevice): string {
  // The driver keeps the tuner private; peek at it only to show which chip was found.
  const tuner = (rtl as unknown as { tuner?: unknown }).tuner
  if (tuner instanceof R828D) {
    const blogV4 = usb.manufacturerName === 'RTLSDRBlog' && usb.productName === 'Blog V4'
    return blogV4 ? 'R828D (RTL-SDR Blog V4)' : 'R828D'
  }
  if (tuner instanceof R820T) return 'R820T / R820T2 / R860'
  return 'Unknown'
}

/** State of the dongle right after RTL2832U.open(). */
const POWER_ON_SETTINGS: SdrSettings = {
  centerFrequency: 0,
  sampleRate: 0,
  gain: null,
  ppm: 0,
  biasTee: false,
}

/**
 * An open RTL-SDR. Wraps the webrtlsdr driver with serialized configuration
 * (control transfers never interleave) and a continuous sample stream.
 */
export class RtlSdr {
  readonly usb: USBDevice
  readonly info: SdrDeviceInfo
  private rtl: RtlDevice
  private applied: SdrSettings = { ...POWER_ON_SETTINGS }
  private queue: Promise<unknown> = Promise.resolve()

  private streaming = false
  /** Bumped to tell running read loops to exit. */
  private generation = 0
  private activeLoops = 0
  private loopsDrained: (() => void) | null = null
  private onBlock: ((block: IqBlock) => void) | null = null
  private onError: ((error: unknown) => void) | null = null

  private constructor(usb: USBDevice, rtl: RtlDevice) {
    this.usb = usb
    this.rtl = rtl
    this.info = {
      manufacturer: usb.manufacturerName ?? '',
      product: usb.productName ?? '',
      serial: usb.serialNumber ?? '',
      vendorId: usb.vendorId,
      productId: usb.productId,
      tuner: describeTuner(usb, rtl),
    }
  }

  static async open(usb: USBDevice): Promise<RtlSdr> {
    await usb.open()
    try {
      return new RtlSdr(usb, await RTL2832U.open(usb))
    } catch (e) {
      await usb.close().catch(() => {})
      throw e
    }
  }

  get sampleRate(): number {
    return this.applied.sampleRate
  }

  /** Pushes whatever differs from what the dongle currently has. */
  apply(next: SdrSettings): Promise<void> {
    return this.enqueue(async () => {
      const prev = this.applied
      if (prev.sampleRate !== next.sampleRate) {
        const wasStreaming = this.streaming
        if (wasStreaming) await this.haltLoops()
        const actual = await this.rtl.setSampleRate(next.sampleRate)
        this.applied = { ...this.applied, sampleRate: actual }
        if (wasStreaming) await this.startLoops()
      }
      if (prev.ppm !== next.ppm) {
        await this.rtl.setFrequencyCorrection(next.ppm)
        this.applied = { ...this.applied, ppm: next.ppm }
      }
      if (prev.centerFrequency !== next.centerFrequency) {
        await this.rtl.setCenterFrequency(next.centerFrequency)
        this.applied = { ...this.applied, centerFrequency: next.centerFrequency }
      }
      if (prev.gain !== next.gain) {
        await this.rtl.setGain(next.gain)
        this.applied = { ...this.applied, gain: next.gain }
      }
      if (prev.biasTee !== next.biasTee) {
        await this.rtl.enableBiasTee(next.biasTee)
        this.applied = { ...this.applied, biasTee: next.biasTee }
      }
    })
  }

  /** Starts streaming. onBlock is called for every transfer, in order. */
  start(onBlock: (block: IqBlock) => void, onError: (error: unknown) => void): Promise<void> {
    return this.enqueue(async () => {
      if (this.streaming) return
      this.onBlock = onBlock
      this.onError = onError
      this.streaming = true
      await this.startLoops()
    })
  }

  stop(): Promise<void> {
    return this.enqueue(async () => {
      if (!this.streaming) return
      this.streaming = false
      await this.haltLoops()
    })
  }

  close(): Promise<void> {
    return this.enqueue(async () => {
      this.streaming = false
      await this.haltLoops()
      try {
        await this.rtl.close()
      } catch {
        // Unplugged devices can't be shut down cleanly; just let go of them.
        await this.usb.close().catch(() => {})
      }
    })
  }

  private async startLoops(): Promise<void> {
    await this.rtl.resetBuffer()
    const generation = ++this.generation
    const samplesPerBlock = 512 * Math.ceil(this.applied.sampleRate / BLOCKS_PER_SECOND / 512)
    for (let i = 0; i < PARALLEL_TRANSFERS; i++) void this.readLoop(generation, samplesPerBlock)
  }

  private async readLoop(generation: number, samplesPerBlock: number): Promise<void> {
    this.activeLoops++
    try {
      while (generation === this.generation) {
        const block = await this.rtl.readSamples(samplesPerBlock)
        if (generation !== this.generation) break
        this.onBlock?.({
          data: block.data,
          centerFrequency: block.frequency,
          sampleRate: this.applied.sampleRate,
          receivedAt: performance.now(),
        })
      }
    } catch (e) {
      // Only the first failing loop reports; the rest just wind down.
      if (generation === this.generation) {
        this.generation++
        this.streaming = false
        this.onError?.(e)
      }
    } finally {
      this.activeLoops--
      if (this.activeLoops === 0) {
        this.loopsDrained?.()
        this.loopsDrained = null
      }
    }
  }

  /** Stops the read loops and waits for their in-flight transfers to land. */
  private haltLoops(): Promise<void> {
    this.generation++
    if (this.activeLoops === 0) return Promise.resolve()
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, HALT_TIMEOUT_MS)
      this.loopsDrained = () => {
        clearTimeout(timer)
        resolve()
      }
    })
  }

  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = this.queue.then(job)
    this.queue = run.catch(() => {})
    return run
  }
}
