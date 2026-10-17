import { describe, expect, it } from 'vitest'
import { FFT } from './fft'
import { SpectrumAnalyzer, summarize } from './spectrum'

const SAMPLE_RATE = 2_400_000
const CENTER = 403_000_000
const FFT_SIZE = 4096
const BIN_WIDTH = SAMPLE_RATE / FFT_SIZE

/** u8 IQ the way the dongle sends it: a complex tone around 127.5, clamped to the ADC rails. */
function toneIq(samples: number, offsetHz: number, amplitude: number): Uint8Array {
  const out = new Uint8Array(samples * 2)
  const clamp = (v: number) => Math.min(255, Math.max(0, Math.round(v)))
  for (let n = 0; n < samples; n++) {
    const phase = (2 * Math.PI * offsetHz * n) / SAMPLE_RATE
    out[2 * n] = clamp(127.5 + 128 * amplitude * Math.cos(phase))
    out[2 * n + 1] = clamp(127.5 + 128 * amplitude * Math.sin(phase))
  }
  return out
}

function analyze(iq: Uint8Array) {
  const analyzer = new SpectrumAnalyzer(FFT_SIZE)
  const frames: { bins: Float32Array; clip: number }[] = []
  analyzer.push(iq, iq.length / 2, (bins, clip) => frames.push({ bins, clip }))
  return frames
}

describe('FFT', () => {
  it('puts a pure complex tone into a single bin', () => {
    const n = 64
    const re = new Float64Array(n)
    const im = new Float64Array(n)
    for (let i = 0; i < n; i++) {
      re[i] = Math.cos((2 * Math.PI * 5 * i) / n)
      im[i] = Math.sin((2 * Math.PI * 5 * i) / n)
    }
    new FFT(n).transform(re, im)
    expect(re[5]).toBeCloseTo(n, 6)
    for (let k = 0; k < n; k++) if (k !== 5) expect(Math.hypot(re[k], im[k])).toBeLessThan(1e-9)
  })

  it('rejects sizes that are not powers of two', () => {
    expect(() => new FFT(100)).toThrow()
  })
})

describe('SpectrumAnalyzer', () => {
  it('finds a tone above center at the right frequency and level', () => {
    const frames = analyze(toneIq(96_000, 250_000, 0.5))
    expect(frames).toHaveLength(1)
    const s = summarize(frames[0].bins, CENTER, SAMPLE_RATE)
    expect(Math.abs(s.peakFrequency - (CENTER + 250_000))).toBeLessThanOrEqual(BIN_WIDTH)
    // Amplitude 0.5 is -6 dBFS, minus a little window scalloping.
    expect(s.peakDb).toBeGreaterThan(-8)
    expect(s.peakDb).toBeLessThan(-5)
    expect(s.noiseFloorDb).toBeLessThan(s.peakDb - 40)
    expect(frames[0].clip).toBe(0)
  })

  it('puts negative offsets below center (I/Q not swapped)', () => {
    const frames = analyze(toneIq(96_000, -400_000, 0.3))
    const s = summarize(frames[0].bins, CENTER, SAMPLE_RATE)
    expect(Math.abs(s.peakFrequency - (CENTER - 400_000))).toBeLessThanOrEqual(BIN_WIDTH)
  })

  it('reports samples stuck on the ADC rails', () => {
    const frames = analyze(toneIq(48_000, 100_000, 1.5))
    expect(frames[0].clip).toBeGreaterThan(0.1)
  })

  it('emits one frame per frame period across block boundaries', () => {
    const analyzer = new SpectrumAnalyzer(FFT_SIZE)
    let frames = 0
    const block = toneIq(24_000, 50_000, 0.2)
    for (let i = 0; i < 4; i++) analyzer.push(block, 48_000, () => frames++)
    expect(frames).toBe(2)
  })
})
