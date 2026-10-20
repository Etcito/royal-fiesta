import { RollbackSession, evenPeers, hex8 } from '@gamesaloon/rollback'
import type { NetTransport } from '@gamesaloon/rollback'
import type { RapierModule } from '@gamesaloon/rollback-rapier'
import { inputCodec } from '@royal-fiesta/sim/input'
import type { PlayerInput } from '@royal-fiesta/sim/input'
import type { MatchLog } from '@royal-fiesta/sim/match/log'
import { MatchSim } from '@royal-fiesta/sim/match/matchSim'
import { setupHash } from '@royal-fiesta/sim/match/setup'
import type { MatchSetup } from '@royal-fiesta/sim/match/setup'
import { refuse } from '@royal-fiesta/sim/refusal'
import { FIESTA_TUNING, NET_PLAYERS } from './tuning.ts'

export interface NetMatchConfig { setup: MatchSetup; localPeer: number; humanPeers: number }

export interface NetMatch {
  readonly sim: MatchSim
  readonly session: RollbackSession<PlayerInput>
  frame(dtS: number, sample: (out: PlayerInput[]) => void): number
  readonly done: boolean
  log(): MatchLog
  dispose(): void
}

function check(cfg: NetMatchConfig): void {
  const { setup, localPeer, humanPeers } = cfg
  if (setup.playerCount !== NET_PLAYERS) {
    refuse('net', 'createNetMatch.setup.playerCount', `${setup.playerCount} is not ${NET_PLAYERS}; build the setup with netSetup`)
  }
  if (!Number.isInteger(localPeer) || localPeer < 0 || localPeer >= humanPeers) {
    refuse('net', 'createNetMatch.localPeer', `${localPeer} is outside 0..${humanPeers - 1}; pass this peer's rank among the human peers`)
  }
  for (let i = 0; i < NET_PLAYERS; i++) {
    if (setup.humans[i] !== i < humanPeers) {
      refuse('net', `createNetMatch.setup.humans/${i}`, `is ${setup.humans[i]} but humanPeers is ${humanPeers}; humans must be players 0..humanPeers-1 (use netSetup)`)
    }
  }
}

export function createNetMatch(R: RapierModule, cfg: NetMatchConfig, net: NetTransport, opts?: { cpuMs?: () => number }): NetMatch {
  check(cfg)
  const setup = cfg.setup
  const sim = new MatchSim(R, setup)
  // Bots (players humanPeers..7) belong to no peer: the session feeds them neutral input and BotSystem overrides it.
  const session = new RollbackSession<PlayerInput>(sim, {
    ...FIESTA_TUNING,
    localPeer: cfg.localPeer,
    playerCount: NET_PLAYERS,
    peers: evenPeers(cfg.humanPeers, 1),
    codec: inputCodec,
    dumpInfo: () => ({ setupHash: hex8(setupHash(setup)), seed: setup.seed, profile: setup.profile }),
    cpuMs: opts?.cpuMs,
  }, net)
  let finalTick = -1
  let disposed = false
  return {
    sim,
    session,
    frame: (dtS, sample) => session.frame(dtS, sample),
    get done() {
      // log() refuses before done, so check sim.done first.
      if (!sim.done) return false
      if (finalTick < 0) finalTick = sim.log().finalTick
      return session.stats.confirmedTick >= finalTick
    },
    log: () => sim.log(),
    dispose() {
      if (disposed) return
      disposed = true
      session.dispose()
      sim.free()
    },
  }
}
