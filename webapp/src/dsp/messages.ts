import type { SondeFix } from '../sonde/store'

/** Main thread → DSP worker. */
export type DspInMessage =
  | { type: 'configure'; fftSize: number; framesPerSecond: number }
  /** Where the sonde decoder listens (the marker), absolute Hz. The tuning comes with each IQ block. */
  | { type: 'decoder'; frequency: number | null }
  | { type: 'reset' }
  | { type: 'iq'; data: ArrayBuffer; centerFrequency: number; sampleRate: number }

/** An averaged power spectrum, emitted framesPerSecond times a second. */
export type SpectrumFrame = {
  type: 'spectrum'
  /** Power per bin in dBFS, lowest frequency first. */
  bins: Float32Array
  centerFrequency: number
  sampleRate: number
  /** Median bin level, a decent estimate of the noise floor. */
  noiseFloorDb: number
  peakDb: number
  /** Absolute frequency of the strongest bin (ignoring the DC spike), Hz. */
  peakFrequency: number
  /** Share of 8-bit samples sitting on the ADC rails (0 or 255) during this frame. */
  clipFraction: number
  /** IQ blocks consumed since the last reset, for backlog tracking. */
  blocksProcessed: number
}

export type DecoderState = 'no-marker' | 'out-of-band' | 'searching' | 'sync' | 'locked'

export type DecoderStatus = {
  /** sync: headers heard but frames fail; locked: good frames coming in. */
  state: DecoderState
  goodFrames: number
  badFrames: number
  /** From the last good frame. */
  serial: string | null
  frame: number | null
  /** Whether the last good frame had a GPS position. */
  gpsFix: boolean
  /** Where the sonde is relative to the marker, Hz, once a frame decoded. */
  offset: number | null
  /** Calibration subframes collected for this sonde, out of 51; temperature, humidity and pressure need them. */
  calibration: number | null
}

/** DSP worker → main thread. */
export type DspOutMessage =
  | SpectrumFrame
  | { type: 'sonde-fix'; fix: SondeFix }
  | { type: 'decoder'; status: DecoderStatus }
