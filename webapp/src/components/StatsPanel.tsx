import { useEffect, useState } from 'react'
import type { DecoderStatus } from '../dsp/messages'
import { formatDb, formatDuration, formatMHz, formatOffset, formatRate } from '../format'
import { useI18n } from '../i18n'
import type { SdrState } from '../sdr/controller'
import { CALIBRATION_SUBFRAMES } from '../sonde/rs41/ptu'
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

const DECODER_CLASS: Record<DecoderStatus['state'], string> = {
  'no-marker': 'muted',
  'out-of-band': 'warn',
  searching: 'muted',
  sync: 'warn',
  locked: 'ok',
}

function DecoderRows({ status }: { status: DecoderStatus }) {
  const { t } = useI18n()
  const running = status.state !== 'no-marker' && status.state !== 'out-of-band'
  return (
    <>
      <dl className="kv">
        <dt>{t('decoder.title')}</dt>
        <dd className={`mono ${DECODER_CLASS[status.state]}`}>{t(`decoder.state.${status.state}`)}</dd>
        {running && (
          <>
            <dt>{t('decoder.frames')}</dt>
            <dd className="mono">{t('decoder.framesValue', { good: status.goodFrames, bad: status.badFrames })}</dd>
          </>
        )}
        {running && status.serial !== null && (
          <>
            <dt>{t('decoder.sonde')}</dt>
            <dd className="mono">
              {status.serial} · #{status.frame}
            </dd>
          </>
        )}
        {running && status.offset !== null && (
          <>
            <dt>{t('decoder.offset')}</dt>
            <dd className="mono">{formatOffset(status.offset)}</dd>
          </>
        )}
        {running && status.calibration !== null && (
          <>
            <dt>{t('decoder.calibration')}</dt>
            <dd className="mono">
              {status.calibration < CALIBRATION_SUBFRAMES
                ? `${status.calibration}/${CALIBRATION_SUBFRAMES}`
                : t('decoder.calibrationDone')}
            </dd>
          </>
        )}
      </dl>
      {status.state === 'no-marker' && <p className="small muted">{t('decoder.noMarkerHelp')}</p>}
      {status.state === 'out-of-band' && <p className="small warn">{t('decoder.outOfBandHelp')}</p>}
      {running && status.serial !== null && !status.gpsFix && <p className="small muted">{t('decoder.noGps')}</p>}
      {running && status.calibration !== null && status.calibration < CALIBRATION_SUBFRAMES && (
        <p className="small muted">{t('decoder.calibrationHelp')}</p>
      )}
    </>
  )
}

export function StatsPanel({ state }: { state: SdrState }) {
  const { t } = useI18n()
  const { stats, signal, settings, phase, decoder } = state
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
      {decoder && <DecoderRows status={decoder} />}
    </Panel>
  )
}
