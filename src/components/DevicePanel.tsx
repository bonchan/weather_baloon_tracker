import { hex4 } from '../format'
import { useI18n } from '../i18n'
import { sdr, type SdrState } from '../sdr/controller'
import { Panel, ProblemCallout } from './Panel'

export function DevicePanel({ state }: { state: SdrState }) {
  const { t } = useI18n()
  const { phase, device, authorizedDevice, problem } = state

  return (
    <Panel title={t('receiver.title')}>
      {phase === 'unsupported' && (
        <div className="callout callout-danger">
          <strong>{t('receiver.unsupportedTitle')}</strong>
          <p>{t('receiver.unsupportedBody')}</p>
        </div>
      )}

      {phase === 'disconnected' && (
        <div className="stack">
          <p className="muted">{t('receiver.intro')}</p>
          <button className="btn btn-primary btn-block" onClick={() => void sdr.connect()}>
            {t('receiver.connect')}
          </button>
          {authorizedDevice && (
            <p className="small muted">
              {t('receiver.willReopen', { device: authorizedDevice })} ·{' '}
              <button className="link" onClick={() => void sdr.connect({ choose: true })}>
                {t('receiver.chooseAnother')}
              </button>
            </p>
          )}
        </div>
      )}

      {phase === 'connecting' && (
        <p className="muted">
          <span className="spinner" aria-hidden /> {t('receiver.opening')}
        </p>
      )}

      {device && (phase === 'connected' || phase === 'streaming') && (
        <div className="stack">
          <dl className="kv">
            <dt>{t('receiver.device')}</dt>
            <dd>{[device.manufacturer, device.product].filter(Boolean).join(' ') || 'RTL-SDR'}</dd>
            <dt>{t('receiver.tuner')}</dt>
            <dd>{device.tuner}</dd>
            <dt>{t('receiver.serial')}</dt>
            <dd className="mono">{device.serial || '—'}</dd>
            <dt>{t('receiver.usbId')}</dt>
            <dd className="mono">
              {hex4(device.vendorId)}:{hex4(device.productId)}
            </dd>
          </dl>
          <div className="row">
            {phase === 'streaming' ? (
              <button className="btn" onClick={() => void sdr.stopStream()}>
                {t('receiver.pause')}
              </button>
            ) : (
              <button className="btn btn-primary" onClick={() => void sdr.startStream()}>
                {t('receiver.start')}
              </button>
            )}
            <button className="btn btn-ghost" onClick={() => void sdr.disconnect()}>
              {t('receiver.disconnect')}
            </button>
          </div>
        </div>
      )}

      {problem && <ProblemCallout problem={problem} onDismiss={() => sdr.dismissProblem()} />}
    </Panel>
  )
}
