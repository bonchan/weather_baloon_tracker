import { describe, expect, it } from 'vitest'
import { checkedBody, isValidCallsign, LineSplitter, normalizeCallsign, parseLine, posSentence, sondeSentence } from './pstk'

// A real line from the user's Heltec Wireless Tracker.
const REAL_POS = '$PSTK,POS,SELF,2,11,1.4,-38.978682,-67.841093,259.9,,0.07,0.0,1792250428,,*48'

describe('$PSTK sentences', () => {
  it('accepts a real device line and rejects a bad checksum', () => {
    expect(checkedBody(REAL_POS)).not.toBeNull()
    expect(checkedBody(REAL_POS.replace('*48', '*49'))).toBeNull()
    expect(checkedBody('$GNRMC,152028.00,A*1A')).toBeNull()
  })

  it('parses POS fields, empty ones as unknown', () => {
    const msg = parseLine(REAL_POS)
    expect(msg).toEqual({
      type: 'pos',
      pos: { src: 'SELF', fix: 2, lat: -38.978682, lon: -67.841093, alt: 259.9, speed: 0.07, course: 0, utc: 1792250428 },
    })
  })

  it('round-trips POS and SONDE', () => {
    const pos = { src: 'JUAN', fix: 2, lat: -38.95123, lon: -68.0571, alt: 270.5, speed: 3.25, course: 91.5, utc: 1792250430 }
    expect(parseLine(posSentence(pos))).toEqual({ type: 'pos', pos })
    const sonde = { serial: 'W4130123', frame: 4512, lat: -38.8, lon: -67.5, alt: 18342, climb: 5.2, speed: 22.4, course: 95, utc: 1792250431 }
    const line = sondeSentence(sonde)
    expect(line.length).toBeLessThan(100)
    expect(parseLine(line)).toEqual({ type: 'sonde', sonde })
  })

  it('leaves unknown values empty', () => {
    const line = posSentence({ src: 'ANA', fix: 2, lat: 1, lon: 2 })
    expect(line).toMatch(/^\$PSTK,POS,ANA,2,,,1\.000000,2\.000000,,,,,\*[0-9A-F]{2}$/)
  })
})

describe('callsigns', () => {
  it('normalizes and validates', () => {
    expect(normalizeCallsign('juan pérez 123')).toBe('JUANPREZ')
    expect(isValidCallsign('JUAN')).toBe(true)
    expect(isValidCallsign('BASE')).toBe(false)
    expect(isValidCallsign('J')).toBe(false)
  })
})

describe('LineSplitter', () => {
  it('joins split notifications and treats a checksum-terminated chunk as a whole packet', () => {
    const s = new LineSplitter()
    expect(s.push('$PSTK,POS,A')).toEqual([])
    expect(s.push('NA,2,,,1,2,,,,,*00')).toEqual(['$PSTK,POS,ANA,2,,,1,2,,,,,*00'])
    expect(s.push('one\r\ntwo\npart')).toEqual(['one', 'two'])
  })
})
