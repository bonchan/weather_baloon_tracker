import { describe, expect, it } from 'vitest'
import { boundsAround, countTiles, tilesIn } from './tileMath'

const WORLD = { west: -180, south: -85, east: 179.999, north: 85 }

describe('tile math', () => {
  it('counts the whole world as 1 + 4 + 16 tiles up to zoom 2', () => {
    expect(countTiles(WORLD, 2)).toBe(21)
  })

  it('enumerates exactly what it counts', () => {
    const area = boundsAround(-38.95, -68.06, 100)
    expect([...tilesIn(area, 9)]).toHaveLength(countTiles(area, 9))
  })

  it('keeps a 200 km radius at zoom 12 to a few thousand tiles', () => {
    const n = countTiles(boundsAround(-38.95, -68.06, 200), 12)
    expect(n).toBeGreaterThan(2_000)
    expect(n).toBeLessThan(8_000)
  })

  it('puts Neuquén in the south-western quadrant at zoom 1', () => {
    const [, z1] = [...tilesIn(boundsAround(-38.95, -68.06, 1), 1)]
    expect(z1).toEqual({ z: 1, x: 0, y: 1 })
  })
})
