import { describe, expect, it } from 'vitest'
import { ecefToEnu } from '../../geo'
import type { SondeFix } from '../store'
import { Rs41Receiver } from './receiver'
import { buildFrame, frameBits, modulate, type Burst, type ModulationOptions, type SyntheticFix } from './synthetic'
import { K1930308_CALIBRATION } from './testdata'

const CENTER = 403_000_000
const MARKER = CENTER + 250_000

/** Three frames of a sonde climbing west of Neuquén. */
const FIXES: SyntheticFix[] = [0, 1, 2].map((i) => ({
  serial: 'U2345678',
  frame: 4200 + i,
  lat: -38.95 + i * 0.0001,
  lon: -68.2 + i * 0.0002,
  alt: 12_345.67 + i * 5.2,
  // Mostly up plus some wind; the test only checks the derived numbers loosely.
  velocity: [3.1, -4.2, -2.5],
  gpsWeek: 2389,
  tow: 302_400_000 + i * 1000,
}))

function receive(iq: Uint8Array, sampleRate: number) {
  const fixes: SondeFix[] = []
  const receiver = new Rs41Receiver((fix) => fixes.push(fix))
  receiver.setFrequency(MARKER)
  // Feed it the way the dongle does: ~20 blocks per second.
  const block = 2 * 512 * Math.ceil(sampleRate / 20 / 512)
  for (let p = 0; p < iq.length; p += block) receiver.process(iq.subarray(p, p + block), CENTER, sampleRate)
  return { fixes, status: receiver.status() }
}

function bursts(damage?: (frame: Uint8Array, index: number) => void): Burst[] {
  return FIXES.map((fix, index) => {
    const frame = buildFrame(fix)
    damage?.(frame, index)
    return { bits: frameBits(frame), gap: 0.35 }
  })
}

function expectDecoded(fixes: SondeFix[]) {
  expect(fixes.map((f) => f.frame)).toEqual(FIXES.map((f) => f.frame))
  fixes.forEach((fix, i) => {
    const want = FIXES[i]
    expect(fix.serial).toBe('U2345678')
    expect(fix.lat).toBeCloseTo(want.lat, 6)
    expect(fix.lon).toBeCloseTo(want.lon, 6)
    expect(fix.alt).toBeCloseTo(want.alt, 1)
    const v = ecefToEnu(want.lat, want.lon, ...want.velocity)
    expect(fix.climb).toBeCloseTo(v.up, 1)
    expect(fix.speed).toBeCloseTo(Math.hypot(v.east, v.north), 1)
    expect(fix.heading).toBeCloseTo(((Math.atan2(v.east, v.north) * 180) / Math.PI + 360) % 360, 0)
    // GPS week 2389 + 302400 s is Wednesday 2025-10-22 12:00:00 GPS, 18 leap seconds ahead of UTC.
    expect(fix.time).toBe(Date.UTC(2025, 9, 22, 11, 59, 42 + i))
  })
}

describe('RS41 receiver', () => {
  it('decodes GFSK at 2.4 MS/s off the marker, with noise and a strong neighbour', () => {
    const options: ModulationOptions = {
      sampleRate: 2_400_000,
      offset: MARKER - CENTER + 3_000,
      noise: 0.12,
      interferer: { offset: 150_000, amplitude: 0.4 },
    }
    const { fixes, status } = receive(modulate(bursts(), options), options.sampleRate)
    expectDecoded(fixes)
    expect(status.state).toBe('locked')
    expect(status.goodFrames).toBe(3)
    expect(status.badFrames).toBe(0)
    expect(status.serial).toBe('U2345678')
    expect(status.offset).toBeGreaterThan(2_500)
    expect(status.offset).toBeLessThan(3_500)
  })

  it('handles 2.048 MS/s, inverted polarity, clock error and repairs bit errors', () => {
    const options: ModulationOptions = {
      sampleRate: 2_048_000,
      offset: MARKER - CENTER - 4_000,
      deviation: -2400,
      clockPpm: 60,
      noise: 0.08,
      seed: 5,
    }
    // Corrupt 8 bytes of the second frame on the air; Reed-Solomon has to put them back.
    const damaged = bursts((frame, index) => {
      if (index === 1) for (let k = 0; k < 8; k++) frame[70 + 23 * k] ^= 0xff
    })
    const { fixes, status } = receive(modulate(damaged, options), options.sampleRate)
    expectDecoded(fixes)
    expect(status.badFrames).toBe(0)
  })

  it('adds temperature once the frames have brought its calibration', () => {
    // Subframes 3-6 hold what air temperature needs. Counts from K1930308 #5056, where rs41mod first shows -43.2 °C.
    const counts = [139699, 130602, 190186, 529214, 466359, 533221, 134218, 130602, 190187]
    const frames: SyntheticFix[] = [3, 4, 5, 6].map((index, i) => ({
      ...FIXES[0],
      frame: 4200 + i,
      calibration: { index, data: Uint8Array.from(K1930308_CALIBRATION[index].match(/../g)!, (h) => parseInt(h, 16)) },
      ptu: counts,
    }))
    const options: ModulationOptions = { sampleRate: 2_048_000, offset: MARKER - CENTER, noise: 0.05 }
    const iq = modulate(frames.map((fix) => ({ bits: frameBits(buildFrame(fix)), gap: 0.35 })), options)
    const { fixes, status } = receive(iq, options.sampleRate)
    expect(fixes.map((f) => f.temperature !== undefined)).toEqual([false, false, false, true])
    expect(fixes[3].temperature).toBeCloseTo(-43.205, 2)
    expect(fixes.every((f) => f.humidity === undefined)).toBe(true)
    expect(status.calibration).toBe(4)
  })
})
