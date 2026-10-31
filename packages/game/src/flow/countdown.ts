// The 3-2-1-GO countdown: a pure lookup from elapsed show time to the label and
// the sound id of its cue. The caller plays the cue once per label change.
export const COUNTDOWN_MS = 4000

export type CountdownLabel = '3' | '2' | '1' | 'GO'

export interface CountdownFrame {
  label: CountdownLabel | null
  sound: string | null
}

export function countdownAt(msSinceStart: number): CountdownFrame {
  if (!Number.isFinite(msSinceStart) || msSinceStart < 0 || msSinceStart >= COUNTDOWN_MS) {
    return { label: null, sound: null }
  }
  if (msSinceStart < 1000) return { label: '3', sound: 'flow.count-tick' }
  if (msSinceStart < 2000) return { label: '2', sound: 'flow.count-tick' }
  if (msSinceStart < 3000) return { label: '1', sound: 'flow.count-tick' }
  return { label: 'GO', sound: 'flow.count-go' }
}
