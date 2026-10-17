import { FFT } from './fft'

/** 4-term Blackman-Harris: low leakage, so weak sondes next to strong carriers stay visible. */
function blackmanHarris(size: number): Float64Array {
  const w = new Float64Array(size)
  for (let i = 0; i < size; i++) {
    const x = (2 * Math.PI * i) / (size - 1)
    w[i] = 0.35875 - 0.48829 * Math.cos(x) + 0.14128 * Math.cos(2 * x) - 0.01168 * Math.cos(3 * x)
  }
  return w
}

/**
 * Turns a stream of raw 8-bit IQ into averaged power spectra.
 * Every FFT in a frame period is averaged (Welch, no overlap), which lowers the
 * noise variance and makes faint carriers stand out.
 */
export class SpectrumAnalyzer {
  readonly size: number
  private fft: FFT
  private window: Float64Array
  /** Squared window sum; scales a full-scale tone to 0 dBFS. */
  private windowPower: number
  private re: Float64Array
  private im: Float64Array
  private power: Float64Array
  private fill = 0
  private averaged = 0
  private samplesInFrame = 0
  private clippedSamples = 0
  private countedSamples = 0

  constructor(size: number) {
    this.size = size
    this.fft = new FFT(size)
    this.window = blackmanHarris(size)
    let sum = 0
    for (const v of this.window) sum += v
    this.windowPower = sum * sum
    this.re = new Float64Array(size)
    this.im = new Float64Array(size)
    this.power = new Float64Array(size)
  }

  reset() {
    this.fill = 0
    this.averaged = 0
    this.samplesInFrame = 0
    this.clippedSamples = 0
    this.countedSamples = 0
    this.power.fill(0)
  }

  /**
   * Feeds interleaved u8 I/Q. Calls onFrame each time samplesPerFrame samples
   * have gone by, with dBFS bins (lowest frequency first) and the clip ratio.
   */
  push(iq: Uint8Array, samplesPerFrame: number, onFrame: (bins: Float32Array, clipFraction: number) => void) {
    const count = iq.length >> 1
    if (count === 0) return

    // Remove this block's DC offset so the center spike doesn't dominate.
    let sumI = 0
    let sumQ = 0
    let clipped = 0
    for (let k = 0; k < iq.length; k += 2) {
      const i = iq[k]
      const q = iq[k + 1]
      sumI += i
      sumQ += q
      if (i === 0 || i === 255) clipped++
      if (q === 0 || q === 255) clipped++
    }
    this.clippedSamples += clipped
    this.countedSamples += iq.length
    const dcI = sumI / count
    const dcQ = sumQ / count

    const { size, window, re, im, power } = this
    for (let s = 0; s < count; s++) {
      const w = window[this.fill] / 128
      re[this.fill] = (iq[2 * s] - dcI) * w
      im[this.fill] = (iq[2 * s + 1] - dcQ) * w
      if (++this.fill === size) {
        this.fft.transform(re, im)
        for (let k = 0; k < size; k++) power[k] += re[k] * re[k] + im[k] * im[k]
        this.fill = 0
        this.averaged++
      }
      if (++this.samplesInFrame >= samplesPerFrame && this.averaged > 0) {
        const clipFraction = this.countedSamples ? this.clippedSamples / this.countedSamples : 0
        onFrame(this.takeFrame(), clipFraction)
      }
    }
  }

  private takeFrame(): Float32Array {
    const { size, power } = this
    const bins = new Float32Array(size)
    const scale = 1 / (this.averaged * this.windowPower)
    const half = size >> 1
    for (let k = 0; k < size; k++) {
      // FFT order is DC..+fs/2, -fs/2..DC; rotate so bins run -fs/2..+fs/2.
      bins[k] = 10 * Math.log10(power[(k + half) % size] * scale + 1e-20)
    }
    power.fill(0)
    this.averaged = 0
    this.samplesInFrame = 0
    this.clippedSamples = 0
    this.countedSamples = 0
    return bins
  }
}

/** Noise floor (median bin) and strongest bin, skipping the bins around DC. */
export function summarize(bins: Float32Array, centerFrequency: number, sampleRate: number) {
  const sorted = Float32Array.from(bins).sort()
  const noiseFloorDb = sorted[sorted.length >> 1]

  const size = bins.length
  const center = size >> 1
  const guard = Math.max(2, Math.round(size / 1024))
  let peakIndex = 0
  let peakDb = -Infinity
  for (let k = 0; k < size; k++) {
    if (Math.abs(k - center) <= guard) continue
    if (bins[k] > peakDb) {
      peakDb = bins[k]
      peakIndex = k
    }
  }
  const peakFrequency = centerFrequency + ((peakIndex - center) * sampleRate) / size
  return { noiseFloorDb, peakDb, peakFrequency }
}
