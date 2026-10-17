import { describe, expect, it } from 'vitest'
import { parseLine, posBody, sentence, sondeBody } from './protocol'
import { companions } from './store'

const line = (body: string) => sentence(body).trim()

describe('LoRa team lines', () => {
  it('reads the ID of a base station with its network and chip id', () => {
    expect(parseLine(line('PSTK,ID,1,BASE,Base-Heltec-Tracker,2.0,3F2A,A1B2C3'))).toEqual({
      type: 'id',
      proto: 1,
      kind: 'BASE',
      name: 'Base-Heltec-Tracker',
      firmware: '2.0',
      net: '3F2A',
      device: 'A1B2C3',
    })
  })

  it('unwraps a position heard over LoRa', () => {
    const inner = posBody({ src: 'JUAN', lat: -38.95, lon: -68.06, altMsl: 270, speed: 1.2, course: 90, utc: 1792250428 })
    const msg = parseLine(line(`PSTK,HEARD,-87,6.5,${inner}`))
    expect(msg?.type).toBe('heard')
    if (msg?.type !== 'heard') return
    expect(msg.rssi).toBe(-87)
    expect(msg.snr).toBe(6.5)
    expect(msg.inner).toMatchObject({ type: 'pos', pos: { src: 'JUAN', fix: 2, lat: -38.95, lon: -68.06, altMsl: 270 } })
  })

  it('reads a join request', () => {
    expect(parseLine(line('PSTK,JOINREQ,-95,2.0,A1B2C3,ANA'))).toEqual({
      type: 'joinreq',
      rssi: -95,
      snr: 2,
      device: 'A1B2C3',
      callsign: 'ANA',
    })
  })

  it('builds a SONDE body short enough for one LoRa packet', () => {
    const body = sondeBody({ serial: 'W4130123', frame: 4512, lat: -38.8, lon: -67.5, alt: 18342.4, climb: 5.2, speed: 22.4, course: 95, utc: 1792250431 })
    expect(body).toBe('PSTK,SONDE,W4130123,4512,-38.800000,-67.500000,18342,5.2,22.4,95,1792250431')
    expect(body.length).toBeLessThan(120)
  })
})

describe('team in the companion store', () => {
  it('turns heard positions into trackers and join requests into a list', () => {
    const id = companions.addDevice({})
    companions.setLink(id, 'open')
    companions.handleLine(id, line('PSTK,ID,1,BASE,Base,2.0,3F2A,FFEE01'), 1000)
    expect(companions.getState().devices.find((d) => d.id === id)).toMatchObject({ kind: 'BASE', net: '3F2A', loraId: 'FFEE01' })

    const inner = posBody({ src: 'JUAN', lat: -38.95, lon: -68.06 })
    companions.handleLine(id, line(`PSTK,HEARD,-80,7.0,${inner}`), 2000)
    expect(companions.getState().trackers.JUAN).toMatchObject({ lat: -38.95, lon: -68.06, rssi: -80, snr: 7 })

    companions.handleLine(id, line('PSTK,JOINREQ,-95,2.0,A1B2C3,ANA'), 3000)
    expect(companions.getState().joinRequests).toEqual([
      { loraId: 'A1B2C3', callsign: 'ANA', rssi: -95, snr: 2, receivedAt: 3000, deviceId: id },
    ])
    companions.dropJoinRequest('A1B2C3')
    expect(companions.getState().joinRequests).toEqual([])
    companions.removeDevice(id)
  })
})

describe('team members are their node, not their name', () => {
  it('keeps one member when a satellite changes its name', () => {
    const id = companions.addDevice({})
    companions.setLink(id, 'open')
    companions.handleLine(id, line(`PSTK,HEARD,-80,7.0,${posBody({ src: 'JUAN', lat: -38.9, lon: -68.0, device: 'A1B2C3' })}`), 1000)
    companions.handleLine(id, line(`PSTK,HEARD,-81,6.0,${posBody({ src: 'JUANCHO', lat: -38.91, lon: -68.01, device: 'A1B2C3' })}`), 2000)
    const team = Object.values(companions.getState().trackers).filter((t) => t.device === 'A1B2C3')
    expect(team).toHaveLength(1)
    expect(team[0]).toMatchObject({ id: 'A1B2C3', name: 'JUANCHO', lat: -38.91 })

    companions.clearTeam()
    expect(companions.getState().trackers.A1B2C3).toBeUndefined()
    companions.removeDevice(id)
  })

  it('gives a member the same color everywhere', async () => {
    const { memberColor } = await import('./colors')
    // Pinned: android/.../team/MemberColors.kt must give the same (hash 1908163728, index 0).
    expect(memberColor('A1B2C3')).toBe('#9b8cff')
  })
})
