import { describe, expect, it } from 'vitest'
import { distanceBearing, ecefToEnu, ecefToGeodetic, elevationAngle, geodeticToEcef, offsetMeters } from './geo'

describe('geo', () => {
  it('measures distance and bearing', () => {
    // Two points in Neuquén about 6 km apart, the second to the ENE.
    const { distance, bearing } = distanceBearing(-38.9516, -68.0591, -38.9339, -67.9906)
    expect(distance).toBeGreaterThan(5_500)
    expect(distance).toBeLessThan(6_500)
    expect(bearing).toBeGreaterThan(60)
    expect(bearing).toBeLessThan(80)
  })

  it('gives 45° for a target as high as it is far (nearby)', () => {
    expect(elevationAngle(1000, 0, 1000)).toBeCloseTo(45, 0)
  })

  it('drops below the horizon far away at low altitude', () => {
    expect(elevationAngle(300_000, 0, 1000)).toBeLessThan(0)
  })

  it('offsets round-trip with distanceBearing', () => {
    const p = offsetMeters(-38.95, -68.06, 3000, 4000)
    const { distance } = distanceBearing(-38.95, -68.06, p.lat, p.lon)
    expect(distance).toBeCloseTo(5000, -1)
  })
})

describe('ECEF', () => {
  it('puts the equator/prime meridian and the pole where they belong', () => {
    const a = ecefToGeodetic(6_378_137, 0, 0)
    expect(a.lat).toBeCloseTo(0, 9)
    expect(a.lon).toBeCloseTo(0, 9)
    expect(a.alt).toBeCloseTo(0, 3)
    const pole = ecefToGeodetic(0, 0, 6_356_752.314_245)
    expect(pole.lat).toBeCloseTo(90, 9)
    expect(pole.alt).toBeCloseTo(0, 3)
  })

  it('round-trips from the ground to burst altitude', () => {
    for (const [lat, lon, alt] of [
      [-38.9516, -68.0591, 271],
      [-38.5, -69.25, 12_000],
      [-40.1, -66.3, 35_000],
      [51.2, 9.4, -50],
    ]) {
      const { x, y, z } = geodeticToEcef(lat, lon, alt)
      const back = ecefToGeodetic(x, y, z)
      expect(back.lat).toBeCloseTo(lat, 9)
      expect(back.lon).toBeCloseTo(lon, 9)
      expect(back.alt).toBeCloseTo(alt, 3)
    }
  })

  it('decodes the RS41 GPSPOS example from bazjo/RS41_Decoding to central Germany', () => {
    const p = ecefToGeodetic(3_977_323.6, 661_710.3, 4_937_067.42)
    expect(p.lat).toBeGreaterThan(50.5)
    expect(p.lat).toBeLessThan(51.5)
    expect(p.lon).toBeCloseTo(9.446, 2)
  })

  it('splits an ECEF velocity into east, north and up', () => {
    // At lat 0 / lon 0, ECEF x is up, y east, z north.
    expect(ecefToEnu(0, 0, 5, 3, 2)).toEqual({ east: 3, north: 2, up: 5 })
    // Straight up at Neuquén is along the position vector.
    const { x, y, z } = geodeticToEcef(-38.95, -68.06, 0)
    const r = Math.hypot(x, y, z)
    const v = ecefToEnu(-38.95, -68.06, (5 * x) / r, (5 * y) / r, (5 * z) / r)
    expect(v.up).toBeCloseTo(5, 1)
    expect(Math.hypot(v.east, v.north)).toBeLessThan(0.1)
  })
})
