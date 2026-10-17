import type { DecoderStatus } from '../../dsp/messages'
import { Channelizer, FmDiscriminator } from '../../dsp/channelizer'
import { ecefToEnu, ecefToGeodetic } from '../../geo'
import type { SondeFix } from '../store'
import { Rs41Demodulator, type RawFrame } from './demod'
import { decodeFrame, type Rs41Data } from './frame'
import { readPtu, Rs41Calibration } from './ptu'

/** The channel needs this much room inside the tuner's band. */
const EDGE_MARGIN = 15_000
/** How far the AFC may move the channel away from the marker, Hz. */
const MAX_AFC = 12_000
/** A good frame within this many seconds counts as locked; a header as in sync. */
const LOCK_HOLD = 3

/** Turns a GPS block into a map fix, or null when the sonde has no usable position. */
export function toFix(data: Rs41Data, receivedAt: number, calibration?: Rs41Calibration): SondeFix | null {
  const { ecef, serial, frame } = data
  if (!ecef || serial === undefined || frame === undefined) return null
  if (ecef.x === 0 && ecef.y === 0 && ecef.z === 0) return null
  const { lat, lon, alt } = ecefToGeodetic(ecef.x, ecef.y, ecef.z)
  if (!(alt > -1000 && alt < 80_000)) return null
  const v = ecefToEnu(lat, lon, ecef.vx, ecef.vy, ecef.vz)
  const ptu = calibration && data.ptu ? readPtu(calibration, data.ptu, alt, data.pressureTemp) : {}
  return {
    serial,
    frame,
    time: data.time ?? receivedAt,
    lat,
    lon,
    alt,
    climb: v.up,
    speed: Math.hypot(v.east, v.north),
    heading: ((Math.atan2(v.east, v.north) * 180) / Math.PI + 360) % 360,
    ...ptu,
    receivedAt,
  }
}

/**
 * Wideband u8 IQ in, RS41 fixes out: channelizer at the marker, FM discriminator,
 * GFSK demodulator, error correction and parsing. Pure computation, so it runs the
 * same in the DSP worker and in tests.
 */
export class Rs41Receiver {
  private readonly onFix: (fix: SondeFix) => void
  private frequency: number | null = null
  private outOfBand = false
  private tuning = { centerFrequency: 0, sampleRate: 0 }
  private channelizer: Channelizer | null = null
  private discriminator: FmDiscriminator | null = null
  private demod: Rs41Demodulator | null = null
  private freq = new Float32Array(0)
  /** Correction from the marker to where the sonde actually is, Hz. */
  private afc = 0
  /** Seconds of signal processed: the decoder's clock. */
  private clock = 0
  private lastSync = -Infinity
  private lastGood = -Infinity
  private stats = { goodFrames: 0, badFrames: 0, serial: null as string | null, frame: null as number | null, gpsFix: false }
  /** Per serial, and kept across resets: collecting one takes 51 frames. */
  private calibrations = new Map<string, Rs41Calibration>()

  constructor(onFix: (fix: SondeFix) => void) {
    this.onFix = onFix
  }

  /** Where to listen (absolute Hz), or null to stop. A new frequency starts the counts over. */
  setFrequency(frequency: number | null) {
    if (frequency === this.frequency) return
    this.frequency = frequency
    this.reset()
  }

  reset() {
    this.channelizer = null
    this.afc = 0
    this.lastSync = this.lastGood = -Infinity
    this.stats = { goodFrames: 0, badFrames: 0, serial: null, frame: null, gpsFix: false }
  }

  process(iq: Uint8Array, centerFrequency: number, sampleRate: number) {
    if (this.frequency === null) return
    const offset = this.frequency - centerFrequency
    this.outOfBand = Math.abs(offset) > sampleRate / 2 - EDGE_MARGIN
    if (this.outOfBand) {
      this.channelizer = null
      return
    }
    if (!this.channelizer || this.tuning.centerFrequency !== centerFrequency || this.tuning.sampleRate !== sampleRate) {
      this.tuning = { centerFrequency, sampleRate }
      this.afc = 0
      this.channelizer = new Channelizer(sampleRate, offset)
      this.discriminator = new FmDiscriminator(this.channelizer.outputRate)
      this.demod = new Rs41Demodulator(this.channelizer.outputRate)
    }
    const { re, im, length } = this.channelizer.process(iq)
    if (this.freq.length < length) this.freq = new Float32Array(length * 2)
    this.discriminator!.process(re, im, length, this.freq)
    this.demod!.push(this.freq, length, this.handleFrame)
    this.clock += length / this.channelizer.outputRate
  }

  status(): DecoderStatus {
    const state =
      this.frequency === null
        ? 'no-marker'
        : this.outOfBand
          ? 'out-of-band'
          : this.clock - this.lastGood < LOCK_HOLD
            ? 'locked'
            : this.clock - this.lastSync < LOCK_HOLD || this.demod?.inFrame
              ? 'sync'
              : 'searching'
    const calibration = this.stats.serial === null ? null : (this.calibrations.get(this.stats.serial)?.count ?? 0)
    return { state, ...this.stats, offset: this.stats.goodFrames ? this.afc : null, calibration }
  }

  private handleFrame = (raw: RawFrame) => {
    this.lastSync = this.clock
    const data = decodeFrame(raw.bytes, raw.length)
    if (data.serial === undefined || data.frame === undefined) {
      this.stats.badFrames++
      return
    }
    this.lastGood = this.clock
    // AFC: recenter the channel on the sonde, between frames where the jump does no harm.
    this.afc = Math.max(-MAX_AFC, Math.min(MAX_AFC, this.afc + raw.offset))
    this.channelizer?.setOffset(this.frequency! - this.tuning.centerFrequency + this.afc)

    let calibration = this.calibrations.get(data.serial)
    if (!calibration) this.calibrations.set(data.serial, (calibration = new Rs41Calibration()))
    if (data.calibration) calibration.add(data.calibration.index, data.calibration.data)

    const fix = toFix(data, Date.now(), calibration)
    this.stats = {
      goodFrames: this.stats.goodFrames + 1,
      badFrames: this.stats.badFrames,
      serial: data.serial,
      frame: data.frame,
      gpsFix: fix !== null,
    }
    if (fix) this.onFix(fix)
  }
}
