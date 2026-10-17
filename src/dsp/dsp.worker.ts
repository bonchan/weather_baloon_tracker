import type { DspInMessage, SpectrumFrame } from './messages'
import { SpectrumAnalyzer, summarize } from './spectrum'

let analyzer = new SpectrumAnalyzer(4096)
let framesPerSecond = 25
let blocksProcessed = 0
/** Tuning of the samples being accumulated; a change discards the partial frame. */
let tuning: { centerFrequency: number; sampleRate: number } | null = null

self.onmessage = (event: MessageEvent<DspInMessage>) => {
  const msg = event.data
  switch (msg.type) {
    case 'configure':
      if (msg.fftSize !== analyzer.size) analyzer = new SpectrumAnalyzer(msg.fftSize)
      framesPerSecond = msg.framesPerSecond
      analyzer.reset()
      break

    case 'reset':
      analyzer.reset()
      blocksProcessed = 0
      tuning = null
      break

    case 'iq': {
      blocksProcessed++
      const { centerFrequency, sampleRate } = msg
      if (!tuning || tuning.centerFrequency !== centerFrequency || tuning.sampleRate !== sampleRate) {
        analyzer.reset()
        tuning = { centerFrequency, sampleRate }
      }
      const samplesPerFrame = Math.round(sampleRate / framesPerSecond)
      analyzer.push(new Uint8Array(msg.data), samplesPerFrame, (bins, clipFraction) => {
        const frame: SpectrumFrame = {
          type: 'spectrum',
          bins,
          centerFrequency,
          sampleRate,
          ...summarize(bins, centerFrequency, sampleRate),
          clipFraction,
          blocksProcessed,
        }
        self.postMessage(frame, { transfer: [bins.buffer] })
      })
      break
    }
  }
}
