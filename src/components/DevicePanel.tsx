import { hex4 } from '../format'
import { sdr, type SdrState } from '../sdr/controller'
import { Panel, ProblemCallout } from './Panel'

export function DevicePanel({ state }: { state: SdrState }) {
  const { phase, device, authorizedDevice, problem } = state

  return (
    <Panel title="Receiver">
      {phase === 'unsupported' && (
        <div className="callout callout-danger">
          <strong>WebUSB isn't available in this browser.</strong>
          <p>
            Open this page in Chrome or Edge at <span className="mono">http://localhost</span>. WebUSB only works on
            localhost or HTTPS, so a LAN address like 192.168.x.x won't do.
          </p>
        </div>
      )}

      {phase === 'disconnected' && (
        <div className="stack">
          <p className="muted">Plug in the RTL-SDR, click Connect and pick it in the browser's list.</p>
          <button className="btn btn-primary btn-block" onClick={() => void sdr.connect()}>
            Connect RTL-SDR
          </button>
          {authorizedDevice && (
            <p className="small muted">
              Will reopen <span className="mono">{authorizedDevice}</span> ·{' '}
              <button className="link" onClick={() => void sdr.connect({ choose: true })}>
                choose another
              </button>
            </p>
          )}
        </div>
      )}

      {phase === 'connecting' && (
        <p className="muted">
          <span className="spinner" aria-hidden /> Opening the dongle…
        </p>
      )}

      {device && (phase === 'connected' || phase === 'streaming') && (
        <div className="stack">
          <dl className="kv">
            <dt>Device</dt>
            <dd>{[device.manufacturer, device.product].filter(Boolean).join(' ') || 'RTL-SDR'}</dd>
            <dt>Tuner</dt>
            <dd>{device.tuner}</dd>
            <dt>Serial</dt>
            <dd className="mono">{device.serial || '—'}</dd>
            <dt>USB ID</dt>
            <dd className="mono">
              {hex4(device.vendorId)}:{hex4(device.productId)}
            </dd>
          </dl>
          <div className="row">
            {phase === 'streaming' ? (
              <button className="btn" onClick={() => void sdr.stopStream()}>
                Pause stream
              </button>
            ) : (
              <button className="btn btn-primary" onClick={() => void sdr.startStream()}>
                Start stream
              </button>
            )}
            <button className="btn btn-ghost" onClick={() => void sdr.disconnect()}>
              Disconnect
            </button>
          </div>
        </div>
      )}

      {problem && <ProblemCallout problem={problem} onDismiss={() => sdr.dismissProblem()} />}
    </Panel>
  )
}
