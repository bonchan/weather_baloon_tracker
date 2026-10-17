import { useEffect, useState, type Ref } from 'react'
import { companions, useCompanions } from '../companion/store'
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

/** What the map keeps in view; 'both' fits me and the sonde. */
export type Follow = 'sonde' | 'me' | 'both' | null

type Props = {
  placingStation: boolean
  onPlaceStation: () => void
  follow: Follow
  onFollow: (follow: Follow) => void
  cardRef?: Ref<HTMLDivElement>
}

/** Floating card over the map: the active sonde, the station, and map actions. */
export function SondeInfo({ placingStation, onPlaceStation, follow, onFollow, cardRef }: Props) {
  const { t } = useI18n()
  const { tracks, active, station } = useSondes()
  const { devices, me, stationFollowsGps } = useCompanions()
  const now = useClock(1000)
  const [demo, setDemo] = useState(isDemoRunning)
  const [locationError, setLocationError] = useState<string | null>(null)

  const track = active ? tracks[active] : undefined
  const last = track?.fixes[track.fixes.length - 1]
  const maxAlt = track ? Math.max(...track.fixes.map((f) => f.alt)) : 0
  const link = station && last ? distanceBearing(station.lat, station.lon, last.lat, last.lon) : null
  const gps = me !== null || devices.some((d) => d.link === 'open')
  const fromGps = stationFollowsGps && me !== null && !me.lost

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
      (p) => {
        companions.setStationFollowsGps(false)
        sondes.setStation({ lat: p.coords.latitude, lon: p.coords.longitude, alt: p.coords.altitude ?? 0 })
      },
      (e) => setLocationError(e.message),
      { enableHighAccuracy: true, timeout: 15_000 },
    )
  }

  return (
    <div className="map-card" ref={cardRef}>
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
            {last.temperature !== undefined && (
              <>
                <dt>{t('map.temperature')}</dt>
                <dd className="mono">{fmt(last.temperature, 1)} °C</dd>
              </>
            )}
            {last.humidity !== undefined && (
              <>
                <dt>{t('map.humidity')}</dt>
                <dd className="mono">{fmt(last.humidity)} %</dd>
              </>
            )}
            {last.pressure !== undefined && (
              <>
                <dt>{t('map.pressure')}</dt>
                <dd className="mono">{fmt(last.pressure, 1)} hPa</dd>
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
        <div className="map-card-head">
          <span className="field-label">{t('map.station')}</span>
          {fromGps && <span className="badge badge-neutral">GPS</span>}
        </div>
        <span className="mono small">
          {station ? `${fmt(station.lat, 5)}, ${fmt(station.lon, 5)}` : '—'}
        </span>
        {gps && (
          <label className="toggle">
            <input
              type="checkbox"
              checked={stationFollowsGps}
              onChange={(e) => companions.setStationFollowsGps(e.target.checked)}
            />
            {t('map.stationFollowsGps')}
          </label>
        )}
        {gps && stationFollowsGps && !fromGps && <span className="small muted">{t('map.stationGpsWaiting')}</span>}
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
          <input type="checkbox" checked={follow === 'sonde'} onChange={(e) => onFollow(e.target.checked ? 'sonde' : null)} />
          {t('map.follow')}
        </label>
        {me && (
          <>
            <label className="toggle">
              <input type="checkbox" checked={follow === 'me'} onChange={(e) => onFollow(e.target.checked ? 'me' : null)} />
              {t('map.followMe')}
            </label>
            <label className="toggle">
              <input
                type="checkbox"
                checked={follow === 'both'}
                onChange={(e) => onFollow(e.target.checked ? 'both' : null)}
              />
              {t('map.followBoth')}
            </label>
          </>
        )}
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
