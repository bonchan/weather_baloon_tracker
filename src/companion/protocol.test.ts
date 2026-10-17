import { describe, expect, it } from 'vitest'
import {
  checkedBody,
  FIX_OK,
  FIX_SEARCHING,
  LineSplitter,
  nmeaDegrees,
  NmeaFixer,
  parseLine,
  sentence,
  type GgaSentence,
  type PositionReport,
  type RmcSentence,
} from './protocol'

// Captured from the user's ESP32-C3 + NEO-6M companion in Neuquén.
const POS = '$PSTK,POS,SELF,2,11,1.4,-38.978682,-67.841093,259.9,,0.07,0.0,1792250428,,*48'
const RMC = '$GNRMC,152028.00,A,3858.72094,S,06750.46555,W,0.146,,171026,,,A,V*1A'
const GGA = '$GNGGA,152028.00,3858.72094,S,06750.46555,W,1,11,1.35,259.9,M,,M,,*52'
const TXT = '$GNTXT,01,01,01,0,500482,0000,80A0,80A0,234.680,0,0001F7FF01BF0200*25'
const GSV = '$GPGSV,4,1,15,05,16,140,40,10,12,000,,15,04,086,,16,34,227,31,1*6F'

/** 2026-10-17 15:20:28 UTC, the time in every line above. */
const UTC = 1792250428

const near = (a: number | undefined, b: number) => expect(Math.abs(a! - b)).toBeLessThan(1e-6)

describe('checksums', () => {
  it('accepts every captured line', () => {
    for (const line of [POS, RMC, GGA, TXT, GSV]) expect(checkedBody(line)).not.toBeNull()
  })

  it('accepts a line ending in CR LF and lowercase hex', () => {
    expect(checkedBody(POS + '\r\n')).not.toBeNull()
    expect(checkedBody('$GPGSV,4,1,15,05,16,140,40,10,12,000,,15,04,086,,16,34,227,31,1*6f')).not.toBeNull()
  })

  it('rejects a changed character, a wrong or missing checksum', () => {
    expect(parseLine(POS.replace('-38.978682', '-38.978692'))).toBeNull()
    expect(parseLine(POS.replace('*48', '*49'))).toBeNull()
    expect(parseLine(POS.replace('*48', ''))).toBeNull()
    expect(parseLine(POS.replace('*48', '*4'))).toBeNull()
    expect(parseLine(GGA.replace('*52', '*52x'))).toBeNull()
  })

  it('finds a sentence behind noise from a line cut when the port opened', () => {
    expect(parseLine('5.46555,W,1,11*3' + POS)).toMatchObject({ type: 'pos' })
  })

  it('builds commands the device accepts', () => {
    expect(sentence('PSTK,HELLO')).toBe('$PSTK,HELLO*72\r\n')
    expect(checkedBody(sentence('PSTK,HELLO'))).toBe('PSTK,HELLO')
  })
})

describe('$PSTK', () => {
  it('reads every POS field and leaves empty ones unknown', () => {
    expect(parseLine(POS)).toEqual({
      type: 'pos',
      pos: {
        src: 'SELF',
        fix: FIX_OK,
        sats: 11,
        hdop: 1.4,
        lat: -38.978682,
        lon: -67.841093,
        altMsl: 259.9,
        geoidSep: undefined,
        speed: 0.07,
        course: 0,
        utc: UTC,
        rssi: undefined,
        snr: undefined,
      },
    })
  })

  it('reads a searching POS with no position, and a remote tracker', () => {
    const searching = parseLine(sentence('PSTK,POS,SELF,1,3,,,,,,,,1792250428,,')) as { pos: PositionReport }
    expect(searching.pos).toMatchObject({ src: 'SELF', fix: FIX_SEARCHING, sats: 3, utc: UTC })
    expect(searching.pos).not.toHaveProperty('lat')
    expect(searching.pos).not.toHaveProperty('lon')
    expect(parseLine(sentence('PSTK,POS,T1,2,8,0.9,-38.9,-68.1,1200.5,17.2,3.5,270.0,1792250428,-97,8.5'))).toMatchObject({
      pos: { src: 'T1', fix: FIX_OK, geoidSep: 17.2, rssi: -97, snr: 8.5 },
    })
  })

  it('ignores extra trailing fields and rejects a bad fix', () => {
    expect(parseLine(sentence('PSTK,POS,SELF,2,9,1.0,-38.9,-68.1,250,15,0,0,1792250428,,,future,fields'))).toMatchObject({
      pos: { lat: -38.9, lon: -68.1, geoidSep: 15 },
    })
    expect(parseLine(sentence('PSTK,POS,SELF,7,9,1.0,-38.9,-68.1,250,15,0,0,1792250428,,'))).toBeNull()
    // Out of range: no position at all rather than half of one.
    expect((parseLine(sentence('PSTK,POS,SELF,2,9,1.0,-138.9,-68.1,250,15,0,0,1792250428,,')) as { pos: PositionReport }).pos).not.toHaveProperty('lon')
  })

  it('reads ID, LOG with commas, and ERR', () => {
    expect(parseLine(sentence('PSTK,ID,1,GPS,GPS-USB-C3,1.2.0'))).toEqual({
      type: 'id',
      proto: 1,
      kind: 'GPS',
      name: 'GPS-USB-C3',
      firmware: '1.2.0',
    })
    expect(parseLine(sentence('PSTK,LOG,GPS module at 9600 baud, 11 sats'))).toEqual({
      type: 'log',
      text: 'GPS module at 9600 baud, 11 sats',
    })
    expect(parseLine(sentence('PSTK,ERR,Unknown command FOO'))).toEqual({ type: 'err', text: 'Unknown command FOO' })
  })

  it('ignores unknown types and other NMEA', () => {
    expect(parseLine(sentence('PSTK,BATT,3.9'))).toBeNull()
    expect(parseLine(TXT)).toBeNull()
    expect(parseLine(GSV)).toBeNull()
    expect(parseLine('')).toBeNull()
    expect(parseLine('ets Jul 29 2019 12:21:46')).toBeNull()
  })
})

describe('NMEA', () => {
  it('converts ddmm.mmmmm to degrees', () => {
    near(nmeaDegrees('3858.72094', 'S'), -38.978682)
    near(nmeaDegrees('06750.46555', 'W'), -67.841093)
    expect(nmeaDegrees('4807.038', 'N')).toBeCloseTo(48.1173, 6)
    expect(nmeaDegrees('01131.000', 'E')).toBeCloseTo(11.516667, 6)
    expect(nmeaDegrees('', 'S')).toBeUndefined()
    expect(nmeaDegrees('3858.72094', '')).toBeUndefined()
    expect(nmeaDegrees('3875.0', 'S')).toBeUndefined()
  })

  it('reads GGA', () => {
    const gga = parseLine(GGA) as GgaSentence
    expect(gga).toMatchObject({ type: 'gga', time: 15 * 3600 + 20 * 60 + 28, quality: 1, sats: 11, hdop: 1.35, altMsl: 259.9 })
    expect(gga.geoidSep).toBeUndefined()
    near(gga.lat, -38.978682)
    near(gga.lon, -67.841093)
  })

  it('reads RMC', () => {
    const rmc = parseLine(RMC) as RmcSentence
    expect(rmc).toMatchObject({ type: 'rmc', valid: true, date: UTC - (15 * 3600 + 20 * 60 + 28), course: undefined })
    expect(rmc.speed).toBeCloseTo(0.146 * 0.514444, 5)
    near(rmc.lat, -38.978682)
    near(rmc.lon, -67.841093)
  })

  it('makes the same report from GGA + RMC as the companion sends in its POS', () => {
    const fixer = new NmeaFixer()
    expect(fixer.push(parseLine(RMC) as RmcSentence)).toMatchObject({ fix: FIX_OK })
    const report = fixer.push(parseLine(GGA) as GgaSentence)!
    const pos = (parseLine(POS) as { pos: object }).pos
    expect(report).toMatchObject({ src: 'SELF', fix: FIX_OK, sats: 11, altMsl: 259.9, utc: UTC })
    near(report.lat, -38.978682)
    near(report.lon, -67.841093)
    expect(report.speed).toBeCloseTo(0.075, 3)
    expect(pos).toMatchObject({ fix: report.fix, sats: report.sats, altMsl: report.altMsl, utc: report.utc })
  })

  it('reports once per GGA once it has seen one, and searching without a fix', () => {
    const fixer = new NmeaFixer()
    fixer.push(parseLine(GGA) as GgaSentence)
    expect(fixer.push(parseLine(RMC) as RmcSentence)).toBeNull()
    const noFix = parseLine(sentence('GPGGA,152029.00,,,,,0,03,99.9,,,,,,')) as GgaSentence
    const searching = fixer.push(noFix)
    expect(searching).toMatchObject({ fix: FIX_SEARCHING, sats: 3 })
    expect(searching).not.toHaveProperty('lat')
  })

  it('dates a GGA just after midnight with the RMC from just before', () => {
    const fixer = new NmeaFixer()
    fixer.push(parseLine(sentence('GPRMC,235959.00,A,3858.72094,S,06750.46555,W,0.1,,171026,,,A')) as RmcSentence)
    const report = fixer.push(parseLine(sentence('GPGGA,000000.00,3858.72094,S,06750.46555,W,1,08,1.0,260.0,M,17.0,M,,')) as GgaSentence)
    expect(report).toMatchObject({ utc: Date.UTC(2026, 9, 18) / 1000, geoidSep: 17 })
    // A day-old RMC gives no speed.
    expect(report?.speed).toBeUndefined()
  })
})

describe('LineSplitter', () => {
  it('joins lines split across reads and drops empty ones', () => {
    const s = new LineSplitter()
    expect(s.push(POS.slice(0, 30))).toEqual([])
    expect(s.push(POS.slice(30) + '\r\n' + RMC.slice(0, 10))).toEqual([POS])
    expect(s.push(RMC.slice(10) + '\r\n\r\n' + GGA + '\n')).toEqual([RMC, GGA])
  })

  it('does not grow without bound on noise, and resyncs on $', () => {
    const s = new LineSplitter()
    s.push('x'.repeat(1000))
    s.push('y'.repeat(1000) + POS.slice(0, 20))
    expect(s.push(POS.slice(20) + '\r\n').map(parseLine)).toMatchObject([{ type: 'pos' }])
  })
})
