import type { ReactNode } from 'react'
import { useI18n } from '../i18n'
import type { SdrProblem } from '../sdr/errors'

export function Panel({ title, actions, children }: { title: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="panel">
      <header className="panel-head">
        <h2>{title}</h2>
        {actions}
      </header>
      <div className="panel-body">{children}</div>
    </section>
  )
}

export function ProblemCallout({ problem, onDismiss }: { problem: SdrProblem; onDismiss?: () => void }) {
  const { t } = useI18n()
  return (
    <div className="callout callout-danger" role="alert">
      <div className="callout-title">
        <strong>{t(problem.title)}</strong>
        {onDismiss && (
          <button className="icon-btn" onClick={onDismiss} aria-label={t('common.dismiss')}>
            ×
          </button>
        )}
      </div>
      {problem.detail && <p className="mono small">{problem.detail}</p>}
      {problem.hints.map((hint) => (
        <p key={hint}>{t(hint)}</p>
      ))}
    </div>
  )
}
