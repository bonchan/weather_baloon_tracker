import { useEffect, useState } from 'react'
import { ONLINE_MS, statusColor } from '../companion/colors'
import { NO_NET } from '../companion/protocol'
import { useCompanions } from '../companion/store'
import { acceptJoin, baseStation, kickMember, newNetwork, rejectJoin } from '../companion/team'
import { distanceBearing } from '../geo'
import { useI18n } from '../i18n'
import { useYou } from '../you'
import { Panel } from './Panel'


function useClock(ms: number) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(id)
  }, [ms])
  return now
}

const signal = (rssi?: number, snr?: number) =>
  [rssi !== undefined ? `${Math.round(rssi)} dBm` : null, snr !== undefined ? `${snr.toFixed(1)} dB` : null]
    .filter(Boolean)
    .join(' · ')

/** The LoRa search team: the base station's network, who asks to join, who is out there. */
export function TeamPanel() {
  const { t } = useI18n()
  const { devices, trackers, joinRequests } = useCompanions()
  const you = useYou()
  const now = useClock(1000)
  const [busy, setBusy] = useState<string | null>(null)
  const base = baseStation(devices)

  const answer = async (loraId: string, accept: boolean) => {
    setBusy(loraId)
    await (accept ? acceptJoin(loraId) : rejectJoin(loraId))
    setBusy(null)
  }

  const startNewNetwork = () => {
    if (window.confirm(t('team.newNetConfirm'))) void newNetwork()
  }

  const kick = (device: string, id: string, name: string) => {
    if (window.confirm(t('team.kickConfirm', { name }))) void kickMember(device, id)
  }

  const members = Object.values(trackers).sort((a, b) => a.name.localeCompare(b.name))

  return (
    <Panel title={t('team.title')}>
      {!base ? (
        <p className="small muted">{t('team.noBase')}</p>
      ) : (
        <div className="stack">
          <div className="team-net">
            <span className="small muted">{t('team.network')}</span>
            <span className="mono team-net-id">{base.net && base.net !== NO_NET ? base.net : '—'}</span>
            <button className="btn btn-small btn-ghost" onClick={startNewNetwork}>
              {t('team.newNet')}
            </button>
          </div>

          {joinRequests.length > 0 && (
            <div className="stack-tight">
              <span className="field-label">{t('team.requests')}</span>
              {joinRequests.map((r) => (
                <div key={r.loraId} className="team-row team-request">
                  <div>
                    <strong className="mono">{r.callsign}</strong>
                    <div className="small muted mono">
                      {r.loraId} · {signal(r.rssi, r.snr)}
                    </div>
                  </div>
                  <div className="row">
                    <button className="btn btn-small btn-primary" disabled={busy === r.loraId} onClick={() => void answer(r.loraId, true)}>
                      {t('team.accept')}
                    </button>
                    <button className="btn btn-small btn-ghost" disabled={busy === r.loraId} onClick={() => void answer(r.loraId, false)}>
                      {t('team.reject')}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="stack-tight">
            <span className="field-label">{t('team.members', { count: members.length })}</span>
            {members.length === 0 && <span className="small muted">{t('team.noMembers')}</span>}
            {members.map((m) => {
              const ago = Math.max(0, Math.round((now - m.receivedAt) / 1000))
              const quiet = now - m.receivedAt > ONLINE_MS
              const away = you ? distanceBearing(you.lat, you.lon, m.lat, m.lon).distance : null
              return (
                <div key={m.id} className={`team-row ${quiet ? 'team-quiet' : ''}`}>
                  <span className="team-dot" style={{ background: statusColor(m.receivedAt, now) }} aria-hidden />
                  <div className="team-who">
                    <strong className="mono">{m.name}</strong>
                    <div className="small muted mono">{[m.device, signal(m.rssi, m.snr)].filter(Boolean).join(' · ')}</div>
                  </div>
                  <div className="small mono team-right">
                    {away !== null && <div>{away < 1000 ? `${Math.round(away)} m` : `${(away / 1000).toFixed(1)} km`}</div>}
                    <div className={quiet ? 'warn' : 'muted'}>{t('team.ago', { s: ago })}</div>
                  </div>
                  {m.device && (
                    <button className="icon-btn" title={t('team.kick')} aria-label={t('team.kick')} onClick={() => kick(m.device!, m.id, m.name)}>
                      ×
                    </button>
                  )}
                </div>
              )
            })}
          </div>
          <p className="small muted">{t('team.relayHelp')}</p>
        </div>
      )}
    </Panel>
  )
}
