// Builds and radio-modulates RS41 frames from scratch, so tests can run the whole
// receive chain without a sonde. Not used by the app itself.
import { geodeticToEcef } from '../../geo'
import { addParity } from './frame'
import {
  BAUD_RATE,
  BLOCK_EMPTY,
  BLOCK_GPS_INFO,
  BLOCK_GPS_POS,
  BLOCK_GPS_RAW,
  BLOCK_PTU,
  BLOCK_STATUS,
  crc16,
  FIRST_BLOCK_POS,
  FRAME_TYPE_POS,
  HEADER_BYTES,
  MASK,
  STANDARD_LENGTH,
} from './protocol'

export type SyntheticFix = {
  serial: string
  frame: number
  lat: number
  lon: number
  alt: number
  /** ECEF velocity, m/s. */
  velocity: [number, number, number]
  gpsWeek: number
  /** GPS time of week, ms. */
  tow: number
}

/** A standard 320-byte frame (descrambled) with the usual block layout, valid CRCs and parity. */
export function buildFrame(fix: SyntheticFix): Uint8Array {
  const frame = new Uint8Array(STANDARD_LENGTH)
  frame.set(HEADER_BYTES)
  frame[FRAME_TYPE_POS] = 0x0f
  const view = new DataView(frame.buffer)
  let pos = FIRST_BLOCK_POS
  const block = (id: number, len: number, fill: (data: number) => void) => {
    frame[pos] = id
    frame[pos + 1] = len
    fill(pos + 2)
    view.setUint16(pos + 2 + len, crc16(frame, pos + 2, pos + 2 + len), true)
    pos += len + 4
  }
  block(BLOCK_STATUS, 0x28, (d) => {
    view.setUint16(d, fix.frame, true)
    for (let i = 0; i < 8; i++) frame[d + 2 + i] = fix.serial.charCodeAt(i)
    frame[d + 10] = 29
  })
  block(BLOCK_PTU, 0x2a, () => {})
  block(BLOCK_GPS_INFO, 0x1e, (d) => {
    view.setUint16(d, fix.gpsWeek, true)
    view.setUint32(d + 2, fix.tow, true)
  })
  block(BLOCK_GPS_RAW, 0x59, () => {})
  block(BLOCK_GPS_POS, 0x15, (d) => {
    const { x, y, z } = geodeticToEcef(fix.lat, fix.lon, fix.alt)
    view.setInt32(d, Math.round(x * 100), true)
    view.setInt32(d + 4, Math.round(y * 100), true)
    view.setInt32(d + 8, Math.round(z * 100), true)
    for (let i = 0; i < 3; i++) view.setInt16(d + 12 + 2 * i, Math.round(fix.velocity[i] * 100), true)
    frame[d + 18] = 9
  })
  block(BLOCK_EMPTY, 0x11, () => {})
  addParity(frame, STANDARD_LENGTH)
  return frame
}

/** Bits as transmitted: 320-bit 0101… preamble, then the scrambled frame, each byte LSB first. */
export function frameBits(frame: Uint8Array): Uint8Array {
  const bits = new Uint8Array(320 + frame.length * 8)
  for (let i = 0; i < 320; i++) bits[i] = i & 1
  for (let i = 0; i < frame.length; i++) {
    const byte = frame[i] ^ MASK[i % MASK.length]
    for (let b = 0; b < 8; b++) bits[320 + i * 8 + b] = (byte >> b) & 1
  }
  return bits
}

export type Burst = { bits: Uint8Array; gap: number }

export type ModulationOptions = {
  sampleRate: number
  /** Carrier relative to the tuner center, Hz. */
  offset: number
  /** Peak deviation, Hz; negative flips the polarity like an inverted spectrum. */
  deviation?: number
  amplitude?: number
  /** Gaussian noise per I/Q component, in full-scale units. */
  noise?: number
  /** Symbol clock error, ppm. */
  clockPpm?: number
  /** Extra unmodulated carrier: offset Hz and amplitude. */
  interferer?: { offset: number; amplitude: number }
  seed?: number
}

/** Deterministic PRNG so failures reproduce. */
export function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** GFSK (BT 0.5) bursts, each followed by `gap` seconds of silence, as the dongle's u8 IQ. */
export function modulate(bursts: Burst[], o: ModulationOptions): Uint8Array {
  const { sampleRate, offset } = o
  const deviation = o.deviation ?? 2400
  const amplitude = o.amplitude ?? 0.25
  const noise = o.noise ?? 0
  const baud = BAUD_RATE * (1 + (o.clockPpm ?? 0) * 1e-6)
  const random = mulberry32(o.seed ?? 1)

  // Rectangular symbol through a Gaussian filter, tabulated at 1/64 symbol over ±2 symbols.
  const RES = 64
  const sigma = Math.sqrt(Math.log(2)) / (2 * Math.PI * 0.5)
  const pulse = new Float64Array(4 * RES + 1)
  for (let i = 0; i < pulse.length; i++) {
    const t = i / RES - 2
    let acc = 0
    for (let j = 0; j < RES; j++) {
      const u = t - (j + 0.5) / RES + 0.5
      acc += Math.exp(-(u * u) / (2 * sigma * sigma))
    }
    pulse[i] = acc / (RES * sigma * Math.sqrt(2 * Math.PI))
  }

  const lengths = bursts.map((b) => Math.ceil(((b.bits.length + 2) / baud + b.gap) * sampleRate))
  const out = new Uint8Array(2 * lengths.reduce((a, b) => a + b, 0))
  let n = 0
  let phase = 0
  let interfererPhase = 0
  let spare: number | null = null
  const gauss = () => {
    if (spare !== null) {
      const s = spare
      spare = null
      return s
    }
    const r = Math.sqrt(-2 * Math.log(1 - random()))
    const a = 2 * Math.PI * random()
    spare = r * Math.sin(a)
    return r * Math.cos(a)
  }
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(127.5 + 127.5 * v)))

  bursts.forEach((burst, index) => {
    const { bits } = burst
    const onAir = (bits.length + 2) / baud
    for (let s = 0; s < lengths[index]; s++, n++) {
      const time = s / sampleRate
      let i = 0
      let q = 0
      if (time < onAir) {
        // Symbol time, starting one symbol early so the first pulse rises cleanly.
        const st = time * baud - 1
        const k0 = Math.floor(st)
        let level = 0
        for (let k = k0 - 2; k <= k0 + 2; k++) {
          const x = Math.round((st - k + 2) * RES)
          if (x < 0 || x >= pulse.length) continue
          const bit = k >= 0 && k < bits.length ? bits[k] * 2 - 1 : k < 0 ? -1 : 1
          level += bit * pulse[x]
        }
        phase += (2 * Math.PI * (offset + deviation * level)) / sampleRate
        i = amplitude * Math.cos(phase)
        q = amplitude * Math.sin(phase)
      }
      if (o.interferer) {
        interfererPhase += (2 * Math.PI * o.interferer.offset) / sampleRate
        i += o.interferer.amplitude * Math.cos(interfererPhase)
        q += o.interferer.amplitude * Math.sin(interfererPhase)
      }
      out[2 * n] = clamp(i + noise * gauss())
      out[2 * n + 1] = clamp(q + noise * gauss())
    }
    phase %= 2 * Math.PI
    interfererPhase %= 2 * Math.PI
  })
  return out
}
