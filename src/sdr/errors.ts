import { RadioError, RadioErrorType } from '@jtarrio/webrtlsdr/errors.js'

/** An error explained for a person standing next to the dongle. */
export type SdrProblem = {
  title: string
  detail: string
  hint?: string
}

const isWindows = typeof navigator !== 'undefined' && /Windows/i.test(navigator.userAgent)

const DRIVER_HINT = isWindows
  ? 'Windows needs the WinUSB driver on the dongle: run Zadig, enable Options → List All Devices, pick "Bulk-In, Interface (Interface 0)", select WinUSB and click Replace Driver. Then unplug and replug it.'
  : 'On Linux, blacklist the dvb_usb_rtl28xxu kernel module and add a udev rule so your user can open the device.'

const BUSY_HINT =
  'Close any other program using the dongle (SDR#, SDR++, rtl_tcp, another tab of this page) and try again.'

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
        return {
          title: 'Unsupported tuner chip',
          detail: e.message,
          hint: 'Supported: RTL2832U dongles with an R820T, R820T2, R860 or R828D tuner (RTL-SDR Blog V3/V4, NooElec NESDR and most generic sticks).',
        }
      case RadioErrorType.UsbTransferError:
        return { title: 'Could not claim the dongle', detail: e.message, hint: `${BUSY_HINT} ${DRIVER_HINT}` }
      case RadioErrorType.NoUsbSupport:
        return { title: 'WebUSB is not available', detail: e.message, hint: 'Use Chrome or Edge.' }
    }
    return { title: 'Radio error', detail: e.message }
  }
  if (e instanceof DOMException) {
    if (e.name === 'SecurityError') {
      return { title: 'Access to the dongle was denied', detail: e.message, hint: DRIVER_HINT }
    }
    if (e.name === 'NetworkError' || e.name === 'InvalidStateError') {
      return {
        title: 'USB communication failed',
        detail: e.message,
        hint: `${BUSY_HINT} If it keeps happening, unplug and replug the dongle.`,
      }
    }
  }
  return { title: 'Something went wrong', detail: message(e) }
}

export function describeStreamError(e: unknown): SdrProblem {
  return {
    title: 'Lost the sample stream',
    detail: message(e),
    hint: 'Was the dongle unplugged? Plug it back in and click Connect. If it happens repeatedly, try another USB port or a lower sample rate.',
  }
}

export const UNPLUGGED: SdrProblem = {
  title: 'Dongle unplugged',
  detail: 'The RTL-SDR disappeared from USB.',
  hint: 'Plug it back in and click Connect.',
}
