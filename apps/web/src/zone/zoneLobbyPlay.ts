// The real-time play loop of a browser zone peer and its near/far counts, free of DOM so tests can drive them.
import type { FarFeed } from '@royal-fiesta/game/net/farFeed'
import type { ZoneMatch } from '@royal-fiesta/game/net/zoneMatch'
import { CharMode } from '@royal-fiesta/sim/character/constants'
import type { FiestaDomain } from '@royal-fiesta/sim/zones/fiestaDomain'

export interface PlayClock {
  /** Milliseconds, monotonic. */
  now(): number
  wait(ms: number): Promise<void>
}

export interface PlayTarget {
  frame(dtS: number): void
  readonly info: { readonly tick: number }
}

export interface PlayOptions {
  seconds: number
  /** Stop at this session tick, before `seconds` ends. */
  captureTick?: number
  frameMs: number
  maxDtS: number
  /** Started after the first frame (it creates the near characters); settles when they can be drawn. */
  load(): Promise<void>
  onPhase?: (phase: string) => void
}

/**
 * Frames the match on the page clock until `seconds` or `captureTick`, then waits for `load`. The match keeps framing
 * while `load` runs: a peer that stops framing sends nothing, and after lostAfterMs (3 s) of silence the other peers
 * drop it, which froze the whole room at the next epoch boundary.
 */
export async function playLobby(target: PlayTarget, options: PlayOptions, clock: PlayClock): Promise<void> {
  const phase = options.onPhase ?? (() => {})
  const started = clock.now()
  let last = started
  let loading: Promise<void> | undefined
  let loadError: { error: unknown } | undefined
  phase('ticking')
  do {
    await clock.wait(options.frameMs)
    if (loadError) throw loadError.error
    const now = clock.now()
    const dt = Math.min(options.maxDtS, Math.max(0, (now - last) / 1000))
    last = now
    target.frame(dt)
    if (loading === undefined) {
      phase('ticking (loading animations)')
      loading = options.load()
      loading.then(() => phase('ticking'), error => { loadError = { error } })
    }
  } while (clock.now() - started < options.seconds * 1000 && !(target.info.tick >= (options.captureTick ?? Infinity)))
  await loading
}

/** Near: live seats in the local domains (the last domain holding a seat supplies it). Far: finite FAR rows of the others. */
export function countNearFar(match: ZoneMatch, feed: FarFeed, tick: number, nearDomains = new Map<number, FiestaDomain>()):
  { near: number; far: number } {
  nearDomains.clear()
  for (const domain of match.domains) {
    for (const seat of domain.seats) nearDomains.set(seat, domain)
  }
  let near = 0
  for (const [seat, domain] of nearDomains) {
    if (domain.state(seat).mode !== CharMode.parked) near++
  }
  let far = 0
  for (const entry of feed.read(tick, seat => nearDomains.has(seat))) {
    if (Number.isFinite(entry.x) && Number.isFinite(entry.y) && Number.isFinite(entry.z) && Number.isFinite(entry.yaw)) far++
  }
  return { near, far }
}
