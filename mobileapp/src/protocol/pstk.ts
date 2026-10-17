/**
 * Sonde Tracker link sentences, the same `$PSTK` lines the web app and the Heltec firmware use
 * (spec: arduino/common/SondeTrackerLink.h). Over LoRa each packet carries one line, so the
 * Heltec on the phone side can stay a dumb BLE <-> LoRa bridge.
 *
 *   $PSTK,<type>,<field>,...*<checksum>
 *
 * Types used by the search team:
 *   POS    src,fix,sats,hdop,lat,lon,altMsl,geoidSep,speed,course,utc[,rssi,snr]
 *          src is the sender's callsign; BASE_ID marks the base station (the laptop + Heltec tracker).
 *   SONDE  serial,frame,lat,lon,alt,climb,speed,course,utc
 *          sent by the base station for the balloon it is decoding.
 */

export const BASE_ID = 'BASE'
/** Callsigns that mean something else in the protocol. */
export const RESERVED_IDS = [BASE_ID, 'SELF']
export const FIX_OK = 2

export type Position = {
  src: string
  fix: number
  lat: number
  lon: number
  /** Meters above mean sea level. */
  alt?: number
  /** m/s over ground. */
  speed?: number
  /** Degrees true. */
  course?: number
  /** Unix seconds of the fix. */
  utc?: number
}

export type SondeReport = {
  serial: string
  frame: number
  lat: number
  lon: number
  alt: number
  climb?: number
  speed?: number
  course?: number
  utc?: number
}

export type Message = { type: 'pos'; pos: Position } | { type: 'sonde'; sonde: SondeReport }

export function checksum(body: string): string {
  let sum = 0
  for (let i = 0; i < body.length; i++) sum ^= body.charCodeAt(i)
  return sum.toString(16).toUpperCase().padStart(2, '0')
}

/** Wraps a body ("PSTK,POS,...") into a full line with checksum. */
export function sentence(body: string): string {
  return `$${body}*${checksum(body)}`
}

/** Body of a well-formed $PSTK line, or null when malformed or the checksum is wrong. */
export function checkedBody(line: string): string | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith('$PSTK,')) return null
  const star = trimmed.lastIndexOf('*')
  if (star < 0) return null
  const body = trimmed.slice(1, star)
  return trimmed.slice(star + 1).toUpperCase() === checksum(body) ? body : null
}

const num = (s: string | undefined): number | undefined => {
  if (s === undefined || s === '') return undefined
  const n = Number(s)
  return Number.isFinite(n) ? n : undefined
}

/** Number with fixed decimals, or an empty field when unknown. */
const field = (n: number | undefined, decimals: number) => (n === undefined || !Number.isFinite(n) ? '' : n.toFixed(decimals))

export function parseLine(line: string): Message | null {
  const body = checkedBody(line)
  if (!body) return null
  const f = body.split(',')
  switch (f[1]) {
    case 'POS': {
      const lat = num(f[6])
      const lon = num(f[7])
      const fix = num(f[3]) ?? 0
      if (!f[2] || lat === undefined || lon === undefined) return null
      return {
        type: 'pos',
        pos: { src: f[2], fix, lat, lon, alt: num(f[8]), speed: num(f[10]), course: num(f[11]), utc: num(f[12]) },
      }
    }
    case 'SONDE': {
      const lat = num(f[4])
      const lon = num(f[5])
      const alt = num(f[6])
      if (!f[2] || lat === undefined || lon === undefined || alt === undefined) return null
      return {
        type: 'sonde',
        sonde: {
          serial: f[2],
          frame: num(f[3]) ?? 0,
          lat,
          lon,
          alt,
          climb: num(f[7]),
          speed: num(f[8]),
          course: num(f[9]),
          utc: num(f[10]),
        },
      }
    }
    default:
      return null
  }
}

export function posSentence(p: Position): string {
  return sentence(
    [
      'PSTK',
      'POS',
      p.src,
      String(p.fix),
      '',
      '',
      p.lat.toFixed(6),
      p.lon.toFixed(6),
      field(p.alt, 1),
      '',
      field(p.speed, 2),
      field(p.course, 1),
      p.utc === undefined ? '' : String(Math.round(p.utc)),
    ].join(','),
  )
}

export function sondeSentence(s: SondeReport): string {
  return sentence(
    [
      'PSTK',
      'SONDE',
      s.serial,
      String(s.frame),
      s.lat.toFixed(6),
      s.lon.toFixed(6),
      s.alt.toFixed(0),
      field(s.climb, 1),
      field(s.speed, 1),
      field(s.course, 0),
      s.utc === undefined ? '' : String(Math.round(s.utc)),
    ].join(','),
  )
}

/** Uppercase letters, digits and '-', up to 8 characters: short enough to keep LoRa packets small. */
export function normalizeCallsign(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 8)
}

export function isValidCallsign(id: string): boolean {
  return id.length >= 2 && id === normalizeCallsign(id) && !RESERVED_IDS.includes(id)
}

/** Turns a byte stream (BLE notifications may split or join lines) into whole lines. */
export class LineSplitter {
  private buffer = ''

  push(chunk: string): string[] {
    this.buffer += chunk
    const parts = this.buffer.split(/\r?\n/)
    this.buffer = parts.pop() ?? ''
    // A notification without a newline is still one complete LoRa packet if it ends in a checksum.
    if (/\*[0-9A-Fa-f]{2}$/.test(this.buffer)) {
      parts.push(this.buffer)
      this.buffer = ''
    }
    if (this.buffer.length > 512) this.buffer = ''
    return parts.filter((l) => l.length > 0)
  }
}
