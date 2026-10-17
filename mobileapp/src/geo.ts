const EARTH_RADIUS = 6_371_008.8
const rad = (d: number) => (d * Math.PI) / 180
const deg = (r: number) => (r * 180) / Math.PI

/** Great-circle distance (m) and initial bearing (degrees true) from point 1 to point 2. */
export function distanceBearing(lat1: number, lon1: number, lat2: number, lon2: number) {
  const φ1 = rad(lat1)
  const φ2 = rad(lat2)
  const Δλ = rad(lon2 - lon1)
  const a = Math.sin((φ2 - φ1) / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2
  const distance = 2 * EARTH_RADIUS * Math.asin(Math.min(1, Math.sqrt(a)))
  const y = Math.sin(Δλ) * Math.cos(φ2)
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ)
  return { distance, bearing: (deg(Math.atan2(y, x)) + 360) % 360 }
}

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW']

export function compassPoint(bearing: number): string {
  return COMPASS[Math.round(bearing / 22.5) % 16]
}

export function formatDistance(m: number): string {
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(m < 10_000 ? 2 : 1)} km`
}
