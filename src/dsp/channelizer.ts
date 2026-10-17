/** Zeroth-order modified Bessel function, for the Kaiser window. */
function besselI0(x: number): number {
  let sum = 1
  let term = 1
  for (let k = 1; k < 50; k++) {
    term *= (x / (2 * k)) ** 2
    sum += term
    if (term < sum * 1e-12) break
  }
  return sum
}

/**
 * Kaiser-windowed sinc lowpass, unity gain at DC. Flat to passHz, at least
 * attenuationDb down from stopHz. Odd length, so the delay is a whole sample.
 */
export function lowpassTaps(rate: number, passHz: number, stopHz: number, attenuationDb = 60): Float32Array {
  const transition = (stopHz - passHz) / rate
  let n = Math.ceil((attenuationDb - 7.95) / (14.36 * transition)) + 1
  if (n % 2 === 0) n++
  const beta = 0.1102 * (attenuationDb - 8.7)
  const cutoff = (passHz + stopHz) / 2 / rate
  const mid = (n - 1) / 2
  const taps = new Float32Array(n)
  let sum = 0
  for (let i = 0; i < n; i++) {
    const x = i - mid
    const sinc = x === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * x) / (Math.PI * x)
    const w = besselI0(beta * Math.sqrt(1 - (x / mid) ** 2)) / besselI0(beta)
    taps[i] = sinc * w
    sum += taps[i]
  }
  for (let i = 0; i < n; i++) taps[i] /= sum
  return taps
}

/** Complex FIR that only computes every `factor`-th output. */
export class DecimatingFir {
  private readonly taps: Float32Array
  private readonly factor: number
  /** Last taps-1 inputs followed by the current block. */
  private re: Float32Array
  private im: Float32Array
  /** Where the next output's window starts in re/im. */
  private next = 0

  constructor(taps: Float32Array, factor: number) {
    this.taps = taps
    this.factor = factor
    this.re = new Float32Array(taps.length - 1)
    this.im = new Float32Array(taps.length - 1)
  }

  /** Writes up to ceil(n / factor) + 1 outputs; returns how many. */
  process(inRe: Float32Array, inIm: Float32Array, n: number, outRe: Float32Array, outIm: Float32Array): number {
    const { taps, factor } = this
    const held = taps.length - 1
    const total = held + n
    if (this.re.length < total) {
      const re = new Float32Array(total * 2)
      const im = new Float32Array(total * 2)
      re.set(this.re.subarray(0, held))
      im.set(this.im.subarray(0, held))
      this.re = re
      this.im = im
    }
    const { re, im } = this
    re.set(inRe.subarray(0, n), held)
    im.set(inIm.subarray(0, n), held)

    let out = 0
    let k = this.next
    for (; k + taps.length <= total; k += factor) {
      let accRe = 0
      let accIm = 0
      for (let j = 0; j < taps.length; j++) {
        accRe += taps[j] * re[k + j]
        accIm += taps[j] * im[k + j]
      }
      outRe[out] = accRe
      outIm[out] = accIm
      out++
    }
    const keepFrom = total - held
    re.copyWithin(0, keepFrom, total)
    im.copyWithin(0, keepFrom, total)
    this.next = k - keepFrom
    return out
  }
}

/** Output rate the channelizer aims for: 10 samples per RS41 symbol. */
const TARGET_RATE = 48_000
/** Flat band each side of the channel center. Covers a sonde ±4 kHz off the marker before AFC pulls it in. */
const CHANNEL_PASS = 9_000
const CHANNEL_STOP = 13_000

class Stage {
  readonly fir: DecimatingFir
  readonly factor: number
  re = new Float32Array(0)
  im = new Float32Array(0)
  constructor(taps: Float32Array, factor: number) {
    this.fir = new DecimatingFir(taps, factor)
    this.factor = factor
  }

  process(inRe: Float32Array, inIm: Float32Array, n: number): number {
    const size = Math.ceil(n / this.factor) + 2
    if (this.re.length < size) {
      this.re = new Float32Array(size)
      this.im = new Float32Array(size)
    }
    return this.fir.process(inRe, inIm, n, this.re, this.im)
  }
}

/**
 * Picks out one narrow channel from the wideband IQ: an NCO mixes it to 0 Hz,
 * then two decimating lowpass stages bring the rate to ~48 kHz and a final
 * FIR sets the channel width. The rate is only approximately 48 kHz
 * (e.g. 2.048 MS/s / 42 = 48.76 kHz); the symbol timing copes with any rate.
 */
export class Channelizer {
  readonly inputRate: number
  readonly outputRate: number
  private phaseStep = { re: 1, im: 0 }
  private phase = { re: 1, im: 0 }
  private mixRe = new Float32Array(0)
  private mixIm = new Float32Array(0)
  private readonly stages: Stage[] = []

  constructor(inputRate: number, offsetHz: number) {
    this.inputRate = inputRate
    let best = { d1: 1, d2: 1, rate: inputRate }
    for (const d2 of [4, 5, 6]) {
      const d1 = Math.max(1, Math.round(inputRate / (TARGET_RATE * d2)))
      const rate = inputRate / (d1 * d2)
      if (Math.abs(rate - TARGET_RATE) < Math.abs(best.rate - TARGET_RATE)) best = { d1, d2, rate }
    }
    const { d1, d2 } = best
    this.outputRate = best.rate
    this.setOffset(offsetHz)

    const rate1 = inputRate / d1
    if (d1 > 1) {
      // Only what would alias into the channel needs to go.
      this.stages.push(new Stage(lowpassTaps(inputRate, CHANNEL_STOP, rate1 - CHANNEL_STOP), d1))
    }
    this.stages.push(new Stage(lowpassTaps(rate1, CHANNEL_STOP, this.outputRate - CHANNEL_STOP), d2))
    this.stages.push(new Stage(lowpassTaps(this.outputRate, CHANNEL_PASS, CHANNEL_STOP), 1))
  }

  /** Channel center relative to the tuner center, Hz. */
  setOffset(offsetHz: number) {
    const w = (-2 * Math.PI * offsetHz) / this.inputRate
    this.phaseStep = { re: Math.cos(w), im: Math.sin(w) }
  }

  /** Feeds interleaved u8 I/Q; returns the channel samples (views reused by the next call). */
  process(iq: Uint8Array): { re: Float32Array; im: Float32Array; length: number } {
    const n = iq.length >> 1
    if (this.mixRe.length < n) {
      this.mixRe = new Float32Array(n)
      this.mixIm = new Float32Array(n)
    }
    const { mixRe, mixIm } = this

    // The dongle's DC offset varies; remove this block's so it can't leak into a channel near center.
    let sumI = 0
    let sumQ = 0
    for (let k = 0; k < iq.length; k += 2) {
      sumI += iq[k]
      sumQ += iq[k + 1]
    }
    const dcI = n ? sumI / n : 127.5
    const dcQ = n ? sumQ / n : 127.5

    let { re: pr, im: pi } = this.phase
    const { re: sr, im: si } = this.phaseStep
    for (let s = 0; s < n; s++) {
      const i = (iq[2 * s] - dcI) / 128
      const q = (iq[2 * s + 1] - dcQ) / 128
      mixRe[s] = i * pr - q * pi
      mixIm[s] = i * pi + q * pr
      const t = pr * sr - pi * si
      pi = pr * si + pi * sr
      pr = t
    }
    // The rotation recurrence drifts off the unit circle very slowly; pull it back once a block.
    const g = 1 / Math.hypot(pr, pi)
    this.phase = { re: pr * g, im: pi * g }

    let re = mixRe
    let im = mixIm
    let length = n
    for (const stage of this.stages) {
      length = stage.process(re, im, length)
      re = stage.re
      im = stage.im
    }
    return { re, im, length }
  }
}

/** Instantaneous frequency of a complex baseband signal, Hz: arg(x[n]·conj(x[n-1])). */
export class FmDiscriminator {
  private readonly scale: number
  private prevRe = 0
  private prevIm = 0

  constructor(rate: number) {
    this.scale = rate / (2 * Math.PI)
  }

  process(re: Float32Array, im: Float32Array, n: number, out: Float32Array) {
    let pr = this.prevRe
    let pi = this.prevIm
    for (let k = 0; k < n; k++) {
      const r = re[k]
      const i = im[k]
      out[k] = Math.atan2(i * pr - r * pi, r * pr + i * pi) * this.scale
      pr = r
      pi = i
    }
    this.prevRe = pr
    this.prevIm = pi
  }
}
