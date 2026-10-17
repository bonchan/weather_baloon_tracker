import { useState, type KeyboardEvent } from 'react'
import { formatMHz, formatOffset } from '../format'
import { sdr, type SdrState } from '../sdr/controller'
import { SONDE_BAND } from './spectrumRenderer'
import { Panel } from './Panel'

const SAMPLE_RATES = [1_024_000, 1_400_000, 1_800_000, 1_920_000, 2_048_000, 2_400_000, 2_560_000, 2_880_000, 3_200_000]
/** Rates above this tend to drop samples on RTL2832U dongles. */
const STABLE_RATE_LIMIT = 2_400_000
const MIN_FREQ_MHZ = 24
const MAX_FREQ_MHZ = 1766
/** Share of the sample rate that is flat enough to search in (the edges roll off). */
const USABLE_BANDWIDTH = 0.9

/** Centers that tile the radiosonde band with the current sample rate. */
function bandHops(sampleRate: number): number[] {
  const usable = sampleRate * USABLE_BANDWIDTH
  const width = SONDE_BAND.high - SONDE_BAND.low
  const n = Math.ceil(width / usable)
  return Array.from({ length: n }, (_, i) => Math.round((SONDE_BAND.low + (width * (i + 0.5)) / n) / 1000) * 1000)
}

function FrequencyInput({ value, onCommit }: { value: number; onCommit: (hz: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null)

  const commit = (text: string) => {
    const mhz = Number(text.replace(',', '.'))
    if (Number.isFinite(mhz) && mhz >= MIN_FREQ_MHZ && mhz <= MAX_FREQ_MHZ) onCommit(Math.round(mhz * 1e6))
    setDraft(null)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      commit(e.currentTarget.value)
      e.currentTarget.blur()
    } else if (e.key === 'Escape') {
      setDraft(null)
      e.currentTarget.blur()
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault()
      const step = e.shiftKey ? 100_000 : 10_000
      const next = value + (e.key === 'ArrowUp' ? step : -step)
      onCommit(next)
      setDraft(formatMHz(next, 4))
    }
  }

  return (
    <div className="freq-input">
      <input
        className="mono"
        inputMode="decimal"
        value={draft ?? formatMHz(value, 4)}
        onFocus={(e) => {
          setDraft(formatMHz(value, 4))
          e.currentTarget.select()
        }}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={(e) => draft !== null && commit(e.currentTarget.value)}
        onKeyDown={onKeyDown}
        aria-label="Center frequency in MHz"
      />
      <span className="unit">MHz</span>
    </div>
  )
}

export function TuningPanel({ state }: { state: SdrState }) {
  const { settings, marker } = state
  const [manualGain, setManualGain] = useState(settings.gain ?? 38)
  const disabled = state.phase === 'unsupported'

  const markerOffset = marker === null ? null : marker - settings.centerFrequency
  const markerInView = markerOffset !== null && Math.abs(markerOffset) <= settings.sampleRate / 2

  return (
    <Panel title="Tuning">
      <div className="stack">
        <label className="field">
          <span className="field-label">Center frequency</span>
          <FrequencyInput value={settings.centerFrequency} onCommit={(hz) => sdr.updateSettings({ centerFrequency: hz })} />
          <span className="small muted">↑/↓ steps 10 kHz, Shift for 100 kHz</span>
        </label>

        <div className="field">
          <span className="field-label">Sonde band hops</span>
          <div className="chips">
            {bandHops(settings.sampleRate).map((hz) => (
              <button
                key={hz}
                className={`chip mono ${hz === settings.centerFrequency ? 'chip-active' : ''}`}
                onClick={() => sdr.updateSettings({ centerFrequency: hz })}
              >
                {formatMHz(hz)}
              </button>
            ))}
          </div>
        </div>

        <label className="field">
          <span className="field-label">Sample rate</span>
          <select
            value={settings.sampleRate}
            disabled={disabled}
            onChange={(e) => sdr.updateSettings({ sampleRate: Number(e.target.value) })}
          >
            {SAMPLE_RATES.map((r) => (
              <option key={r} value={r}>
                {(r / 1e6).toFixed(3)} MS/s{r > STABLE_RATE_LIMIT ? ' (may drop samples)' : ''}
              </option>
            ))}
          </select>
        </label>

        <div className="field">
          <div className="field-row">
            <span className="field-label">Gain</span>
            <label className="toggle">
              <input
                type="checkbox"
                checked={settings.gain === null}
                onChange={(e) => sdr.updateSettings({ gain: e.target.checked ? null : manualGain })}
              />
              Auto (AGC)
            </label>
          </div>
          <div className="slider-row">
            <input
              type="range"
              min={0}
              max={50}
              step={0.5}
              value={settings.gain ?? manualGain}
              disabled={settings.gain === null}
              onChange={(e) => {
                const g = Number(e.target.value)
                setManualGain(g)
                sdr.updateSettings({ gain: g })
              }}
              aria-label="Manual gain in dB"
            />
            <span className="mono value">{settings.gain === null ? 'auto' : `${settings.gain.toFixed(1)} dB`}</span>
          </div>
          <span className="small muted">If ADC clipping shows up under Signal, lower the gain.</span>
        </div>

        <label className="field">
          <span className="field-label">Frequency correction</span>
          <div className="freq-input">
            <input
              className="mono"
              type="number"
              step={0.5}
              min={-200}
              max={200}
              value={settings.ppm}
              onChange={(e) => {
                const ppm = Number(e.target.value)
                if (Number.isFinite(ppm) && Math.abs(ppm) <= 200) sdr.updateSettings({ ppm })
              }}
            />
            <span className="unit">ppm</span>
          </div>
        </label>

        <label className="toggle">
          <input
            type="checkbox"
            checked={settings.biasTee}
            onChange={(e) => sdr.updateSettings({ biasTee: e.target.checked })}
          />
          <span>
            Bias tee <span className="small muted">— 4.5 V up the coax for an LNA (RTL-SDR Blog V3/V4)</span>
          </span>
        </label>

        <div className="field">
          <span className="field-label">Marker</span>
          {marker === null ? (
            <span className="small muted">Click the spectrum or waterfall to mark a signal.</span>
          ) : (
            <>
              <div className="marker-readout">
                <span className="mono">{formatMHz(marker)} MHz</span>
                <span className="small muted">
                  {markerInView ? `${formatOffset(markerOffset!)} from center` : 'outside the current view'}
                </span>
              </div>
              <div className="row">
                <button
                  className="btn btn-small"
                  title="Retunes so the marker sits just right of center, clear of the DC spike"
                  onClick={() =>
                    sdr.updateSettings({
                      centerFrequency: Math.round((marker - settings.sampleRate / 8) / 1000) * 1000,
                    })
                  }
                >
                  Center on marker
                </button>
                <button className="btn btn-small btn-ghost" onClick={() => sdr.setMarker(null)}>
                  Clear
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </Panel>
  )
}
