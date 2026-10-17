export function formatMHz(hz: number, decimals = 3): string {
  return (hz / 1e6).toFixed(decimals)
}

export function formatRate(samplesPerSecond: number): string {
  return `${(samplesPerSecond / 1e6).toFixed(3)} MS/s`
}

/** Signed offset, e.g. "+12.5 kHz". */
export function formatOffset(hz: number): string {
  const sign = hz > 0 ? '+' : hz < 0 ? '−' : '±'
  const abs = Math.abs(hz)
  return abs >= 1e6 ? `${sign}${(abs / 1e6).toFixed(3)} MHz` : `${sign}${(abs / 1e3).toFixed(1)} kHz`
}

export function formatDb(db: number, unit = 'dBFS'): string {
  return `${db.toFixed(1)} ${unit}`
}

export function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

export function formatBytes(bytes: number | null): string {
  if (bytes === null) return '—'
  if (bytes < 1024 ** 2) return `${Math.round(bytes / 1024)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`
}

export function hex4(n: number): string {
  return n.toString(16).padStart(4, '0')
}
