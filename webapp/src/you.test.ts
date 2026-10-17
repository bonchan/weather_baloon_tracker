import { describe, expect, it } from 'vitest'
import type { MyPosition } from './companion/store'
import { currentYou, loadPin, type Pin } from './you'

const gps = (patch: Partial<MyPosition> = {}): MyPosition => ({
  lat: -38.97,
  lon: -67.83,
  alt: 279.3,
  speed: 16.7,
  course: 48,
  receivedAt: 5000,
  deviceId: 1,
  lost: false,
  ...patch,
})
const pin = (placedAt: number): Pin => ({ lat: -38.95, lon: -68.06, alt: 271, placedAt })

function memoryStorage(items: Record<string, string>) {
  const map = new Map(Object.entries(items))
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  }
}

describe('currentYou', () => {
  it('is nowhere without a GPS or a pin', () => {
    expect(currentYou(null, null)).toBeNull()
  })

  it('is the pin without a GPS', () => {
    expect(currentYou(null, pin(1000))).toEqual({ lat: -38.95, lon: -68.06, alt: 271, source: 'pin', stale: false })
  })

  it('is the live GPS fix, even with a newer pin', () => {
    expect(currentYou(gps(), pin(9000))).toEqual({
      lat: -38.97,
      lon: -67.83,
      alt: 279.3,
      speed: 16.7,
      course: 48,
      source: 'gps',
      stale: false,
    })
  })

  it("keeps a lost fix's last position over an older pin", () => {
    expect(currentYou(gps({ lost: true }), pin(1000))).toMatchObject({ source: 'gps', stale: true, lat: -38.97 })
    expect(currentYou(gps({ lost: true }), null)).toMatchObject({ source: 'gps', stale: true })
  })

  it('takes a pin placed after the fix was lost', () => {
    expect(currentYou(gps({ lost: true }), pin(9000))).toMatchObject({ source: 'pin', lat: -38.95 })
  })
})

describe('loadPin', () => {
  it('moves a station saved by an older version over to the pin', () => {
    const storage = memoryStorage({ 'sondetracker.station.v1': '{"lat":-38.9,"lon":-68.0,"alt":300}' })
    expect(loadPin(storage)).toEqual({ lat: -38.9, lon: -68.0, alt: 300, placedAt: 0 })
    expect(storage.map.has('sondetracker.station.v1')).toBe(false)
    expect(loadPin(storage)).toEqual({ lat: -38.9, lon: -68.0, alt: 300, placedAt: 0 })
  })

  it('keeps an existing pin over an old station', () => {
    const storage = memoryStorage({
      'sondetracker.station.v1': '{"lat":-38.9,"lon":-68.0,"alt":300}',
      'sondetracker.you.v1': '{"lat":-38.95,"lon":-68.06,"alt":271,"placedAt":1000}',
    })
    expect(loadPin(storage)).toEqual(pin(1000))
    expect(storage.map.has('sondetracker.station.v1')).toBe(false)
  })

  it('is null when nothing or garbage is saved', () => {
    expect(loadPin(memoryStorage({}))).toBeNull()
    expect(loadPin(memoryStorage({ 'sondetracker.you.v1': 'not json' }))).toBeNull()
    expect(loadPin(undefined)).toBeNull()
  })
})
