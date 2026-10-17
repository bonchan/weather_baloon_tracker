import { afterEach, describe, expect, it } from 'vitest'
import { sentence } from './protocol'
import { companions } from './store'

const POS = '$PSTK,POS,SELF,2,11,1.4,-38.978682,-67.841093,259.9,,0.07,0.0,1792250428,,*48'
const RMC = '$GNRMC,152028.00,A,3858.72094,S,06750.46555,W,0.146,,171026,,,A,V*1A'
const GGA = '$GNGGA,152028.00,3858.72094,S,06750.46555,W,1,11,1.35,259.9,M,,M,,*52'

const pos = (fields: string) => sentence(`PSTK,POS,${fields}`)
const device = (id: number) => companions.getState().devices.find((d) => d.id === id)!

let added: number[] = []
function openDevice() {
  const id = companions.addDevice({ usbVendorId: 0x303a, usbProductId: 0x1001 })
  companions.setLink(id, 'open')
  added.push(id)
  return id
}

afterEach(() => {
  for (const id of added) companions.removeDevice(id)
  added = []
})

describe('companion store', () => {
  it('skips positions queued before the port opened', () => {
    const id = openDevice()
    companions.handleLine(id, POS, 1000, true)
    expect(companions.getState().me?.deviceId).not.toBe(id)
    expect(device(id).lastSeen).toBe(1000)
  })

  it('puts me at the fix, with the ellipsoid height when the geoid is known', () => {
    const id = openDevice()
    companions.handleLine(id, POS, 1000)
    expect(companions.getState().me).toMatchObject({ lat: -38.978682, lon: -67.841093, alt: 259.9, lost: false })
    expect(device(id)).toMatchObject({ fix: 2, sats: 11, hdop: 1.4, protocol: 'pstk', lastSeen: 1000 })

    companions.handleLine(id, pos('SELF,2,9,1.0,-38.95,-68.1,250.0,17.5,12.5,93.0,1792250430,,'), 3000)
    expect(companions.getState().me).toMatchObject({ lat: -38.95, lon: -68.1, alt: 267.5, speed: 12.5, course: 93 })
  })

  it('marks me lost when the fix or the device goes, keeping the last position', () => {
    const id = openDevice()
    companions.handleLine(id, POS, 1000)
    companions.handleLine(id, pos('SELF,1,2,,,,,,,,,,'), 2000)
    expect(companions.getState().me).toMatchObject({ lat: -38.978682, lost: true, receivedAt: 1000 })
    expect(device(id).fix).toBe(1)
    companions.handleLine(id, POS, 3000)
    expect(companions.getState().me?.lost).toBe(false)
    companions.setLink(id, 'lost')
    expect(companions.getState().me).toMatchObject({ lat: -38.978682, lost: true })
  })

  it('reads a plain NMEA GPS from GGA + RMC', () => {
    const id = openDevice()
    companions.handleLine(id, RMC, 1000)
    companions.handleLine(id, GGA, 1000)
    expect(device(id)).toMatchObject({ protocol: 'nmea', fix: 2, sats: 11, hdop: 1.35 })
    expect(companions.getState().me?.lat).toBeCloseTo(-38.978682, 6)
    expect(companions.getState().me?.alt).toBe(259.9)
  })

  it("ignores a companion's forwarded NMEA", () => {
    const id = openDevice()
    companions.handleLine(id, sentence('PSTK,ID,1,GPS,GPS-USB-C3,1.0'), 500)
    companions.handleLine(id, RMC, 1000)
    companions.handleLine(id, GGA, 1000)
    expect(companions.getState().me?.deviceId).not.toBe(id)
    expect(device(id)).toMatchObject({ name: 'GPS-USB-C3', kind: 'GPS', firmware: '1.0', protocol: 'pstk' })
  })

  it('keeps to one GPS while it has a fresh fix', () => {
    const a = openDevice()
    const b = openDevice()
    companions.handleLine(a, POS, 1000)
    companions.handleLine(b, pos('SELF,2,7,2.0,-38.95,-68.1,250.0,,0,0,1792250428,,'), 1500)
    expect(companions.getState().me).toMatchObject({ deviceId: a, lat: -38.978682 })
    expect(device(b).fix).toBe(2)
    companions.handleLine(b, pos('SELF,2,7,2.0,-38.95,-68.1,250.0,,0,0,1792250434,,'), 7000)
    expect(companions.getState().me).toMatchObject({ deviceId: b, lat: -38.95 })
  })

  it('keeps remote trackers by id, apart from me', () => {
    const id = openDevice()
    companions.handleLine(id, pos('T7,2,8,0.9,-38.5,-68.5,1500,17,4.0,180,1792250428,-101,7.5'), 1000)
    companions.handleLine(id, pos('T9,1,3,,,,,,,,,-110,2.0'), 1000)
    const { trackers, me } = companions.getState()
    expect(trackers.T7).toMatchObject({ lat: -38.5, lon: -68.5, alt: 1517, rssi: -101, snr: 7.5, deviceId: id })
    expect(trackers.T9).toBeUndefined()
    expect(me?.deviceId).not.toBe(id)
  })

  it('keeps the last few log lines', () => {
    const id = openDevice()
    for (let i = 0; i < 8; i++) companions.handleLine(id, sentence(`PSTK,LOG,line ${i}, with a comma`), i)
    companions.handleLine(id, sentence('PSTK,ERR,Unknown command X'), 9)
    expect(device(id).logs.map((l) => l.text)).toEqual([
      'line 4, with a comma',
      'line 5, with a comma',
      'line 6, with a comma',
      'line 7, with a comma',
      'Unknown command X',
    ])
    expect(device(id).logs.at(-1)?.error).toBe(true)
  })
})
