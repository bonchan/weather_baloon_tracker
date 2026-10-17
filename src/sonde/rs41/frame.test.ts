import { describe, expect, it } from 'vitest'
import { correctFrame, decodeFrame } from './frame'
import { crc16, EXTENDED_LENGTH, frameLength, HEADER_BITS, HEADER_BYTES, MASK, STANDARD_LENGTH } from './protocol'
import { RS_N, RS_PARITY, rsDecode, rsEncode } from './reedSolomon'

/**
 * A real, descrambled RS41-SGM frame (serial N5140102) from the example data in
 * bazjo/RS41_Decoding (RS41-SGM_N5140102_Zilog.txt). Its parity and CRCs were made
 * by the sonde, so they check our Reed-Solomon and CRC conventions against reality.
 */
const REAL_FRAME = [
  '8635f44093df1a6095b96c8eeb82a326430005451e1aac83871d4fd272cfdd8b8ee89fab6635f629715aaa156f92fd197a3b64ac2e8780330f7928d7184e3531',
  '34303130321a00000100031300002d00073232ffff63ed60020700f6f6c4011a640000097e80a7366593b77345b69166bccb3b86dce8ece8bbc0c04d8e1e85b7',
  '999fd5b0fca0daf53f375ff39f8722a5a8f8eb4464931055fa19fa53a330c344ef5a96a667b4c810fc08a635afa13a20f5647387f169d764dbd87a98cea0a669',
  '4fe1dd95998344252cee9bc676ae096c4377a944434b2b2f9ac3952e75b21556640190598a914aa9c5fbfbc26dc296d04ac74525a3766356f42b5f0f0b0db825',
  '1021e4a9cd99b291f4c63f5a78c0b0cd762c0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000789a',
].join('')

function realFrame(): Uint8Array {
  const frame = new Uint8Array(EXTENDED_LENGTH)
  for (let i = 0; i < REAL_FRAME.length / 2; i++) frame[i] = parseInt(REAL_FRAME.slice(2 * i, 2 * i + 2), 16)
  return frame
}

/** Deterministic PRNG so failures reproduce. */
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe('RS41 protocol constants', () => {
  it('header bits descramble to the header bytes', () => {
    for (let byte = 0; byte < 8; byte++) {
      let v = 0
      for (let bit = 0; bit < 8; bit++) v |= Number(HEADER_BITS[byte * 8 + bit]) << bit
      expect(v ^ MASK[byte]).toBe(HEADER_BYTES[byte])
    }
  })

  it('CRC matches the empty block rs1729 hardcodes (17 zeros → EC C7)', () => {
    expect(crc16(new Uint8Array(17), 0, 17)).toBe(0xc7ec)
  })

  it('reads the frame type with bit errors', () => {
    expect(frameLength(0x0f)).toBe(STANDARD_LENGTH)
    expect(frameLength(0xf0)).toBe(EXTENDED_LENGTH)
    expect(frameLength(0x0b)).toBe(STANDARD_LENGTH)
    expect(frameLength(0xd0)).toBe(EXTENDED_LENGTH)
  })
})

describe('Reed-Solomon RS(255,231)', () => {
  it('corrects up to 12 byte errors', () => {
    const random = rng(1)
    for (let trial = 0; trial < 20; trial++) {
      const cw = new Uint8Array(RS_N)
      for (let i = RS_PARITY; i < RS_N; i++) cw[i] = Math.floor(random() * 256)
      rsEncode(cw)
      const original = cw.slice()
      const errors = 1 + (trial % 12)
      const positions = new Set<number>()
      while (positions.size < errors) positions.add(Math.floor(random() * RS_N))
      for (const p of positions) cw[p] ^= 1 + Math.floor(random() * 255)
      expect(rsDecode(cw)).toBe(errors)
      expect(cw).toEqual(original)
    }
  })

  it('leaves a clean codeword alone', () => {
    const cw = new Uint8Array(RS_N)
    cw[100] = 42
    rsEncode(cw)
    const original = cw.slice()
    expect(rsDecode(cw)).toBe(0)
    expect(cw).toEqual(original)
  })
})

describe('RS41 frame', () => {
  it('accepts the parity of a real frame', () => {
    expect(correctFrame(realFrame(), STANDARD_LENGTH)).toBe(0)
  })

  it('parses a real frame', () => {
    const data = decodeFrame(realFrame(), STANDARD_LENGTH)
    expect(data.serial).toBe('N5140102')
    expect(data.frame).toBe(0x18d7)
    expect(data.encrypted).toBe(true)
    expect(data.badBlocks).toBe(0)
    expect(data.ecef).toBeUndefined()
  })

  it('repairs a damaged real frame', () => {
    const frame = realFrame()
    // 11 bad bytes per codeword: parity bytes 8-31 and even payload bytes are the first, 32-55 and odd ones the second.
    const damaged = [8, 12, 16, 20, 24, 33, 37, 41, 45, 49]
    for (let k = 0; k < 6; k++) damaged.push(58 + 40 * k, 79 + 40 * k)
    for (const p of damaged) frame[p] ^= 0x5a
    const data = decodeFrame(frame, STANDARD_LENGTH)
    expect(data.corrected).toBe(22)
    expect(data.serial).toBe('N5140102')
    expect(frame.subarray(0, STANDARD_LENGTH)).toEqual(realFrame().subarray(0, STANDARD_LENGTH))
  })
})
