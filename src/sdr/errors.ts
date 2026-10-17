import { RadioError, RadioErrorType } from '@jtarrio/webrtlsdr/errors.js'
import type { MessageKey } from '../i18n'

/**
 * An error explained for a person standing next to the dongle. Title and hints
 * are translation keys; detail is the raw technical message, left untranslated.
 */
export type SdrProblem = {
  title: MessageKey
  detail?: string
  hints: MessageKey[]
}

const isWindows = typeof navigator !== 'undefined' && /Windows/i.test(navigator.userAgent)
const DRIVER_HINT: MessageKey = isWindows ? 'hint.driverWindows' : 'hint.driverLinux'

/** The user closed the device picker without choosing anything. */
export function isUserCancel(e: unknown): boolean {
  return e instanceof DOMException && e.name === 'NotFoundError'
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export function describeError(e: unknown): SdrProblem {
  if (e instanceof RadioError) {
    switch (e.type) {
      case RadioErrorType.UnsupportedDevice:
        return { title: 'error.unsupportedTuner', detail: e.message, hints: ['hint.supportedTuners'] }
      case RadioErrorType.UsbTransferError:
        return { title: 'error.claim', detail: e.message, hints: ['hint.busy', DRIVER_HINT] }
      case RadioErrorType.NoUsbSupport:
        return { title: 'error.noWebUsb', detail: e.message, hints: ['hint.useChrome'] }
    }
    return { title: 'error.radio', detail: e.message, hints: [] }
  }
  if (e instanceof DOMException) {
    if (e.name === 'SecurityError') return { title: 'error.denied', detail: e.message, hints: [DRIVER_HINT] }
    if (e.name === 'NetworkError' || e.name === 'InvalidStateError') {
      return { title: 'error.usbFailed', detail: e.message, hints: ['hint.busy', 'hint.replug'] }
    }
  }
  return { title: 'error.generic', detail: message(e), hints: [] }
}

export function describeStreamError(e: unknown): SdrProblem {
  return { title: 'error.streamLost', detail: message(e), hints: ['hint.streamLost'] }
}

export const UNPLUGGED: SdrProblem = { title: 'error.unplugged', hints: ['hint.unplugged'] }
