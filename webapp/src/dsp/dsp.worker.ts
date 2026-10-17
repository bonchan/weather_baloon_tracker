import { Rs41Receiver } from '../sonde/rs41/receiver'
import type { DspInMessage, DspOutMessage, SpectrumFrame } from './messages'
import { SpectrumAnalyzer, summarize } from './spectrum'

let analyzer = new SpectrumAnalyzer(4096)
let framesPerSecond = 25
let blocksProcessed = 0
/** Tuning of the samples being accumulated; a change discards the partial frame. */
let tuning: { centerFrequency: number; sampleRate: number } | null = null

const post = (message: DspOutMessage, transfer: Transferable[] = []) => self.postMessage(message, { transfer })

const receiver = new Rs41Receiver((fix) => post({ type: 'sonde-fix', fix }))
/** The status changes about once per frame, so sending it whenever it differs is cheap. */
let lastStatus = ''

function postStatus() {
  const status = receiver.status()
  const key = JSON.stringify(status)
  if (key === lastStatus) return
  lastStatus = key
  post({ type: 'decoder', status })
}

self.onmessage = (event: MessageEvent<DspInMessage>) => {
  const msg = event.data
  switch (msg.type) {
    case 'configure':
      if (msg.fftSize !== analyzer.size) analyzer = new SpectrumAnalyzer(msg.fftSize)
      framesPerSecond = msg.framesPerSecond
      analyzer.reset()
      break

    case 'decoder':
      receiver.setFrequency(msg.frequency)
      postStatus()
      break

    case 'reset':
      analyzer.reset()
      receiver.reset()
      blocksProcessed = 0
      tuning = null
      // A new stream starts with no decoder status on the main thread; make sure the next one goes out.
      lastStatus = ''
      break

    case 'iq': {
      blocksProcessed++
      const { centerFrequency, sampleRate } = msg
      if (!tuning || tuning.centerFrequency !== centerFrequency || tuning.sampleRate !== sampleRate) {
        analyzer.reset()
        tuning = { centerFrequency, sampleRate }
      }
      const iq = new Uint8Array(msg.data)
      const samplesPerFrame = Math.round(sampleRate / framesPerSecond)
      analyzer.push(iq, samplesPerFrame, (bins, clipFraction) => {
        const frame: SpectrumFrame = {
          type: 'spectrum',
          bins,
          centerFrequency,
          sampleRate,
          ...summarize(bins, centerFrequency, sampleRate),
          clipFraction,
          blocksProcessed,
        }
        post(frame, [bins.buffer])
      })
      receiver.process(iq, centerFrequency, sampleRate)
      postStatus()
      break
    }
  }
}
