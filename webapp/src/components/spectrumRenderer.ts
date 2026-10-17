import type { SpectrumFrame } from '../dsp/messages'

export type Levels = {
  auto: boolean
  /** dBFS at the bottom of the plot / darkest waterfall color. */
  min: number
  /** dBFS at the top of the plot / brightest waterfall color. */
  max: number
}

/** Radiosonde allocation; its edges get drawn when they fall inside the view. */
export const SONDE_BAND = { low: 400_150_000, high: 406_000_000 }

const AXIS_HEIGHT = 22
const DB_GRID_STEP = 10
const COLOR_STOPS: [number, [number, number, number]][] = [
  [0.0, [4, 6, 18]],
  [0.18, [14, 26, 82]],
  [0.38, [22, 96, 168]],
  [0.58, [32, 186, 190]],
  [0.74, [196, 228, 84]],
  [0.88, [255, 170, 40]],
  [1.0, [255, 64, 64]],
]

function buildColormap(): Uint8ClampedArray {
  const lut = new Uint8ClampedArray(256 * 4)
  for (let i = 0; i < 256; i++) {
    const t = i / 255
    let s = 0
    while (s < COLOR_STOPS.length - 2 && t > COLOR_STOPS[s + 1][0]) s++
    const [t0, c0] = COLOR_STOPS[s]
    const [t1, c1] = COLOR_STOPS[s + 1]
    const f = (t - t0) / (t1 - t0)
    lut[i * 4] = c0[0] + (c1[0] - c0[0]) * f
    lut[i * 4 + 1] = c0[1] + (c1[1] - c0[1]) * f
    lut[i * 4 + 2] = c0[2] + (c1[2] - c0[2]) * f
    lut[i * 4 + 3] = 255
  }
  return lut
}

/** Max-pools FFT bins down (or nearest-samples up) to one value per pixel column. */
function poolBins(bins: Float32Array, out: Float32Array) {
  const n = bins.length
  const w = out.length
  for (let x = 0; x < w; x++) {
    const a = Math.floor((x * n) / w)
    const b = Math.max(a + 1, Math.floor(((x + 1) * n) / w))
    let m = -Infinity
    for (let i = a; i < b; i++) if (bins[i] > m) m = bins[i]
    out[x] = m
  }
}

function niceStep(span: number, maxTicks: number): number {
  const raw = span / Math.max(1, maxTicks)
  const exp = Math.pow(10, Math.floor(Math.log10(raw)))
  for (const m of [1, 2, 2.5, 5, 10]) if (m * exp >= raw) return m * exp
  return 10 * exp
}

function readThemeColors() {
  const style = getComputedStyle(document.documentElement)
  const get = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback
  return {
    plotBg: get('--plot-bg', '#070b12'),
    grid: get('--plot-grid', 'rgba(255,255,255,0.07)'),
    label: get('--muted', '#8b98a8'),
    trace: get('--accent', '#5cc8ff'),
    band: get('--warn', '#f5b942'),
  }
}

/**
 * Draws the live spectrum trace and the scrolling waterfall onto two canvases.
 * Runs its own requestAnimationFrame loop; React only feeds it frames and options.
 */
export class SpectrumRenderer {
  private spectrum: HTMLCanvasElement
  private waterfall: HTMLCanvasElement
  private sctx: CanvasRenderingContext2D
  private wctx: CanvasRenderingContext2D
  private lut = buildColormap()
  private dpr = 1
  private colors = readThemeColors()

  private latest: SpectrumFrame | null = null
  private pendingRows: SpectrumFrame[] = []
  private pooled = new Float32Array(0)
  private rowImage: ImageData | null = null
  private waterfallTuning = ''
  private smoothedFloor: number | null = null
  private dirty = true
  private raf = 0

  levels: Levels = { auto: true, min: -100, max: -40 }

  constructor(spectrum: HTMLCanvasElement, waterfall: HTMLCanvasElement) {
    this.spectrum = spectrum
    this.waterfall = waterfall
    this.sctx = spectrum.getContext('2d')!
    this.wctx = waterfall.getContext('2d', { willReadFrequently: false })!
    this.resize()
    this.raf = requestAnimationFrame(this.draw)
  }

  destroy() {
    cancelAnimationFrame(this.raf)
  }

  push(frame: SpectrumFrame) {
    this.latest = frame
    this.pendingRows.push(frame)
    if (this.pendingRows.length > 10) this.pendingRows.shift()
    if (this.levels.auto) {
      const f = frame.noiseFloorDb
      this.smoothedFloor = this.smoothedFloor === null ? f : this.smoothedFloor + (f - this.smoothedFloor) * 0.05
    }
    this.dirty = true
  }

  /** Forget the current trace, e.g. when streaming stops. */
  clear() {
    this.latest = null
    this.pendingRows = []
    this.wctx.fillStyle = '#04060f'
    this.wctx.fillRect(0, 0, this.waterfall.width, this.waterfall.height)
    this.dirty = true
  }

  setLevels(levels: Levels) {
    this.levels = levels
    this.dirty = true
  }

  /** The dB range actually in use (resolves auto levels). */
  effectiveRange(): { min: number; max: number } {
    if (this.levels.auto && this.smoothedFloor !== null) {
      return { min: Math.round(this.smoothedFloor - 8), max: Math.round(this.smoothedFloor + 52) }
    }
    return { min: this.levels.min, max: this.levels.max }
  }

  /** Level of the latest trace at a horizontal position (0..1). */
  levelAt(fraction: number): number | null {
    const bins = this.latest?.bins
    if (!bins) return null
    const i = Math.min(bins.length - 1, Math.max(0, Math.floor(fraction * bins.length)))
    // Report the local max over a few bins, matching what the pooled trace shows.
    let m = -Infinity
    for (let k = Math.max(0, i - 2); k <= Math.min(bins.length - 1, i + 2); k++) m = Math.max(m, bins[k])
    return m
  }

  resize() {
    this.dpr = window.devicePixelRatio || 1
    this.colors = readThemeColors()
    const fit = (c: HTMLCanvasElement) => {
      const w = Math.max(1, Math.round(c.clientWidth * this.dpr))
      const h = Math.max(1, Math.round(c.clientHeight * this.dpr))
      if (c.width !== w || c.height !== h) {
        c.width = w
        c.height = h
        return true
      }
      return false
    }
    fit(this.spectrum)
    if (fit(this.waterfall)) {
      this.wctx.fillStyle = '#04060f'
      this.wctx.fillRect(0, 0, this.waterfall.width, this.waterfall.height)
      this.rowImage = null
    }
    this.dirty = true
  }

  private draw = () => {
    this.raf = requestAnimationFrame(this.draw)
    if (this.pendingRows.length) this.drawWaterfallRows()
    if (this.dirty) {
      this.dirty = false
      this.drawSpectrum()
    }
  }

  private pool(frame: SpectrumFrame, width: number): Float32Array {
    if (this.pooled.length !== width) this.pooled = new Float32Array(width)
    poolBins(frame.bins, this.pooled)
    return this.pooled
  }

  private drawWaterfallRows() {
    const c = this.waterfall
    const ctx = this.wctx
    const { min, max } = this.effectiveRange()
    const rowHeight = Math.max(1, Math.round(this.dpr))
    for (const frame of this.pendingRows) {
      // A retune makes old rows meaningless; start the waterfall over.
      const tuning = `${frame.centerFrequency}/${frame.sampleRate}`
      if (tuning !== this.waterfallTuning) {
        this.waterfallTuning = tuning
        ctx.fillStyle = '#04060f'
        ctx.fillRect(0, 0, c.width, c.height)
      }
      const row = this.pool(frame, c.width)
      if (!this.rowImage || this.rowImage.width !== c.width || this.rowImage.height !== rowHeight) {
        this.rowImage = ctx.createImageData(c.width, rowHeight)
      }
      const px = this.rowImage.data
      const scale = 255 / Math.max(1, max - min)
      for (let x = 0; x < c.width; x++) {
        const v = Math.min(255, Math.max(0, Math.round((row[x] - min) * scale))) * 4
        for (let y = 0; y < rowHeight; y++) {
          const o = (y * c.width + x) * 4
          px[o] = this.lut[v]
          px[o + 1] = this.lut[v + 1]
          px[o + 2] = this.lut[v + 2]
          px[o + 3] = 255
        }
      }
      ctx.drawImage(c, 0, 0, c.width, c.height - rowHeight, 0, rowHeight, c.width, c.height - rowHeight)
      ctx.putImageData(this.rowImage, 0, 0)
    }
    this.pendingRows = []
  }

  private drawSpectrum() {
    const c = this.spectrum
    const ctx = this.sctx
    const dpr = this.dpr
    const W = c.width
    const H = c.height
    const axisH = Math.round(AXIS_HEIGHT * dpr)
    const plotH = H - axisH
    const { min, max } = this.effectiveRange()
    const yOf = (db: number) => ((max - db) / (max - min)) * plotH

    const { plotBg, grid, label, trace, band } = this.colors

    ctx.clearRect(0, 0, W, H)
    ctx.fillStyle = plotBg
    ctx.fillRect(0, 0, W, plotH)

    ctx.font = `${11 * dpr}px ui-monospace, Consolas, monospace`
    ctx.lineWidth = 1

    // dB grid
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    for (let db = Math.ceil(min / DB_GRID_STEP) * DB_GRID_STEP; db <= max; db += DB_GRID_STEP) {
      const y = Math.round(yOf(db)) + 0.5
      ctx.strokeStyle = grid
      ctx.beginPath()
      ctx.moveTo(0, y)
      ctx.lineTo(W, y)
      ctx.stroke()
      ctx.fillStyle = label
      ctx.fillText(`${db}`, 4 * dpr, Math.min(plotH - 6 * dpr, Math.max(6 * dpr, y)))
    }

    const frame = this.latest
    if (!frame) return

    // Frequency grid and axis
    const span = frame.sampleRate
    const start = frame.centerFrequency - span / 2
    const xOf = (hz: number) => ((hz - start) / span) * W
    const step = niceStep(span, W / (dpr * 110))
    const decimals = Math.max(0, Math.ceil(-Math.log10(step / 1e6) - 1e-9))
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    for (let f = Math.ceil(start / step) * step; f <= start + span; f += step) {
      const x = Math.round(xOf(f)) + 0.5
      ctx.strokeStyle = grid
      ctx.beginPath()
      ctx.moveTo(x, 0)
      ctx.lineTo(x, plotH)
      ctx.stroke()
      ctx.fillStyle = label
      ctx.fillText((f / 1e6).toFixed(decimals), x, plotH + 5 * dpr)
    }

    // Sonde band edges
    ctx.strokeStyle = band
    ctx.setLineDash([4 * dpr, 4 * dpr])
    for (const edge of [SONDE_BAND.low, SONDE_BAND.high]) {
      if (edge > start && edge < start + span) {
        const x = Math.round(xOf(edge)) + 0.5
        ctx.beginPath()
        ctx.moveTo(x, 0)
        ctx.lineTo(x, plotH)
        ctx.stroke()
      }
    }
    ctx.setLineDash([])

    // Trace with a soft fill underneath
    const row = this.pool(frame, W)
    ctx.beginPath()
    for (let x = 0; x < W; x++) {
      const y = Math.min(plotH, Math.max(0, yOf(row[x])))
      if (x === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    ctx.strokeStyle = trace
    ctx.lineWidth = Math.max(1, dpr)
    ctx.stroke()
    ctx.lineTo(W, plotH)
    ctx.lineTo(0, plotH)
    ctx.closePath()
    const fill = ctx.createLinearGradient(0, 0, 0, plotH)
    fill.addColorStop(0, 'rgba(92,200,255,0.28)')
    fill.addColorStop(1, 'rgba(92,200,255,0.02)')
    ctx.fillStyle = fill
    ctx.fill()
  }
}
