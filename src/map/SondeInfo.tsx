import { useEffect, useState } from 'react'
import { compassPoint, distanceBearing, elevationAngle } from '../geo'
import { useI18n } from '../i18n'
import { isDemoRunning, startDemo, stopDemo } from '../sonde/demo'
import { sondes, useSondes } from '../sonde/store'

function useClock(ms: number) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(id)
  }, [ms])
  return now
}

const fmt = (n: number, digits = 0) => n.toFixed(digits)

type Props = {
  placingStation: boolean
  onPlaceStation: () => void
  follow: boolean
  onFollow: (follow: boolean) => void
}

/** Floating card over the map: the active sonde, the station, and map actions. */
export function SondeInfo({ placingStation, onPlaceStation, follow, onFollow }: Props) {
  const { t } = useI18n()
  const { tracks, active, station } = useSondes()
  const now = useClock(1000)
  const [demo, setDemo] = useState(isDemoRunning)
  const [locationError, setLocationError] = useState<string | null>(null)

  const track = active ? tracks[active] : undefined
  const last = track?.fixes[track.fixes.length - 1]
  const maxAlt = track ? Math.max(...track.fixes.map((f) => f.alt)) : 0
  const link = station && last ? distanceBearing(station.lat, station.lon, last.lat, last.lon) : null

  const toggleDemo = () => {
    if (demo) {
      stopDemo()
      setDemo(false)
    } else {
      startDemo(() => setDemo(false))
      setDemo(true)
    }
  }

  const useMyLocation = () => {
    setLocationError(null)
    navigator.geolocation.getCurrentPosition(
      (p) => sondes.setStation({ lat: p.coords.latitude, lon: p.coords.longitude, alt: p.coords.altitude ?? 0 }),
      (e) => setLocationError(e.message),
      { enableHighAccuracy: true, timeout: 15_000 },
    )
  }

  return (
    <div className="map-card">
      {track && last ? (
        <>
          <div className="map-card-head">
            <span className="mono sonde-serial">{track.serial}</span>
            {track.demo && <span className="badge">{t('map.demoBadge')}</span>}
          </div>
          <dl className="kv small">
            <dt>{t('map.position')}</dt>
            <dd className="mono">
              {fmt(last.lat, 5)}, {fmt(last.lon, 5)}
            </dd>
            <dt>{t('map.altitude')}</dt>
            <dd className="mono">{fmt(last.alt)} m</dd>
            {last.climb !== undefined && (
              <>
                <dt>{t('map.climb')}</dt>
                <dd className="mono">{fmt(last.climb, 1)} m/s</dd>
              </>
            )}
            {last.speed !== undefined && (
              <>
                <dt>{t('map.speed')}</dt>
                <dd className="mono">{fmt(last.speed * 3.6)} km/h</dd>
              </>
            )}
            <dt>{t('map.burst')}</dt>
            <dd className="mono">{fmt(maxAlt)} m</dd>
            {link && station && (
              <>
                <dt>{t('map.distance')}</dt>
                <dd className="mono">{fmt(link.distance / 1000, 1)} km</dd>
                <dt>{t('map.bearing')}</dt>
                <dd className="mono">
                  {fmt(link.bearing)}° {compassPoint(link.bearing)}
                </dd>
                <dt>{t('map.elevation')}</dt>
                <dd className="mono">{fmt(elevationAngle(link.distance, station.alt, last.alt), 1)}°</dd>
              </>
            )}
            <dt>{t('map.lastHeard')}</dt>
            <dd className="mono">{t('map.secondsAgo', { s: Math.max(0, Math.round((now - last.receivedAt) / 1000)) })}</dd>
            <dt>{t('map.fixes')}</dt>
            <dd className="mono">{track.fixes.length}</dd>
          </dl>
        </>
      ) : (
        <p className="small muted">{t('map.noSonde')}</p>
      )}

      <div className="map-card-section">
        <span className="field-label">{t('map.station')}</span>
        <span className="mono small">
          {station ? `${fmt(station.lat, 5)}, ${fmt(station.lon, 5)}` : '—'}
        </span>
        <div className="row">
          <button className={`btn btn-small ${placingStation ? 'btn-primary' : ''}`} onClick={onPlaceStation}>
            {placingStation ? t('map.placingStation') : t('map.placeStation')}
          </button>
          <button className="btn btn-small btn-ghost" onClick={useMyLocation}>
            {t('map.useMyLocation')}
          </button>
        </div>
        {locationError && <span className="small warn">{t('map.locationFailed', { reason: locationError })}</span>}
      </div>

      <div className="map-card-section">
        <label className="toggle">
          <input type="checkbox" checked={follow} onChange={(e) => onFollow(e.target.checked)} />
          {t('map.follow')}
        </label>
        <div className="row">
          <button className="btn btn-small" onClick={toggleDemo}>
            {demo ? t('map.stopDemo') : t('map.demo')}
          </button>
          <button className="btn btn-small btn-ghost" onClick={() => sondes.clearTracks()}>
            {t('map.clearTracks')}
          </button>
        </div>
      </div>
    </div>
  )
}
