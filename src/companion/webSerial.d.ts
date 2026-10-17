// The parts of Web Serial (https://wicg.github.io/serial/) the app uses. TypeScript's DOM
// types don't include it yet; Chrome and Edge ship it.

export {}

declare global {
  interface SerialPortInfo {
    usbVendorId?: number
    usbProductId?: number
  }

  interface SerialOptions {
    baudRate: number
    dataBits?: 7 | 8
    stopBits?: 1 | 2
    parity?: 'none' | 'even' | 'odd'
    bufferSize?: number
    flowControl?: 'none' | 'hardware'
  }

  interface SerialPort extends EventTarget {
    readonly readable: ReadableStream<Uint8Array> | null
    readonly writable: WritableStream<Uint8Array> | null
    open(options: SerialOptions): Promise<void>
    close(): Promise<void>
    /** Chrome 103+. */
    forget?(): Promise<void>
    getInfo(): SerialPortInfo
  }

  interface Serial extends EventTarget {
    getPorts(): Promise<SerialPort[]>
    requestPort(options?: { filters?: SerialPortInfo[] }): Promise<SerialPort>
  }

  interface Navigator {
    /** Chrome and Edge on desktop only. */
    readonly serial?: Serial
  }
}
