import { useEffect, useState } from 'react'
import { companionLink } from '../companion/serial'
import { useCompanions, type CompanionDevice } from '../companion/store'
import { hex4 } from '../format'
import { useI18n } from '../i18n'
import { Panel } from './Panel'

/** Longer than this without a line and the device is probably stuck. */
const QUIET_MS = 5_000

function useClock(ms: number) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(id)
  }, [ms])
  return now
}

const FIX_CLASS = ['warn', 'muted', 'ok'] as const

function DeviceCard({ device: d, now }: { device: CompanionDevice; now: number }) {
  const { t } = useI18n()
  const usb = d.usbVendorId === undefined ? t('gps.serialPort') : `USB ${hex4(d.usbVendorId)}:${hex4(d.usbProductId ?? 0)}`
  const live = d.link === 'open'
  const ago = d.lastSeen === null ? null : Math.max(0, Math.round((now - d.lastSeen) / 1000))

  return (
    <div className="companion">
      <div className="companion-head">
        <strong title={d.name ? usb : undefined}>{d.name || usb}</strong>
        {d.kind && <span className="badge badge-neutral">{d.kind}</span>}
        {d.protocol === 'nmea' && <span className="badge badge-neutral">NMEA</span>}
        {d.link === 'lost' && (
          <button className="icon-btn" onClick={() => companionLink.drop(d.id)} aria-label={t('common.dismiss')}>
            ×
          </button>
        )}
      </div>

      {d.link === 'opening' && (
        <p className="small muted">
          <span className="spinner" aria-hidden /> {t('gps.opening')}
        </p>
      )}
      {d.link === 'closed' && <p className="small muted">{t('gps.closed')}</p>}
      {d.link === 'lost' && <p className="small warn">{t('gps.lost')}</p>}
      {d.link === 'failed' && (
        <div className="stack-tight small">
          <p className="warn">{t('gps.failed')}</p>
          {d.problem && <p className="mono muted">{d.problem}</p>}
          <p className="muted">{t('gps.busyHint')}</p>
        </div>
      )}

      {live && (
        <dl className="kv small">
          <dt>{t('gps.fix')}</dt>
          <dd className={d.fix === null ? 'muted' : FIX_CLASS[d.fix]}>
            {d.fix === null ? t('gps.fix.none') : t(`gps.fix.${d.fix}`)}
          </dd>
          {d.sats !== undefined && (
            <>
              <dt>{t('gps.satellites')}</dt>
              <dd className="mono">{d.sats}</dd>
            </>
          )}
          {d.hdop !== undefined && (
            <>
              <dt>{t('gps.hdop')}</dt>
              <dd className="mono">{d.hdop.toFixed(1)}</dd>
            </>
          )}
          <dt>{t('gps.lastSeen')}</dt>
          <dd className={`mono ${ago !== null && ago * 1000 > QUIET_MS ? 'warn' : ''}`}>
            {ago === null ? '—' : t('map.secondsAgo', { s: ago })}
          </dd>
          {d.firmware && (
            <>
              <dt>{t('gps.firmware')}</dt>
              <dd className="mono">{d.firmware}</dd>
            </>
          )}
        </dl>
      )}

      {d.logs.length > 0 && (
        <ul className="companion-log mono small">
          {d.logs.map((l, i) => (
            <li key={`${l.time}-${i}`} className={l.error ? 'warn' : 'muted'}>
              {l.text}
            </li>
          ))}
        </ul>
      )}

      {d.link !== 'lost' && (
        <div className="row">
          {live || d.link === 'opening' ? (
            <button className="btn btn-small" onClick={() => void companionLink.disconnect(d.id)}>
              {t('gps.disconnect')}
            </button>
          ) : (
            <button className="btn btn-small btn-primary" onClick={() => void companionLink.connect(d.id)}>
              {t('gps.reconnect')}
            </button>
          )}
          <button className="btn btn-small btn-ghost" title={t('gps.forgetTip')} onClick={() => void companionLink.forget(d.id)}>
            {t('gps.forget')}
          </button>
        </div>
      )}
    </div>
  )
}

/** USB GPS companions (and plain NMEA GPSes) over Web Serial. */
export function CompanionPanel() {
  const { t } = useI18n()
  const { devices, trackers } = useCompanions()
  const now = useClock(1000)
  const [problem, setProblem] = useState<string | null>(null)
  const remote = Object.values(trackers)

  if (!companionLink.supported) {
    return (
      <Panel title={t('gps.title')}>
        <p className="small muted">{t('gps.unsupported')}</p>
      </Panel>
    )
  }

  const choose = async () => {
    setProblem(null)
    try {
      await companionLink.choose()
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <Panel title={t('gps.title')}>
      <div className="stack">
        {devices.length === 0 && <p className="muted">{t('gps.intro')}</p>}
        {devices.map((d) => (
          <DeviceCard key={d.id} device={d} now={now} />
        ))}
        {remote.length > 0 && (
          <dl className="kv small">
            <dt>{t('gps.trackers')}</dt>
            <dd className="mono">
              {remote
                .map((r) => `${r.id} (${t('map.secondsAgo', { s: Math.max(0, Math.round((now - r.receivedAt) / 1000)) })})`)
                .join(', ')}
            </dd>
          </dl>
        )}
        <div>
          <button className={`btn ${devices.length ? 'btn-small btn-ghost' : 'btn-primary btn-block'}`} onClick={() => void choose()}>
            {devices.length ? t('gps.addAnother') : t('gps.connect')}
          </button>
        </div>
        {problem && <p className="small warn">{t('gps.pickFailed', { reason: problem })}</p>}
      </div>
    </Panel>
  )
}
