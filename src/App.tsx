import { DevicePanel } from './components/DevicePanel'
import { SpectrumView } from './components/SpectrumView'
import { StatsPanel } from './components/StatsPanel'
import { TuningPanel } from './components/TuningPanel'
import { formatMHz } from './format'
import type { Phase } from './sdr/controller'
import { useSdrState } from './sdr/useSdr'

const PHASE_LABEL: Record<Phase, string> = {
  unsupported: 'No WebUSB',
  disconnected: 'Disconnected',
  connecting: 'Connecting',
  connected: 'Connected',
  streaming: 'Receiving',
}

export default function App() {
  const state = useSdrState()

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden>
            <ellipse cx="12" cy="9" rx="6.5" ry="7.5" fill="currentColor" opacity="0.9" />
            <path d="M12 16.5v3.5M10 20h4v2.5h-4z" stroke="currentColor" strokeWidth="1.4" fill="none" />
          </svg>
          <h1>Sonde Tracker</h1>
        </div>
        <div className={`status status-${state.phase}`}>
          <span className="status-dot" aria-hidden />
          {PHASE_LABEL[state.phase]}
          {state.phase === 'streaming' && (
            <span className="mono muted">· {formatMHz(state.settings.centerFrequency)} MHz</span>
          )}
        </div>
      </header>

      <aside className="sidebar">
        <DevicePanel state={state} />
        <TuningPanel state={state} />
        <StatsPanel state={state} />
      </aside>

      <main className="main">
        <SpectrumView state={state} />
      </main>
    </div>
  )
}
