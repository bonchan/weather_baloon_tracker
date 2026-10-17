/** Slippy-map tile arithmetic for downloading areas. */
import { offsetMeters } from '../geo'

export type Bounds = { west: number; south: number; east: number; north: number }

const MAX_LAT = 85.0511

function tileRange(b: Bounds, z: number) {
  const n = 2 ** z
  const clampLat = (lat: number) => Math.max(-MAX_LAT, Math.min(MAX_LAT, lat))
  const x = (lon: number) => Math.floor(((lon + 180) / 360) * n)
  const y = (lat: number) => {
    const r = (clampLat(lat) * Math.PI) / 180
    return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n)
  }
  const clamp = (v: number) => Math.max(0, Math.min(n - 1, v))
  return { x0: clamp(x(b.west)), x1: clamp(x(b.east)), y0: clamp(y(b.north)), y1: clamp(y(b.south)) }
}

export function countTiles(b: Bounds, maxZoom: number): number {
  let total = 0
  for (let z = 0; z <= maxZoom; z++) {
    const r = tileRange(b, z)
    total += (r.x1 - r.x0 + 1) * (r.y1 - r.y0 + 1)
  }
  return total
}

export function* tilesIn(b: Bounds, maxZoom: number) {
  for (let z = 0; z <= maxZoom; z++) {
    const r = tileRange(b, z)
    for (let x = r.x0; x <= r.x1; x++) for (let y = r.y0; y <= r.y1; y++) yield { z, x, y }
  }
}

export function boundsAround(lat: number, lon: number, radiusKm: number): Bounds {
  const r = radiusKm * 1000
  const sw = offsetMeters(lat, lon, -r, -r)
  const ne = offsetMeters(lat, lon, r, r)
  return { west: sw.lon, south: sw.lat, east: ne.lon, north: ne.lat }
}
