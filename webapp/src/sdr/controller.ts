import type { DecoderStatus, DspInMessage, DspOutMessage, SpectrumFrame } from '../dsp/messages'
import { sondes } from '../sonde/store'
import {
  deviceLabel,
  findAuthorizedDevice,
  isWebUsbAvailable,
  requestDevice,
  RtlSdr,
} from './device'
import { describeError, describeStreamError, isUserCancel, UNPLUGGED, type SdrProblem } from './errors'
import type { IqBlock, SdrDeviceInfo, SdrSettings } from './types'

export type Phase = 'unsupported' | 'disconnected' | 'connecting' | 'connected' | 'streaming'

export type StreamStats = {
  /** IQ rate actually arriving over USB in the last second, samples/s. */
  measuredRate: number
  blocks: number
  /** Blocks not sent to the DSP worker because it was falling behind. */
  droppedBlocks: number
  startedAt: number
}

export type SignalStats = {
  noiseFloorDb: number
  peakDb: number
  peakFrequency: number
  clipFraction: number
}

export type SdrState = {
  phase: Phase
  device: SdrDeviceInfo | null
  /** Name of a dongle this site may already open, so Connect can skip the picker. */
  authorizedDevice: string | null
  settings: SdrSettings
  fftSize: number
  /** Frequency picked on the spectrum, Hz. The RS41 decoder listens here. */
  marker: number | null
  stats: StreamStats | null
  signal: SignalStats | null
  decoder: DecoderStatus | null
  problem: SdrProblem | null
}

export const DEFAULT_SETTINGS: SdrSettings = {
  centerFrequency: 403_000_000,
  sampleRate: 2_400_000,
  gain: null,
  ppm: 0,
  biasTee: false,
}

export const FFT_SIZES = [2048, 4096, 8192, 16384] as const
const DEFAULT_FFT_SIZE = 4096
const FRAMES_PER_SECOND = 25
/** About one second of blocks; beyond this the display skips blocks instead of lagging. */
const MAX_DSP_BACKLOG = 20

const STORAGE_KEY = 'sondetracker.sdr.v1'

type Persisted = Pick<SdrState, 'settings' | 'fftSize' | 'marker'>

function loadPersisted(): Persisted {
  const fallback: Persisted = { settings: DEFAULT_SETTINGS, fftSize: DEFAULT_FFT_SIZE, marker: null }
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return fallback
    const saved = JSON.parse(raw) as Partial<Persisted>
    const s: Partial<SdrSettings> = saved.settings ?? {}
    const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d)
    return {
      settings: {
        centerFrequency: num(s.centerFrequency, DEFAULT_SETTINGS.centerFrequency),
        sampleRate: num(s.sampleRate, DEFAULT_SETTINGS.sampleRate),
        gain: s.gain === null ? null : num(s.gain, 0),
        ppm: num(s.ppm, 0),
        biasTee: s.biasTee === true,
      },
      fftSize: (FFT_SIZES as readonly number[]).includes(saved.fftSize ?? 0) ? saved.fftSize! : DEFAULT_FFT_SIZE,
      marker: typeof saved.marker === 'number' ? saved.marker : null,
    }
  } catch {
    return fallback
  }
}

function savePersisted(p: Persisted) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(p))
  } catch {
    // Private windows may refuse storage; settings just won't stick.
  }
}

/**
 * Owns the dongle and the DSP worker. React reads its state through
 * useSyncExternalStore; spectrum frames go straight to subscribers so the
 * 25 fps display never re-renders React.
 */
export class SdrController {
  private state: SdrState
  private listeners = new Set<() => void>()
  private spectrumListeners = new Set<(frame: SpectrumFrame) => void>()

  private sdr: RtlSdr | null = null
  private authorized: USBDevice | undefined
  private worker: Worker | null = null
  private applying = false
  private applyAgain = false

  private rateWindow: { t: number; bytes: number }[] = []
  private blocks = 0
  private posted = 0
  private processed = 0
  private dropped = 0
  private startedAt = 0
  private statsTimer: ReturnType<typeof setInterval> | undefined
  private lastSignalUpdate = 0

  constructor() {
    const supported = isWebUsbAvailable()
    this.state = {
      phase: supported ? 'disconnected' : 'unsupported',
      device: null,
      authorizedDevice: null,
      stats: null,
      signal: null,
      decoder: null,
      problem: null,
      ...loadPersisted(),
    }
    if (supported) {
      navigator.usb.addEventListener('connect', this.refreshAuthorized)
      navigator.usb.addEventListener('disconnect', this.handleUsbDisconnect)
      void this.refreshAuthorized()
    }
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getState = () => this.state

  onSpectrum(listener: (frame: SpectrumFrame) => void): () => void {
    this.spectrumListeners.add(listener)
    return () => {
      this.spectrumListeners.delete(listener)
    }
  }

  /** Opens the dongle and starts streaming. `choose` forces the device picker. */
  async connect(options: { choose?: boolean } = {}): Promise<void> {
    if (this.state.phase !== 'disconnected') return
    // requestDevice() needs the click's user activation, so it runs before any await.
    const picked = !options.choose && this.authorized ? Promise.resolve(this.authorized) : requestDevice()
    this.set({ phase: 'connecting', problem: null })

    let usb: USBDevice
    try {
      usb = await picked
    } catch (e) {
      this.set({ phase: 'disconnected', problem: isUserCancel(e) ? null : describeError(e) })
      return
    }

    try {
      const sdr = await RtlSdr.open(usb)
      this.sdr = sdr
      await sdr.apply(this.state.settings)
      this.set({ phase: 'connected', device: sdr.info })
      void this.refreshAuthorized()
      await this.startStream()
    } catch (e) {
      await this.teardown()
      this.set({ phase: 'disconnected', device: null, problem: describeError(e) })
    }
  }

  async disconnect(): Promise<void> {
    if (!this.sdr) return
    await this.teardown()
    this.set({ phase: 'disconnected', device: null, stats: null, signal: null, decoder: null })
  }

  async startStream(): Promise<void> {
    const sdr = this.sdr
    if (!sdr || this.state.phase !== 'connected') return
    this.postToWorker({ type: 'reset' })
    this.rateWindow = []
    this.blocks = this.posted = this.processed = this.dropped = 0
    this.startedAt = performance.now()
    await sdr.start(this.handleBlock, this.handleStreamError)
    this.set({ phase: 'streaming', stats: this.computeStats() })
    clearInterval(this.statsTimer)
    this.statsTimer = setInterval(() => this.set({ stats: this.computeStats() }), 500)
  }

  async stopStream(): Promise<void> {
    if (!this.sdr || this.state.phase !== 'streaming') return
    clearInterval(this.statsTimer)
    await this.sdr.stop()
    this.set({ phase: 'connected', stats: null, signal: null, decoder: null })
  }

  updateSettings(patch: Partial<SdrSettings>) {
    this.set({ settings: { ...this.state.settings, ...patch } })
    this.persist()
    void this.flushSettings()
  }

  setFftSize(fftSize: number) {
    this.set({ fftSize })
    this.persist()
    this.worker?.postMessage({ type: 'configure', fftSize, framesPerSecond: FRAMES_PER_SECOND } satisfies DspInMessage)
  }

  setMarker(marker: number | null) {
    this.set({ marker })
    this.persist()
    this.worker?.postMessage({ type: 'decoder', frequency: marker } satisfies DspInMessage)
  }

  dismissProblem() {
    this.set({ problem: null })
  }

  /** Releases the dongle; used when Vite hot-reloads this module. */
  dispose() {
    if (isWebUsbAvailable()) {
      navigator.usb.removeEventListener('connect', this.refreshAuthorized)
      navigator.usb.removeEventListener('disconnect', this.handleUsbDisconnect)
    }
    void this.teardown()
    this.worker?.terminate()
    this.worker = null
  }

  // ---------------------------------------------------------------------------

  private set(patch: Partial<SdrState>) {
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) listener()
  }

  private persist() {
    const { settings, fftSize, marker } = this.state
    savePersisted({ settings, fftSize, marker })
  }

  /** Applies the latest settings, coalescing bursts (e.g. dragging the gain slider). */
  private async flushSettings() {
    const sdr = this.sdr
    if (!sdr) return
    if (this.applying) {
      this.applyAgain = true
      return
    }
    this.applying = true
    try {
      do {
        this.applyAgain = false
        await sdr.apply(this.state.settings)
      } while (this.applyAgain && this.sdr === sdr)
    } catch (e) {
      this.set({ problem: describeError(e) })
    } finally {
      this.applying = false
    }
  }

  private async teardown() {
    clearInterval(this.statsTimer)
    const sdr = this.sdr
    this.sdr = null
    if (sdr) await sdr.close().catch(() => {})
  }

  private refreshAuthorized = async () => {
    try {
      this.authorized = await findAuthorizedDevice()
    } catch {
      this.authorized = undefined
    }
    this.set({ authorizedDevice: this.authorized ? deviceLabel(this.authorized) : null })
  }

  private handleUsbDisconnect = (event: USBConnectionEvent) => {
    if (this.sdr && event.device === this.sdr.usb) {
      void this.teardown()
      this.set({ phase: 'disconnected', device: null, stats: null, signal: null, decoder: null, problem: UNPLUGGED })
    }
    void this.refreshAuthorized()
  }

  private handleStreamError = (error: unknown) => {
    void this.teardown()
    this.set({ phase: 'disconnected', device: null, stats: null, signal: null, decoder: null, problem: describeStreamError(error) })
  }

  private handleBlock = (block: IqBlock) => {
    this.blocks++
    this.rateWindow.push({ t: block.receivedAt, bytes: block.data.byteLength })
    while (this.rateWindow.length > 2 && block.receivedAt - this.rateWindow[0].t > 1000) this.rateWindow.shift()

    if (this.posted - this.processed > MAX_DSP_BACKLOG) {
      this.dropped++
      return
    }
    this.posted++
    const message: DspInMessage = {
      type: 'iq',
      data: block.data,
      centerFrequency: block.centerFrequency,
      sampleRate: block.sampleRate,
    }
    this.postToWorker(message, [block.data])
  }

  private handleDsp = (event: MessageEvent<DspOutMessage>) => {
    const msg = event.data
    if (msg.type === 'sonde-fix') {
      sondes.addFix(msg.fix)
      return
    }
    if (msg.type === 'decoder') {
      // Only meaningful while samples flow; a late status after Pause would resurrect it.
      if (this.state.phase === 'streaming') this.set({ decoder: msg.status })
      return
    }
    const frame = msg
    this.processed = frame.blocksProcessed
    for (const listener of this.spectrumListeners) listener(frame)

    const now = performance.now()
    if (now - this.lastSignalUpdate > 250) {
      this.lastSignalUpdate = now
      const { noiseFloorDb, peakDb, peakFrequency, clipFraction } = frame
      this.set({ signal: { noiseFloorDb, peakDb, peakFrequency, clipFraction } })
    }
  }

  private postToWorker(message: DspInMessage, transfer: Transferable[] = []) {
    if (!this.worker) {
      this.worker = new Worker(new URL('../dsp/dsp.worker.ts', import.meta.url), { type: 'module' })
      this.worker.onmessage = this.handleDsp
      this.worker.onerror = (e) => console.error('DSP worker error', e)
      const configure: DspInMessage = {
        type: 'configure',
        fftSize: this.state.fftSize,
        framesPerSecond: FRAMES_PER_SECOND,
      }
      this.worker.postMessage(configure)
      this.worker.postMessage({ type: 'decoder', frequency: this.state.marker } satisfies DspInMessage)
    }
    this.worker.postMessage(message, transfer)
  }

  private computeStats(): StreamStats {
    const w = this.rateWindow
    let measuredRate = 0
    if (w.length >= 2) {
      const span = w[w.length - 1].t - w[0].t
      let bytes = 0
      for (let i = 1; i < w.length; i++) bytes += w[i].bytes
      if (span > 0) measuredRate = bytes / 2 / (span / 1000)
    }
    return { measuredRate, blocks: this.blocks, droppedBlocks: this.dropped, startedAt: this.startedAt }
  }
}

export const sdr = new SdrController()

if (import.meta.hot) {
  import.meta.hot.dispose(() => sdr.dispose())
}
