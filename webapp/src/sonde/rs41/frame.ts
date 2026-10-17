import {
  BLOCK_ENCRYPTED,
  BLOCK_GPS_INFO,
  BLOCK_GPS_POS,
  BLOCK_POS_DATETIME,
  BLOCK_PTU,
  BLOCK_SGM_TU,
  BLOCK_STATUS,
  crc16,
  EXTENDED_LENGTH,
  FIRST_BLOCK_POS,
  FRAME_TYPE_POS,
  PARITY_POS,
} from './protocol'
import { RS_K, RS_N, RS_PARITY, rsDecode, rsEncode } from './reedSolomon'

const GPS_EPOCH_MS = Date.UTC(1980, 0, 6)
/** GPS time runs ahead of UTC by the leap seconds since 1980; 18 since 2017. */
const GPS_UTC_OFFSET_MS = 18_000

export type Ecef = {
  /** Position, m. */
  x: number
  y: number
  z: number
  /** Velocity, m/s. */
  vx: number
  vy: number
  vz: number
}

export type Rs41Data = {
  /** Bytes fixed by Reed-Solomon, or -1 when it could not repair the frame (block CRCs still decide). */
  corrected: number
  /** Blocks whose CRC failed. */
  badBlocks: number
  serial?: string
  frame?: number
  /** Battery voltage, V. */
  battery?: number
  /** GPS fix time, Unix ms (UTC). */
  time?: number
  ecef?: Ecef
  satellites?: number
  /** This frame's piece of the sonde's calibration (see ptu.ts). */
  calibration?: { index: number; data: Uint8Array }
  /**
   * Raw PTU counts, each with two references: air temperature, humidity, humidity
   * sensor temperature and, except from an RS41-SGM, pressure (zeros without a sensor).
   */
  ptu?: number[]
  /** Pressure sensor temperature, °C. */
  pressureTemp?: number
  /** RS41-SGM with encryption: no position to be had. */
  encrypted: boolean
}

/** Reads the two interleaved codewords out of a 518-byte frame buffer, or writes them back. */
function codewords(frame: Uint8Array, cw: [Uint8Array, Uint8Array], write: boolean) {
  for (let c = 0; c < 2; c++) {
    for (let i = 0; i < RS_PARITY; i++) {
      const pos = PARITY_POS + c * RS_PARITY + i
      if (write) frame[pos] = cw[c][i]
      else cw[c][i] = frame[pos]
    }
    for (let i = 0; i < RS_K; i++) {
      const pos = FRAME_TYPE_POS + 2 * i + c
      if (write) frame[pos] = cw[c][RS_PARITY + i]
      else cw[c][RS_PARITY + i] = frame[pos]
    }
  }
}

/** Fills in the Reed-Solomon parity of a frame whose payload is complete (used to build test frames). */
export function addParity(frame: Uint8Array, length: number) {
  const full = new Uint8Array(EXTENDED_LENGTH)
  full.set(frame.subarray(0, length))
  const cw: [Uint8Array, Uint8Array] = [new Uint8Array(RS_N), new Uint8Array(RS_N)]
  codewords(full, cw, false)
  rsEncode(cw[0])
  rsEncode(cw[1])
  codewords(full, cw, true)
  frame.set(full.subarray(0, length))
}

/**
 * Error-corrects a frame in place. `frame` must be 518 bytes; past `length`
 * it is treated as the zero padding a standard frame is coded with.
 */
export function correctFrame(frame: Uint8Array, length: number): number {
  frame.fill(0, length)
  const cw: [Uint8Array, Uint8Array] = [new Uint8Array(RS_N), new Uint8Array(RS_N)]
  codewords(frame, cw, false)
  const fixed = [rsDecode(cw[0]), rsDecode(cw[1])]
  if (fixed[0] < 0 || fixed[1] < 0) return -1
  // A "repair" inside the known zero padding means the decoder was fooled by too many errors.
  for (let pos = length; pos < EXTENDED_LENGTH; pos++) {
    const c = (pos - FRAME_TYPE_POS) & 1
    if (cw[c][RS_PARITY + ((pos - FRAME_TYPE_POS) >> 1)] !== 0) return -1
  }
  codewords(frame, cw, true)
  return fixed[0] + fixed[1]
}

const i32 = (b: Uint8Array, p: number) => (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24))
const u32 = (b: Uint8Array, p: number) => i32(b, p) >>> 0
const u16 = (b: Uint8Array, p: number) => b[p] | (b[p + 1] << 8)
const u24 = (b: Uint8Array, p: number) => b[p] | (b[p + 1] << 8) | (b[p + 2] << 16)
const i16 = (b: Uint8Array, p: number) => (u16(b, p) << 16) >> 16

function readEcef(b: Uint8Array, p: number): Ecef {
  return {
    x: i32(b, p) / 100,
    y: i32(b, p + 4) / 100,
    z: i32(b, p + 8) / 100,
    vx: i16(b, p + 12) / 100,
    vy: i16(b, p + 14) / 100,
    vz: i16(b, p + 16) / 100,
  }
}

/** Error-corrects (in place) and parses a descrambled frame. */
export function decodeFrame(frame: Uint8Array, length: number): Rs41Data {
  const data: Rs41Data = { corrected: correctFrame(frame, length), badBlocks: 0, encrypted: false }

  let pos = FIRST_BLOCK_POS
  while (pos + 4 <= length) {
    const id = frame[pos]
    const len = frame[pos + 1]
    const start = pos + 2
    const end = start + len
    if (end + 2 > length) break
    pos = end + 2
    if (crc16(frame, start, end) !== u16(frame, end)) {
      data.badBlocks++
      continue
    }
    switch (id) {
      case BLOCK_STATUS:
        if (len < 11) break
        data.frame = u16(frame, start)
        data.serial = String.fromCharCode(...frame.subarray(start + 2, start + 10)).replace(/[^\x20-\x7e]/g, '?')
        data.battery = frame[start + 10] / 10
        if (len >= 0x28) data.calibration = { index: frame[start + 0x17], data: frame.slice(start + 0x18, start + 0x28) }
        break
      case BLOCK_PTU:
      case BLOCK_SGM_TU:
        if (len < 27) break
        // The SGM's short block stops after nine counts.
        data.ptu = Array.from({ length: len >= 36 ? 12 : 9 }, (_, i) => u24(frame, start + 3 * i))
        if (len >= 40) data.pressureTemp = i16(frame, start + 38) / 100
        break
      case BLOCK_GPS_INFO:
        if (len < 6) break
        data.time = GPS_EPOCH_MS + u16(frame, start) * 604_800_000 + u32(frame, start + 2) - GPS_UTC_OFFSET_MS
        break
      case BLOCK_GPS_POS:
        if (len < 19) break
        data.ecef = readEcef(frame, start)
        data.satellites = frame[start + 18]
        break
      case BLOCK_POS_DATETIME: {
        // Layout from rs1729's get_posdatetime(); the time here is already UTC.
        if (len < 26) break
        data.ecef = readEcef(frame, start)
        const hundredths = frame[start + 25] < 100 ? frame[start + 25] : 0
        data.time =
          Date.UTC(u16(frame, start + 18), frame[start + 20] - 1, frame[start + 21], frame[start + 22], frame[start + 23], frame[start + 24]) +
          hundredths * 10
        break
      }
      case BLOCK_ENCRYPTED:
        data.encrypted = true
        break
    }
  }
  return data
}
