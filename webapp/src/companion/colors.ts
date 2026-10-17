/**
 * The Android app colors each team member from their node's chip id with this hash and palette
 * (android/.../team/MemberColors.kt). No reds or greens in it: the web app colors members by
 * status instead, green online and red offline.
 */
export const MEMBER_PALETTE = ['#9b8cff', '#ffb347', '#4dd0e1', '#d7ccc8', '#b0bec5', '#f4d35e', '#c792ea', '#5cc8ff']

/** Phones report every ~30 s; missing two reports in a row counts as offline. */
export const ONLINE_MS = 75_000
export const ONLINE_COLOR = '#3fd18b'
export const OFFLINE_COLOR = '#ff6b6b'

/** The web app shows team members green while they report, red once they go quiet. */
export function statusColor(receivedAt: number, now: number): string {
  return now - receivedAt <= ONLINE_MS ? ONLINE_COLOR : OFFLINE_COLOR
}

export function memberColor(id: string): string {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
  return MEMBER_PALETTE[h % MEMBER_PALETTE.length]
}
