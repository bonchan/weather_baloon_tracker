/** Main thread → DSP worker. */
export type DspInMessage =
  | { type: 'configure'; fftSize: number; framesPerSecond: number }
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

/** DSP worker → main thread. */
export type DspOutMessage = SpectrumFrame
