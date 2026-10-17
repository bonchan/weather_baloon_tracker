import { lazy, Suspense, useState } from 'react'
import { startTeamRelay } from './companion/team'
import { CompanionPanel } from './components/CompanionPanel'
import { DevicePanel } from './components/DevicePanel'
import { SpectrumView } from './components/SpectrumView'
import { StatsPanel } from './components/StatsPanel'
import { TeamPanel } from './components/TeamPanel'
import { TuningPanel } from './components/TuningPanel'
import { formatMHz } from './format'
import { LANGUAGES, setLang, useI18n, type Lang } from './i18n'
import { useSdrState } from './sdr/useSdr'

// MapLibre is large; load it the first time the map tab opens.
const MapView = lazy(() => import('./map/MapView'))

startTeamRelay()

type Tab = 'spectrum' | 'map'

export default function App() {
  const state = useSdrState()
  const { t, lang } = useI18n()
  const [tab, setTab] = useState<Tab>('spectrum')
  const [mapOpened, setMapOpened] = useState(false)

  const openTab = (next: Tab) => {
    setTab(next)
    if (next === 'map') setMapOpened(true)
  }

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

        <nav className="tabs" role="tablist">
          {(['spectrum', 'map'] as const).map((id) => (
            <button key={id} role="tab" aria-selected={tab === id} className="tab" onClick={() => openTab(id)}>
              {t(id === 'spectrum' ? 'tab.spectrum' : 'tab.map')}
            </button>
          ))}
        </nav>

        <div className="topbar-right">
          <div className={`status status-${state.phase}`}>
            <span className="status-dot" aria-hidden />
            {t(`phase.${state.phase}`)}
            {state.phase === 'streaming' && (
              <span className="mono muted">· {formatMHz(state.settings.centerFrequency)} MHz</span>
            )}
          </div>
          <select
            className="lang-select"
            value={lang}
            onChange={(e) => setLang(e.target.value as Lang)}
            aria-label={t('lang.label')}
          >
            {LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>
                {l.label}
              </option>
            ))}
          </select>
        </div>
      </header>

      <aside className="sidebar">
        <DevicePanel state={state} />
        <CompanionPanel />
        <TeamPanel />
        <TuningPanel state={state} />
        <StatsPanel state={state} />
      </aside>

      <main className="main">
        {/* Both views stay mounted so the waterfall and map keep running in the background. */}
        <div className="view" hidden={tab !== 'spectrum'}>
          <SpectrumView state={state} />
        </div>
        {mapOpened && (
          <div className="view" hidden={tab !== 'map'}>
            <Suspense fallback={<div className="spectrum-empty">{t('map.loading')}</div>}>
              <MapView visible={tab === 'map'} />
            </Suspense>
          </div>
        )}
      </main>
    </div>
  )
}
