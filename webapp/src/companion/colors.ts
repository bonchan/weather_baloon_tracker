/**
 * One color per team member, picked from their node's chip id, so the web app and the phones
 * show everyone in the same color. android/.../team/MemberColors.kt uses the same hash and palette.
 */
export const MEMBER_PALETTE = ['#9b8cff', '#ffb347', '#4dd0e1', '#ff6f91', '#a5d65a', '#f4d35e', '#c792ea', '#5cc8ff']

export function memberColor(id: string): string {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
  return MEMBER_PALETTE[h % MEMBER_PALETTE.length]
}
