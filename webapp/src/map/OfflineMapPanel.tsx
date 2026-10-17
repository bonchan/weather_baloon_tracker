import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { formatBytes } from '../format'
import { useI18n } from '../i18n'
import { useLaunchSite } from '../sonde/launch'
import { clearCachedTiles, storageInfo, type StorageInfo } from './tileCache'
import { boundsAround, type Bounds } from './tileMath'
import { countDownloadTiles, downloadArea, MAX_DOWNLOAD_TILES, type DownloadProgress } from './tiles'

const LAUNCH_RADIUS_KM = 200
const ZOOM_CHOICES = [10, 11, 12, 13, 14]

function subscribeOnline(cb: () => void) {
  window.addEventListener('online', cb)
  window.addEventListener('offline', cb)
  return () => {
    window.removeEventListener('online', cb)
    window.removeEventListener('offline', cb)
  }
}

const useOnline = () => useSyncExternalStore(subscribeOnline, () => navigator.onLine)

/** Shows what's saved for offline use and downloads areas into the browser's storage. */
export function OfflineMapPanel({ view }: { view: Bounds | null }) {
  const { t } = useI18n()
  const launchSite = useLaunchSite()
  const online = useOnline()
  const [open, setOpen] = useState(false)
  const [area, setArea] = useState<'view' | 'launch'>('launch')
  const [maxZoom, setMaxZoom] = useState(12)
  const [info, setInfo] = useState<StorageInfo | null>(null)
  const [progress, setProgress] = useState<DownloadProgress | null>(null)
  const [result, setResult] = useState<DownloadProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const refresh = useCallback(() => {
    void storageInfo().then(setInfo, () => setInfo(null))
  }, [])

  useEffect(() => {
    refresh()
    const id = setInterval(refresh, 5000)
    return () => clearInterval(id)
  }, [refresh])

  useEffect(() => () => abortRef.current?.abort(), [])

  const bounds = area === 'launch' ? boundsAround(launchSite.lat, launchSite.lon, LAUNCH_RADIUS_KM) : view
  // The map and the satellite imagery both get saved.
  const estimate = bounds ? countDownloadTiles(bounds, maxZoom) : 0
  const tooBig = estimate > MAX_DOWNLOAD_TILES

  const start = async () => {
    if (!bounds) return
    const controller = new AbortController()
    abortRef.current = controller
    setResult(null)
    setError(null)
    let lastUpdate = 0
    try {
      const final = await downloadArea(
        bounds,
        maxZoom,
        (p) => {
          const now = performance.now()
          if (now - lastUpdate > 150 || p.done === p.total) {
            lastUpdate = now
            setProgress(p)
          }
        },
        controller.signal,
      )
      if (!controller.signal.aborted) setResult(final)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      abortRef.current = null
      setProgress(null)
      refresh()
    }
  }

  const clear = async () => {
    if (!window.confirm(t('offline.confirmClear'))) return
    await clearCachedTiles()
    setResult(null)
    refresh()
  }

  return (
    <div className={`offline-panel ${open ? 'open' : ''}`}>
      <button className="offline-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className={`net-dot ${online ? 'on' : 'off'}`} aria-hidden />
        <strong>{t('offline.title')}</strong>
        <span className="small muted mono">
          {info && t('offline.saved', { tiles: info.tiles.toLocaleString(), size: formatBytes(info.usage) })}
        </span>
        <span className="chevron" aria-hidden>
          {open ? '▾' : '▸'}
        </span>
      </button>

      {open && (
        <div className="offline-body">
          <p className={`small ${online ? 'muted' : 'warn'}`}>{online ? t('offline.help') : t('offline.noInternet')}</p>

          <label className="field">
            <span className="field-label">{t('offline.area')}</span>
            <select value={area} onChange={(e) => setArea(e.target.value as 'view' | 'launch')}>
              <option value="view">{t('offline.areaView')}</option>
              <option value="launch">{t('offline.areaLaunch', { km: LAUNCH_RADIUS_KM })}</option>
            </select>
          </label>

          <label className="field">
            <span className="field-label">{t('offline.maxZoom')}</span>
            <select value={maxZoom} onChange={(e) => setMaxZoom(Number(e.target.value))}>
              {ZOOM_CHOICES.map((z) => (
                <option key={z} value={z}>
                  {z}
                </option>
              ))}
            </select>
            <span className="small muted">{t('offline.zoomHelp')}</span>
          </label>

          <span className={`small mono ${tooBig ? 'warn' : 'muted'}`}>
            {t(tooBig ? 'offline.tooBig' : 'offline.estimate', { tiles: estimate.toLocaleString() })}
          </span>

          {progress ? (
            <div className="stack-tight">
              <progress value={progress.done} max={progress.total} />
              <span className="small mono">
                {t('offline.downloading', {
                  done: progress.done.toLocaleString(),
                  total: progress.total.toLocaleString(),
                  size: formatBytes(progress.downloadedBytes),
                })}
              </span>
              <button className="btn btn-small" onClick={() => abortRef.current?.abort()}>
                {t('offline.cancel')}
              </button>
            </div>
          ) : (
            <div className="row">
              <button
                className="btn btn-small btn-primary"
                disabled={!bounds || tooBig || !online}
                onClick={() => void start()}
              >
                {t('offline.download')}
              </button>
              <button className="btn btn-small btn-ghost" onClick={() => void clear()}>
                {t('offline.clear')}
              </button>
            </div>
          )}

          {result && (
            <p className="small ok">
              {t('offline.finished')}
              {result.failed > 0 && <span className="warn"> {t('offline.failed', { count: result.failed })}</span>}
            </p>
          )}
          {error && <p className="small warn mono">{error}</p>}
        </div>
      )}
    </div>
  )
}
