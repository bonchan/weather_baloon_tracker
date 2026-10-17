import { useEffect, useRef, useState, type MouseEvent, type PointerEvent } from 'react'
import { formatDb, formatMHz, formatOffset } from '../format'
import { useI18n, type MessageKey } from '../i18n'
import { FFT_SIZES, sdr, type SdrState } from '../sdr/controller'
import { SpectrumRenderer, type Levels } from './spectrumRenderer'

const LEVELS_KEY = 'sondetracker.levels.v1'

function loadLevels(): Levels {
  try {
    const saved = JSON.parse(localStorage.getItem(LEVELS_KEY) ?? 'null') as Levels | null
    if (saved && typeof saved.min === 'number' && typeof saved.max === 'number') return saved
  } catch {
    // fall through to defaults
  }
  return { auto: true, min: -100, max: -40 }
}

function saveLevels(levels: Levels) {
  try {
    localStorage.setItem(LEVELS_KEY, JSON.stringify(levels))
  } catch {
    // not fatal
  }
}

const EMPTY_MESSAGES: Partial<Record<SdrState['phase'], MessageKey>> = {
  unsupported: 'spectrum.empty.unsupported',
  disconnected: 'spectrum.empty.disconnected',
  connecting: 'spectrum.empty.connecting',
}

export function SpectrumView({ state }: { state: SdrState }) {
  const { t } = useI18n()
  const spectrumRef = useRef<HTMLCanvasElement>(null)
  const waterfallRef = useRef<HTMLCanvasElement>(null)
  const rendererRef = useRef<SpectrumRenderer | null>(null)
  const [levels, setLevels] = useState<Levels>(loadLevels)
  const [range, setRange] = useState<{ min: number; max: number } | null>(null)
  const [hoverFraction, setHoverFraction] = useState<number | null>(null)
  const [hoverLevel, setHoverLevel] = useState<number | null>(null)
  const [receivedData, setReceivedData] = useState(false)

  const { settings, marker, phase, fftSize } = state
  const span = settings.sampleRate
  const start = settings.centerFrequency - span / 2

  useEffect(() => {
    const renderer = new SpectrumRenderer(spectrumRef.current!, waterfallRef.current!)
    rendererRef.current = renderer
    const observer = new ResizeObserver(() => renderer.resize())
    observer.observe(spectrumRef.current!)
    observer.observe(waterfallRef.current!)
    const unsubscribe = sdr.onSpectrum((frame) => {
      renderer.push(frame)
      setReceivedData(true)
    })
    return () => {
      unsubscribe()
      observer.disconnect()
      renderer.destroy()
      rendererRef.current = null
    }
  }, [])

  useEffect(() => {
    rendererRef.current?.setLevels(levels)
    saveLevels(levels)
  }, [levels])

  // Data from a previous session is stale once the dongle is gone.
  const live = phase === 'connected' || phase === 'streaming'
  const hasData = receivedData && live

  useEffect(() => {
    if (!live) rendererRef.current?.clear()
  }, [live])

  // Auto levels and the hover readout follow the live data, a few times a second.
  useEffect(() => {
    const id = setInterval(() => {
      const r = rendererRef.current
      if (!r) return
      const next = r.effectiveRange()
      setRange((prev) => (prev && prev.min === next.min && prev.max === next.max ? prev : next))
      if (hoverFraction !== null) setHoverLevel(r.levelAt(hoverFraction))
    }, 250)
    return () => clearInterval(id)
  }, [hoverFraction])

  const fractionOf = (e: MouseEvent<HTMLElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    return Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
  }

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const f = fractionOf(e)
    setHoverFraction(f)
    setHoverLevel(rendererRef.current?.levelAt(f) ?? null)
  }

  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    if (!hasData) return
    const hz = start + fractionOf(e) * span
    sdr.setMarker(Math.round(hz / 1000) * 1000)
  }

  const hoverHz = hoverFraction === null ? null : start + hoverFraction * span
  const markerFraction = marker === null ? null : (marker - start) / span
  const emptyKey = hasData ? undefined : EMPTY_MESSAGES[phase]
  const shownRange = levels.auto && range ? range : levels

  return (
    <div className="spectrum">
      <div className="spectrum-toolbar">
        <div className="spectrum-title">
          <h2>{t('spectrum.title')}</h2>
          <span className="mono small muted">
            {formatMHz(start)} – {formatMHz(start + span)} MHz · RBW {Math.round(span / fftSize)} Hz
          </span>
          {phase === 'connected' && hasData && <span className="badge">{t('spectrum.paused')}</span>}
        </div>

        <div className="spectrum-readout mono small" aria-live="off">
          {hoverHz !== null && hasData ? (
            <>
              <span>{formatMHz(hoverHz, 4)} MHz</span>
              {hoverLevel !== null && <span>{formatDb(hoverLevel)}</span>}
              <span className="muted">{formatOffset(hoverHz - settings.centerFrequency)}</span>
            </>
          ) : (
            <span className="muted">{t('spectrum.hoverHint')}</span>
          )}
        </div>

        <div className="spectrum-controls">
          <label className="inline-field">
            {t('spectrum.fft')}
            <select value={fftSize} onChange={(e) => sdr.setFftSize(Number(e.target.value))}>
              {FFT_SIZES.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <label className="toggle">
            <input type="checkbox" checked={levels.auto} onChange={(e) => setLevels({ ...levels, auto: e.target.checked })} />
            {t('spectrum.autoLevels')}
          </label>
          <label className="inline-field">
            {t('spectrum.min')}
            <input
              type="number"
              className="mono narrow"
              step={5}
              value={shownRange.min}
              disabled={levels.auto}
              onChange={(e) => setLevels({ ...levels, min: Math.min(Number(e.target.value), levels.max - 5) })}
            />
          </label>
          <label className="inline-field">
            {t('spectrum.max')}
            <input
              type="number"
              className="mono narrow"
              step={5}
              value={shownRange.max}
              disabled={levels.auto}
              onChange={(e) => setLevels({ ...levels, max: Math.max(Number(e.target.value), levels.min + 5) })}
            />
          </label>
        </div>
      </div>

      <div
        className="spectrum-stack"
        onPointerMove={onPointerMove}
        onPointerLeave={() => setHoverFraction(null)}
        onClick={onClick}
      >
        <canvas ref={spectrumRef} className="spectrum-canvas" />
        <canvas ref={waterfallRef} className="waterfall-canvas" />

        {hasData && hoverFraction !== null && (
          <div className="cursor-line" style={{ left: `${hoverFraction * 100}%` }} />
        )}
        {hasData && markerFraction !== null && markerFraction >= 0 && markerFraction <= 1 && (
          <div className="marker-line" style={{ left: `${markerFraction * 100}%` }}>
            <span className="marker-tag mono">{formatMHz(marker!)}</span>
          </div>
        )}
        {emptyKey && <div className="spectrum-empty">{t(emptyKey)}</div>}
      </div>
    </div>
  )
}
