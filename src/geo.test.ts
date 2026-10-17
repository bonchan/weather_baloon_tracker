import { describe, expect, it } from 'vitest'
import { distanceBearing, elevationAngle, offsetMeters } from './geo'

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
