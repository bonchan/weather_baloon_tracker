import { BAUD_RATE, EXTENDED_LENGTH, FRAME_TYPE_POS, frameLength, HEADER_BITS, HEADER_BYTES, MASK, STANDARD_LENGTH } from './protocol'

/** A frame as it came off the air: descrambled, not yet error-corrected. */
export type RawFrame = {
  /** 518 bytes; past `length` it is zero. */
  bytes: Uint8Array
  length: number
  /** Carrier offset from the channel center, Hz (the FM discriminator's DC level). */
  offset: number
  /** Normalized correlation with the header, 0..1. */
  score: number
}

const HEADER_LENGTH = HEADER_BITS.length
/** Normalized header correlation needed to start reading a frame. Noise alone stays well below. */
const SYNC_THRESHOLD = 0.65
/** Share of the measured timing error corrected per bit transition. */
const TIMING_GAIN = 0.06
/** How fast the carrier offset estimate follows the signal during a frame. */
const OFFSET_GAIN = 0.02

type Reading = {
  /** Sample position (fractional) of the next bit's center. */
  t: number
  bytes: Uint8Array
  length: number
  index: number
  bitInByte: number
  acc: number
  /** Discriminator level for "no deviation" and for a full symbol swing, Hz. */
  offset: number
  swing: number
  /** Last bit's normalized soft value, for the timing detector. */
  prev: number
  score: number
}

/**
 * RS41 GFSK demodulator. Takes the FM discriminator output (Hz), averages over one
 * symbol (a matched filter for near-rectangular pulses), finds the header by
 * correlation, then samples one bit per symbol with Gardner timing recovery.
 * The polarity and the carrier offset come from the header, so neither an
 * inverted spectrum nor a sonde a few kHz off frequency gets in the way.
 */
export class Rs41Demodulator {
  readonly samplesPerSymbol: number
  private readonly averageLength: number
  private readonly average: Float64Array
  private averageIndex = 0
  private averageSum = 0

  /** Offsets of each header bit's center from the first, in samples. */
  private readonly headerOffsets: Int32Array
  /** Zero-mean header pattern, so the correlation ignores the carrier offset. */
  private readonly headerWeights: Float64Array
  private readonly headerNorm: number

  /** Matched filter output; buf[0] is sample number `start`. */
  private buf = new Float32Array(1 << 15)
  private start = 0
  private end = 0

  private searchAt = 0
  private candidate: { at: number; score: number } | null = null
  private reading: Reading | null = null

  constructor(sampleRate: number) {
    this.samplesPerSymbol = sampleRate / BAUD_RATE
    this.averageLength = Math.max(1, Math.round(this.samplesPerSymbol))
    this.average = new Float64Array(this.averageLength)
    this.headerOffsets = Int32Array.from({ length: HEADER_LENGTH }, (_, k) => Math.round(k * this.samplesPerSymbol))
    const bits = Array.from(HEADER_BITS, (b) => (b === '1' ? 1 : -1))
    const mean = bits.reduce((a, b) => a + b, 0) / bits.length
    this.headerWeights = Float64Array.from(bits, (b) => b - mean)
    this.headerNorm = Math.hypot(...this.headerWeights)
  }

  /** Whether a frame is being read right now (header found). */
  get inFrame() {
    return this.reading !== null
  }

  push(freq: Float32Array, n: number, onFrame: (frame: RawFrame) => void) {
    this.append(freq, n)
    while (true) {
      if (this.reading) {
        if (!this.read(onFrame)) break
      } else if (!this.search()) break
    }
    this.compact()
  }

  private append(freq: Float32Array, n: number) {
    if (this.end - this.start + n > this.buf.length) {
      const bigger = new Float32Array(Math.max(this.buf.length * 2, this.end - this.start + n))
      bigger.set(this.buf.subarray(0, this.end - this.start))
      this.buf = bigger
    }
    const { average, averageLength } = this
    let write = this.end - this.start
    for (let k = 0; k < n; k++) {
      this.averageSum += freq[k] - average[this.averageIndex]
      average[this.averageIndex] = freq[k]
      if (++this.averageIndex === averageLength) this.averageIndex = 0
      this.buf[write++] = this.averageSum / averageLength
    }
    this.end += n
  }

  /** Drops samples nothing will look at again. */
  private compact() {
    const keepFrom = Math.floor(
      this.reading ? this.reading.t - this.samplesPerSymbol : (this.candidate?.at ?? this.searchAt),
    ) - 2
    const drop = keepFrom - this.start
    if (drop <= 0 || drop < this.buf.length / 4) return
    this.buf.copyWithin(0, drop, this.end - this.start)
    this.start += drop
  }

  private at(t: number): number {
    const i = Math.floor(t)
    const frac = t - i
    const k = i - this.start
    return this.buf[k] + (this.buf[k + 1] - this.buf[k]) * frac
  }

  /** Normalized correlation with the header when its first bit is centered on sample `at`; the sign is the polarity. */
  private correlate(at: number): number {
    const base = at - this.start
    const { buf, headerOffsets, headerWeights } = this
    let dot = 0
    let sum = 0
    let sumSq = 0
    for (let k = 0; k < HEADER_LENGTH; k++) {
      const y = buf[base + headerOffsets[k]]
      dot += headerWeights[k] * y
      sum += y
      sumSq += y * y
    }
    const variance = sumSq - (sum * sum) / HEADER_LENGTH
    return variance > 0 ? dot / (this.headerNorm * Math.sqrt(variance)) : 0
  }

  /** Scans for the header; returns true once a frame starts. */
  private search(): boolean {
    const span = this.headerOffsets[HEADER_LENGTH - 1]
    // One extra sample so the peak can be refined against its right neighbour.
    while (this.searchAt + span + 2 < this.end) {
      const at = this.searchAt
      if (at - 1 >= this.start) {
        const score = Math.abs(this.correlate(at))
        if (score >= SYNC_THRESHOLD && (!this.candidate || score > this.candidate.score)) this.candidate = { at, score }
      }
      this.searchAt++
      // A symbol past the best score without beating it: that was the peak.
      if (this.candidate && at - this.candidate.at >= this.samplesPerSymbol) {
        this.startFrame(this.candidate.at)
        this.candidate = null
        return true
      }
    }
    return false
  }

  private startFrame(peak: number) {
    const sps = this.samplesPerSymbol
    const r0 = Math.abs(this.correlate(peak))
    const rl = Math.abs(this.correlate(peak - 1))
    const rr = Math.abs(this.correlate(peak + 1))
    const curvature = rl - 2 * r0 + rr
    const shift = curvature < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (rl - rr)) / curvature)) : 0
    const t0 = peak + shift

    // Least-squares fit of level = offset + swing·bit over the known header bits.
    let sy = 0
    let sb = 0
    let sbb = 0
    let sby = 0
    for (let k = 0; k < HEADER_LENGTH; k++) {
      const y = this.at(t0 + k * sps)
      const b = HEADER_BITS[k] === '1' ? 1 : -1
      sy += y
      sb += b
      sbb += b * b
      sby += b * y
    }
    const swing = (HEADER_LENGTH * sby - sb * sy) / (HEADER_LENGTH * sbb - sb * sb)
    const offset = (sy - swing * sb) / HEADER_LENGTH
    if (swing === 0 || !Number.isFinite(swing)) return

    const bytes = new Uint8Array(EXTENDED_LENGTH)
    bytes.set(HEADER_BYTES)
    const last = t0 + (HEADER_LENGTH - 1) * sps
    this.reading = {
      t: t0 + HEADER_LENGTH * sps,
      bytes,
      length: STANDARD_LENGTH,
      index: HEADER_BYTES.length,
      bitInByte: 0,
      acc: 0,
      offset,
      swing,
      prev: (this.at(last) - offset) / swing,
      score: r0,
    }
  }

  /** Reads bits while samples last; returns false when it needs more input. */
  private read(onFrame: (frame: RawFrame) => void): boolean {
    const r = this.reading!
    const sps = this.samplesPerSymbol
    while (r.t + 2 < this.end) {
      const y = this.at(r.t)
      // Normalized so the bit is the sign: the swing's sign carries the polarity.
      const v = (y - r.offset) / r.swing
      const bit = v > 0 ? 1 : 0

      // Gardner: the level halfway between two different bits should be zero; its
      // sign says whether we sample late or early.
      const mid = (this.at(r.t - sps / 2) - r.offset) / r.swing
      const error = (r.prev - v) * mid
      r.prev = v
      r.offset += OFFSET_GAIN * (y - r.offset - r.swing * (bit ? 1 : -1))

      r.acc |= bit << r.bitInByte
      if (++r.bitInByte === 8) {
        r.bytes[r.index] = r.acc ^ MASK[r.index % MASK.length]
        if (r.index === FRAME_TYPE_POS) r.length = frameLength(r.bytes[r.index])
        r.index++
        r.acc = 0
        r.bitInByte = 0
        if (r.index === r.length) {
          this.reading = null
          this.searchAt = Math.ceil(r.t)
          onFrame({ bytes: r.bytes, length: r.length, offset: r.offset, score: r.score })
          return true
        }
      }
      const correction = Math.max(-0.25, Math.min(0.25, (TIMING_GAIN * error) / 4))
      r.t += sps * (1 + correction)
    }
    return false
  }
}
