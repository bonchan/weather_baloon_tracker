/**
 * What companion devices send over USB serial: the Sonde Tracker link ($PSTK sentences,
 * see arduino/common/SondeTrackerLink.h) and, so any plain USB GPS works too, NMEA GGA/RMC.
 */

export const LINK_BAUD = 115_200
/** Longest $PSTK sentence; NMEA ones are at most 82 characters. */
const MAX_LINE = 160

export const FIX_NO_GPS = 0
export const FIX_SEARCHING = 1
export const FIX_OK = 2
/** 0: no data from the GPS module, 1: searching, 2: fix. */
export type Fix = typeof FIX_NO_GPS | typeof FIX_SEARCHING | typeof FIX_OK

/** POS src of the device's own GPS; anything else is a remote tracker's id. */
export const SRC_SELF = 'SELF'
/** POS src the base station uses over LoRa. */
export const SRC_BASE = 'BASE'
/** ID kind of the base station (GPS + LoRa on this computer) and of satellite nodes. */
export const KIND_BASE = 'BASE'
export const KIND_LORA = 'LORA'
/** Net of a LoRa node that isn't on a network. */
export const NO_NET = '----'

/** A position report. Missing fields are unknown. */
export type PositionReport = {
  src: string
  fix: Fix
  sats?: number
  hdop?: number
  /** Degrees, WGS84. Only when both are known. */
  lat?: number
  lon?: number
  /** m above mean sea level. */
  altMsl?: number
  /** m, geoid above the WGS84 ellipsoid: ellipsoid height = altMsl + geoidSep. */
  geoidSep?: number
  /** m/s over ground. */
  speed?: number
  /** Degrees true. */
  course?: number
  /** Unix time of the fix, s. */
  utc?: number
  /** dBm and dB of the radio packet (remote trackers). */
  rssi?: number
  snr?: number
  /** LoRa: the sending node's chip id, which identifies a team member (names can change). */
  device?: string
}

export type GgaSentence = {
  type: 'gga'
  /** UTC seconds since midnight. */
  time?: number
  /** 0 = no fix. */
  quality: number
  sats?: number
  hdop?: number
  lat?: number
  lon?: number
  altMsl?: number
  geoidSep?: number
}

export type RmcSentence = {
  type: 'rmc'
  /** UTC seconds since midnight. */
  time?: number
  /** Unix time of the day's midnight, s. */
  date?: number
  /** Status A; V means no fix. */
  valid: boolean
  lat?: number
  lon?: number
  speed?: number
  course?: number
}

export type CompanionMessage =
  | { type: 'id'; proto?: number; kind: string; name: string; firmware: string; net?: string; device?: string }
  | { type: 'pos'; pos: PositionReport }
  /** A sentence the base station heard over LoRa on its network. */
  | { type: 'heard'; rssi?: number; snr?: number; inner: CompanionMessage | null }
  /** A satellite asking the base station to let it into the network. */
  | { type: 'joinreq'; rssi?: number; snr?: number; device: string; callsign: string }
  | { type: 'log'; text: string }
  | { type: 'err'; text: string }
  | GgaSentence
  | RmcSentence

function xor(text: string): number {
  let sum = 0
  for (let i = 0; i < text.length; i++) sum ^= text.charCodeAt(i)
  return sum
}

/** A whole sentence ready to send: `$body*hh\r\n`. */
export function sentence(body: string): string {
  return `$${body}*${xor(body).toString(16).toUpperCase().padStart(2, '0')}\r\n`
}

/**
 * The text between '$' and '*' when the checksum matches, else null. Starts at the last '$',
 * so noise in front of a sentence (a line cut when the port opened) doesn't lose it.
 */
export function checkedBody(line: string): string | null {
  const start = line.lastIndexOf('$')
  const star = line.lastIndexOf('*')
  if (start < 0 || star < start) return null
  const sum = line.slice(star + 1).trim()
  if (!/^[0-9A-Fa-f]{2}$/.test(sum)) return null
  const body = line.slice(start + 1, star)
  return xor(body) === parseInt(sum, 16) ? body : null
}

const num = (s: string | undefined): number | undefined => {
  if (!s) return undefined
  const n = Number(s)
  return Number.isFinite(n) ? n : undefined
}

function latLon(lat: number | undefined, lon: number | undefined) {
  if (lat === undefined || lon === undefined || Math.abs(lat) > 90 || Math.abs(lon) > 180) return {}
  return { lat, lon }
}

function parsePos(f: string[]): CompanionMessage | null {
  const [src, fix, sats, hdop, lat, lon, altMsl, geoidSep, speed, course, utc, rssi, snr, device] = f
  if (!src || (fix !== '0' && fix !== '1' && fix !== '2')) return null
  const time = num(utc)
  return {
    type: 'pos',
    pos: {
      src,
      fix: Number(fix) as Fix,
      sats: num(sats),
      hdop: num(hdop),
      ...latLon(num(lat), num(lon)),
      altMsl: num(altMsl),
      geoidSep: num(geoidSep),
      speed: num(speed),
      course: num(course),
      utc: time ? time : undefined,
      rssi: num(rssi),
      snr: num(snr),
      device: device || undefined,
    },
  }
}

function parsePstk(body: string): CompanionMessage | null {
  const f = body.split(',')
  switch (f[1]) {
    case 'ID':
      return {
        type: 'id',
        proto: num(f[2]),
        kind: f[3] ?? '',
        name: f[4] ?? '',
        firmware: f[5] ?? '',
        net: f[6] || undefined,
        device: f[7] || undefined,
      }
    case 'HEARD': {
      // HEARD,rssi,snr,<inner sentence without $ and *hh>
      const inner = f.slice(4).join(',')
      return { type: 'heard', rssi: num(f[2]), snr: num(f[3]), inner: inner.startsWith('PSTK,') ? parsePstk(inner) : null }
    }
    case 'JOINREQ':
      if (!f[4] || !f[5]) return null
      return { type: 'joinreq', rssi: num(f[2]), snr: num(f[3]), device: f[4], callsign: f[5] }
    case 'POS':
      return parsePos(f.slice(2))
    case 'LOG':
    case 'ERR': {
      // The text is the rest of the line and may hold commas. ("LOG" and "ERR" are the same length.)
      const text = body.slice('PSTK,LOG,'.length)
      return f[1] === 'LOG' ? { type: 'log', text } : { type: 'err', text }
    }
  }
  return null
}

const field = (n: number | undefined, digits: number) => (n === undefined || !Number.isFinite(n) ? '' : n.toFixed(digits))

/** POS body (no $ / checksum) for a position to send over LoRa, e.g. relaying a team member. */
export function posBody(p: {
  src: string
  lat: number
  lon: number
  altMsl?: number
  speed?: number
  course?: number
  utc?: number
  device?: string
}): string {
  return [
    'PSTK',
    'POS',
    p.src,
    FIX_OK,
    '',
    '',
    p.lat.toFixed(6),
    p.lon.toFixed(6),
    field(p.altMsl, 1),
    '',
    field(p.speed, 2),
    field(p.course, 1),
    p.utc === undefined ? '' : Math.round(p.utc),
    '',
    '',
    p.device ?? '',
  ].join(',')
}

/** SONDE body for the balloon the decoder is following. */
export function sondeBody(s: {
  serial: string
  frame: number
  lat: number
  lon: number
  alt: number
  climb?: number
  speed?: number
  course?: number
  utc?: number
}): string {
  return [
    'PSTK',
    'SONDE',
    s.serial,
    s.frame,
    s.lat.toFixed(6),
    s.lon.toFixed(6),
    s.alt.toFixed(0),
    field(s.climb, 1),
    field(s.speed, 1),
    field(s.course, 0),
    s.utc === undefined ? '' : Math.round(s.utc),
  ].join(',')
}

/** NMEA ddmm.mmmm (latitude) or dddmm.mmmm (longitude) plus hemisphere to signed degrees. */
export function nmeaDegrees(value: string | undefined, hemisphere: string | undefined): number | undefined {
  if (!value || !hemisphere || !/^\d+(\.\d*)?$/.test(value)) return undefined
  const dot = value.includes('.') ? value.indexOf('.') : value.length
  // Split the string rather than divide, so no rounding creeps into the degrees.
  const degrees = Number(value.slice(0, dot - 2) || '0')
  const minutes = Number(value.slice(dot - 2))
  if (minutes >= 60) return undefined
  const d = degrees + minutes / 60
  if (hemisphere === 'N' || hemisphere === 'E') return d
  if (hemisphere === 'S' || hemisphere === 'W') return -d
  return undefined
}

/** hhmmss.ss to seconds since midnight. */
function nmeaTime(s: string | undefined): number | undefined {
  const m = s?.match(/^(\d\d)(\d\d)(\d\d(?:\.\d*)?)$/)
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : undefined
}

/** ddmmyy to the Unix time of that midnight. */
function nmeaDate(s: string | undefined): number | undefined {
  const m = s?.match(/^(\d\d)(\d\d)(\d\d)$/)
  return m ? Date.UTC(2000 + Number(m[3]), Number(m[2]) - 1, Number(m[1])) / 1000 : undefined
}

const KNOT = 1852 / 3600

function parseNmea(body: string): CompanionMessage | null {
  const f = body.split(',')
  // The last three letters name the sentence whatever the talker (GP, GN, GL...).
  if (f[0].length !== 5) return null
  switch (f[0].slice(2)) {
    case 'GGA':
      return {
        type: 'gga',
        time: nmeaTime(f[1]),
        quality: num(f[6]) ?? 0,
        sats: num(f[7]),
        hdop: num(f[8]),
        ...latLon(nmeaDegrees(f[2], f[3]), nmeaDegrees(f[4], f[5])),
        altMsl: num(f[9]),
        geoidSep: num(f[11]),
      }
    case 'RMC': {
      const speed = num(f[7])
      return {
        type: 'rmc',
        time: nmeaTime(f[1]),
        date: nmeaDate(f[9]),
        valid: f[2] === 'A',
        ...latLon(nmeaDegrees(f[3], f[4]), nmeaDegrees(f[5], f[6])),
        speed: speed === undefined ? undefined : speed * KNOT,
        course: num(f[8]),
      }
    }
  }
  return null
}

/** One line from a device, or null for anything else (bad checksum, other NMEA, noise). */
export function parseLine(line: string): CompanionMessage | null {
  const body = checkedBody(line)
  if (body === null) return null
  return body.startsWith('PSTK,') ? parsePstk(body) : parseNmea(body)
}

const DAY = 86_400

/** Unix time from a GGA time of day and the date of an RMC that may be just across midnight. */
function utcOf(time: number | undefined, rmc: RmcSentence | null): number | undefined {
  if (time === undefined || rmc?.date === undefined || rmc.time === undefined) return undefined
  let date = rmc.date
  if (rmc.time - time > DAY / 2) date += DAY
  else if (time - rmc.time > DAY / 2) date -= DAY
  return Math.round(date + time)
}

/**
 * Turns a plain NMEA GPS's sentences into position reports: one per GGA (fix, altitude,
 * satellites), with speed, course and date from the RMC of the same second. A receiver
 * that sends only RMC gets one per RMC.
 */
export class NmeaFixer {
  private rmc: RmcSentence | null = null
  private sawGga = false

  push(s: GgaSentence | RmcSentence): PositionReport | null {
    if (s.type === 'rmc') {
      this.rmc = s
      if (this.sawGga) return null
      const fix = s.valid && s.lat !== undefined ? FIX_OK : FIX_SEARCHING
      const utc = s.date !== undefined && s.time !== undefined ? Math.round(s.date + s.time) : undefined
      return {
        src: SRC_SELF,
        fix,
        ...(fix === FIX_OK ? { lat: s.lat, lon: s.lon, speed: s.speed, course: s.course } : {}),
        utc,
      }
    }
    this.sawGga = true
    const rmc = this.rmc
    const fix = s.quality > 0 && s.lat !== undefined ? FIX_OK : FIX_SEARCHING
    const sameSecond = rmc?.valid && rmc.time !== undefined && s.time !== undefined && Math.abs(rmc.time - s.time) < 1.5
    return {
      src: SRC_SELF,
      fix,
      sats: s.sats,
      hdop: s.hdop,
      ...(fix === FIX_OK ? { lat: s.lat, lon: s.lon, altMsl: s.altMsl, geoidSep: s.geoidSep } : {}),
      ...(fix === FIX_OK && sameSecond ? { speed: rmc.speed, course: rmc.course } : {}),
      utc: utcOf(s.time, rmc),
    }
  }
}

/** Splits text read from a port into lines. */
export class LineSplitter {
  private partial = ''

  push(text: string): string[] {
    const lines = (this.partial + text).split(/[\r\n]+/)
    this.partial = lines.pop()!
    if (this.partial.length > MAX_LINE) {
      // Noise with no line end: keep only what can still become a sentence.
      const start = this.partial.lastIndexOf('$')
      this.partial = start >= 0 && this.partial.length - start <= MAX_LINE ? this.partial.slice(start) : ''
    }
    return lines.filter((l) => l.length > 0)
  }
}
