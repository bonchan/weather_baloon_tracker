/** Radio settings that get pushed to the dongle. */
export type SdrSettings = {
  /** Tuner center frequency, Hz. */
  centerFrequency: number
  /** IQ sample rate, samples per second. */
  sampleRate: number
  /** Tuner gain in dB, or null for the tuner's automatic gain control. */
  gain: number | null
  /** Crystal frequency correction, parts per million. */
  ppm: number
  /** 4.5 V on the antenna connector (RTL-SDR Blog V3/V4) to power an LNA. */
  biasTee: boolean
}

export type SdrDeviceInfo = {
  manufacturer: string
  product: string
  serial: string
  vendorId: number
  productId: number
  tuner: string
}

/** One USB bulk transfer worth of samples. */
export type IqBlock = {
  /** Interleaved unsigned 8-bit I/Q pairs, exactly as the dongle sends them. */
  data: ArrayBuffer
  centerFrequency: number
  sampleRate: number
  /** performance.now() when the transfer completed. */
  receivedAt: number
}
