import type { ReactNode } from 'react'
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
  return (
    <div className="callout callout-danger" role="alert">
      <div className="callout-title">
        <strong>{problem.title}</strong>
        {onDismiss && (
          <button className="icon-btn" onClick={onDismiss} aria-label="Dismiss">
            ×
          </button>
        )}
      </div>
      <p className="mono small">{problem.detail}</p>
      {problem.hint && <p>{problem.hint}</p>}
    </div>
  )
}
