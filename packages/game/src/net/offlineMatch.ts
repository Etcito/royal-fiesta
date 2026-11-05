import { SnapReader, SnapWriter } from '@gamesaloon/rollback'
import type { ShadowView } from '@gamesaloon/rollback/zones'
import type { RapierModule } from '@gamesaloon/rollback-rapier'
import { neutralInput } from '@royal-fiesta/sim/input'
import { FiestaDomain } from '@royal-fiesta/sim/zones/fiestaDomain'
import { createFiestaDomainFactory } from '@royal-fiesta/sim/zones/fiestaDomainFactory'
import type { FiestaDomainFactoryConfig } from '@royal-fiesta/sim/zones/fiestaDomainFactory'
import { MatchLedger } from '@royal-fiesta/sim/zones/ledger'
import type { ZoneMatch } from './zoneMatch.ts'

/** One complete physics world. No session, prediction, snapshots, handoffs or resimulation. */
export function createOfflineMatch(R: RapierModule, cfg: FiestaDomainFactoryConfig): ZoneMatch {
  const seats = Array.from({ length: cfg.seatCount }, (_, seat) => seat)
  const recipe = createFiestaDomainFactory(R, cfg)
  const ledger = recipe.create({ id: 0, kind: 'global', seats: [], cells: [], replicas: [] }, 0) as MatchLedger
  const domain = recipe.create({ id: 1, kind: 'seat', seats,
    cells: Array.from({ length: cfg.zones.grid.cols * cfg.zones.grid.rows }, (_, i) => i), replicas: [] }, 0) as FiestaDomain
  const inputs = seats.map(() => neutralInput())
  const empty: ShadowView = { count: 0, fromDomain: () => { throw new Error('No offline shadows') }, reader: () => { throw new Error('No offline shadows') } }
  // Only round events cross this boundary, never physics snapshots or entity exports.
  const events = new SnapWriter()
  const eventView: ShadowView = { count: 1, fromDomain: () => 1, reader: () => new SnapReader(events.bytes()) }
  const stats: ZoneMatch['stats'] = { tick: 0, confirmedTick: { 0: 0, 1: 0 }, delay: 0, frames: 0,
    rollbacks: 0, maxRollback: 0, resimTicks: 0, stallFrames: 0, desyncs: 0, malformed: 0,
    lostPeers: [], sleepTransitions: 0, syncSkips: 0, syncAdvantage: 0, syncRttMs: 0 }
  let accumulator = 0
  let disposed = false
  return {
    stats, ledger, currentLedger: ledger, domains: [domain],
    get worlds() { return disposed ? 0 : 1 },
    get heldStates() { return disposed ? 0 : 1 },
    confirmedHash: () => undefined,
    frame(dtS, sample) {
      if (disposed) return 0
      // Bound catch-up work after a suspended tab; fixed ticks preserve determinism.
      accumulator += Math.min(0.25, Number.isFinite(dtS) ? Math.max(0, dtS) : 0)
      let steps = 0
      while (accumulator + 1e-10 >= 1 / 60 && !ledger.over) {
        sample(inputs)
        domain.step(inputs, empty)
        events.reset()
        domain.events(events)
        ledger.step(inputs, eventView)
        stats.tick = domain.tick
        stats.confirmedTick[0] = ledger.tick
        stats.confirmedTick[1] = domain.tick
        accumulator -= 1 / 60
        steps++
      }
      stats.frames++
      return steps
    },
    dispose() { if (!disposed) { disposed = true; domain.dispose() } },
  }
}
