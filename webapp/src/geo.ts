const EARTH_RADIUS = 6_371_008.8
const rad = (d: number) => (d * Math.PI) / 180
const deg = (r: number) => (r * 180) / Math.PI

/** Great-circle distance (m) and initial bearing (degrees true) from point 1 to point 2. */
export function distanceBearing(lat1: number, lon1: number, lat2: number, lon2: number) {
  const φ1 = rad(lat1)
  const φ2 = rad(lat2)
  const Δφ = φ2 - φ1
  const Δλ = rad(lon2 - lon1)
  const a = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2
  const distance = 2 * EARTH_RADIUS * Math.asin(Math.min(1, Math.sqrt(a)))
  const y = Math.sin(Δλ) * Math.cos(φ2)
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ)
  const bearing = (deg(Math.atan2(y, x)) + 360) % 360
  return { distance, bearing }
}

/** Elevation angle (degrees) from an observer at height h1 to a target h2 meters high, `distance` m away along the ground. */
export function elevationAngle(distance: number, h1: number, h2: number): number {
  const c = distance / EARTH_RADIUS
  const r1 = EARTH_RADIUS + h1
  const r2 = EARTH_RADIUS + h2
  return deg(Math.atan2(r2 * Math.cos(c) - r1, r2 * Math.sin(c)))
}

/** Moves a point `east`/`north` meters (small offsets). */
export function offsetMeters(lat: number, lon: number, east: number, north: number) {
  return {
    lat: lat + deg(north / EARTH_RADIUS),
    lon: lon + deg(east / (EARTH_RADIUS * Math.cos(rad(lat)))),
  }
}

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW']

export function compassPoint(bearing: number): string {
  return COMPASS[Math.round(bearing / 22.5) % 16]
}

// WGS84 ellipsoid, the frame GPS positions come in.
const WGS84_A = 6_378_137
const WGS84_F = 1 / 298.257_223_563
const WGS84_B = WGS84_A * (1 - WGS84_F)
const E2 = WGS84_F * (2 - WGS84_F)
const EP2 = E2 / (1 - E2)

/**
 * Earth-centered coordinates (m) to WGS84 latitude/longitude (degrees) and height
 * above the ellipsoid (m). Bowring's single step, sub-millimetre up to balloon heights.
 */
export function ecefToGeodetic(x: number, y: number, z: number) {
  const p = Math.hypot(x, y)
  const θ = Math.atan2(z * WGS84_A, p * WGS84_B)
  const φ = Math.atan2(z + EP2 * WGS84_B * Math.sin(θ) ** 3, p - E2 * WGS84_A * Math.cos(θ) ** 3)
  const sinφ = Math.sin(φ)
  // This form of the height stays well-conditioned at the poles, unlike p / cos φ − N.
  const alt = p * Math.cos(φ) + z * sinφ - WGS84_A * Math.sqrt(1 - E2 * sinφ * sinφ)
  return { lat: deg(φ), lon: deg(Math.atan2(y, x)), alt }
}

export function geodeticToEcef(lat: number, lon: number, alt: number) {
  const φ = rad(lat)
  const λ = rad(lon)
  const n = WGS84_A / Math.sqrt(1 - E2 * Math.sin(φ) ** 2)
  return {
    x: (n + alt) * Math.cos(φ) * Math.cos(λ),
    y: (n + alt) * Math.cos(φ) * Math.sin(λ),
    z: (n * (1 - E2) + alt) * Math.sin(φ),
  }
}

/** Rotates an ECEF velocity into local east/north/up at lat/lon (degrees). */
export function ecefToEnu(lat: number, lon: number, vx: number, vy: number, vz: number) {
  const φ = rad(lat)
  const λ = rad(lon)
  const sinφ = Math.sin(φ)
  const cosφ = Math.cos(φ)
  const sinλ = Math.sin(λ)
  const cosλ = Math.cos(λ)
  return {
    east: -sinλ * vx + cosλ * vy,
    north: -sinφ * cosλ * vx - sinφ * sinλ * vy + cosφ * vz,
    up: cosφ * cosλ * vx + cosφ * sinλ * vy + sinφ * vz,
  }
}
