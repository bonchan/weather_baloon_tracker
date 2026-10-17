import { useEffect, useState } from 'react'
import { formatDb, formatDuration, formatMHz, formatRate } from '../format'
import { useI18n } from '../i18n'
import type { SdrState } from '../sdr/controller'
import { Panel } from './Panel'

/** Below this share of the requested rate, USB is losing samples. */
const RATE_OK = 0.98
/** Clipping above this distorts the signal; time to lower the gain. */
const CLIP_WARN = 0.001

function useNow(active: boolean) {
  const [now, setNow] = useState(() => performance.now())
  useEffect(() => {
    if (!active) return
    const id = setInterval(() => setNow(performance.now()), 1000)
    return () => clearInterval(id)
  }, [active])
  return now
}

export function StatsPanel({ state }: { state: SdrState }) {
  const { t } = useI18n()
  const { stats, signal, settings, phase } = state
  const now = useNow(phase === 'streaming')

  if (phase !== 'streaming' || !stats) {
    return (
      <Panel title={t('signal.title')}>
        <p className="small muted">{t('signal.idle')}</p>
      </Panel>
    )
  }

  const ratio = stats.measuredRate / settings.sampleRate
  // The first half second has too few blocks to measure.
  const warming = now - stats.startedAt < 1500 || stats.measuredRate === 0
  const rateClass = warming ? '' : ratio >= RATE_OK ? 'ok' : 'warn'

  return (
    <Panel title={t('signal.title')}>
      <dl className="kv">
        <dt>{t('signal.usbRate')}</dt>
        <dd className={`mono ${rateClass}`}>
          {warming ? t('signal.measuring') : `${formatRate(stats.measuredRate)} (${Math.round(ratio * 100)}%)`}
        </dd>
        <dt>{t('signal.uptime')}</dt>
        <dd className="mono">{formatDuration(now - stats.startedAt)}</dd>
        <dt>{t('signal.blocks')}</dt>
        <dd className="mono">
          {stats.blocks.toLocaleString()}
          {stats.droppedBlocks > 0 && <span className="warn"> · {t('signal.skipped', { count: stats.droppedBlocks })}</span>}
        </dd>
        {signal && (
          <>
            <dt>{t('signal.noiseFloor')}</dt>
            <dd className="mono">{formatDb(signal.noiseFloorDb)}</dd>
            <dt>{t('signal.strongest')}</dt>
            <dd className="mono">
              {formatMHz(signal.peakFrequency)} MHz · {formatDb(signal.peakDb - signal.noiseFloorDb, 'dB')} {t('signal.snr')}
            </dd>
            <dt>{t('signal.clipping')}</dt>
            <dd className={`mono ${signal.clipFraction > CLIP_WARN ? 'warn' : 'ok'}`}>
              {(signal.clipFraction * 100).toFixed(3)}%
            </dd>
          </>
        )}
      </dl>
      {!warming && ratio < RATE_OK && (
        <p className="small warn">
          {t('signal.losing')}
        </p>
      )}
    </Panel>
  )
}
