import { InputBuffer } from '@gamesaloon/rollback'
import { CONTROL_BITS, CONTROL_NO_CELL, MAX_PEERS, packControl, unpackControl, ZoneSession } from '@gamesaloon/rollback/zones'
import type { DomainFactory, DomainSim, FarSink, GroupTransport, Roster, ZoneStats } from '@gamesaloon/rollback/zones'
import type { RapierModule } from '@gamesaloon/rollback-rapier'
import { newMemory } from '@royal-fiesta/sim/bots/brain'
import type { ResolvedCourse } from '@royal-fiesta/sim/course'
import { decodeInput, inputCodec } from '@royal-fiesta/sim/input'
import type { PlayerInput } from '@royal-fiesta/sim/input'
import type { MatchProfile } from '@royal-fiesta/sim/match/setup'
import { refuse } from '@royal-fiesta/sim/refusal'
import { cellOf, clampedCellOf } from '@royal-fiesta/sim/zones/cells'
import { FiestaDomain } from '@royal-fiesta/sim/zones/fiestaDomain'
import { createFiestaDomainFactory } from '@royal-fiesta/sim/zones/fiestaDomainFactory'
import { MatchLedger } from '@royal-fiesta/sim/zones/ledger'
import type { ZonesFile } from '@royal-fiesta/sim/zones/zonesFile'
import { takeoverInput } from './takeoverBot.ts'
import { FIESTA_TUNING } from './tuning.ts'
import { mergeZoneTuning, peerClasses } from './zoneTuning.ts'

export interface ZoneMatchConfig {
  readonly localPeer: number
  readonly roster: Roster
  readonly course: ResolvedCourse
  /** Required: loadZonesFile refuses a missing sidecar before constructing the match. */
  readonly zones: ZonesFile
  readonly profile: MatchProfile
  readonly kind: 'race' | 'survival'
  /** Peer-indexed room measurements, identical on every peer for epoch-0 assignment. */
  readonly measurements: Readonly<Record<number, {
    readonly cpuMs: number
    readonly bandwidthKbps: number
    readonly latencyMs: number
    readonly spareSlots: number
  }>>
  /** Seat-indexed course spawn indices, identical on every peer. */
  readonly spawnIndices?: readonly number[]
  readonly farSink?: FarSink
}

export interface ZoneMatch {
  /** Sample inputs in the local peer's roster seat order, once per due tick. */
  frame(dtS: number, sample: (out: PlayerInput[]) => void): number
  readonly stats: ZoneStats
  /** Current domain 0; read again after a frame because recovery can replace it. */
  readonly ledger: MatchLedger
  /** Borrowed list of current local physics domains, ascending id; each exposes characters and seats. */
  readonly domains: readonly FiestaDomain[]
  confirmedHash(domain: number, tick: number): number | undefined
  dispose(): void
}

function check(cfg: ZoneMatchConfig): void {
  if (!cfg.zones || cfg.zones.course !== cfg.course.id) {
    refuse('zones', 'createZoneMatch.zones', 'missing or mismatched sidecar; use loadZonesFile for this course')
  }
  const roster = cfg.roster
  if (!Number.isInteger(roster.seatCount) || roster.seatCount < 1 || roster.seatCount > CONTROL_BITS.cell.mask) {
    refuse('zones', 'createZoneMatch.roster.seatCount', 'invalid seat count; supply a nonempty u16 roster')
  }
  const seats = new Uint8Array(roster.seatCount)
  const peers = new Set<number>()
  for (const p of roster.peers) {
    if (!Number.isInteger(p.peer) || p.peer < 0 || p.peer >= MAX_PEERS || peers.has(p.peer)) {
      refuse('zones', 'createZoneMatch.roster.peers', 'invalid or duplicate peer; supply distinct supported peer ids')
    }
    peers.add(p.peer)
    if (p.seats.length < 1 || p.seats.length > 4 || typeof roster.live[p.peer] !== 'boolean') {
      refuse('zones', 'createZoneMatch.roster', 'invalid peer seats or liveness; supply 1–4 seats and a live flag per peer')
    }
    for (const seat of p.seats) {
      if (!Number.isInteger(seat) || seat < 0 || seat >= seats.length || seats[seat]) {
        refuse('zones', 'createZoneMatch.roster.seats', 'invalid or duplicate seat; assign each roster seat once')
      }
      seats[seat] = 1
    }
    const m = cfg.measurements[p.peer]
    if (!m || !Number.isFinite(m.cpuMs) || m.cpuMs < 0 ||
        !Number.isFinite(m.bandwidthKbps) || m.bandwidthKbps < 0 ||
        !Number.isFinite(m.latencyMs) || m.latencyMs < 0 ||
        !Number.isInteger(m.spareSlots) || m.spareSlots < 0 || m.spareSlots > CONTROL_BITS.spareSlots.mask) {
      refuse('zones', `createZoneMatch.measurements/${p.peer}`, 'invalid measurements or spare slots; supply nonnegative measurements and a u4 slot count')
    }
  }
  if (!peers.has(cfg.localPeer) || seats.includes(0)) {
    refuse('zones', 'createZoneMatch.roster', 'missing local peer or seat owner; supply the complete match roster')
  }
}

export function createZoneMatch(R: RapierModule, cfg: ZoneMatchConfig, net: GroupTransport): ZoneMatch {
  check(cfg)
  const tuning = mergeZoneTuning(cfg.zones)
  const localSeats = cfg.roster.peers.find(p => p.peer === cfg.localPeer)!.seats.slice()
  const controls = new Uint32Array(cfg.roster.seatCount)
  const fields = []
  for (const p of cfg.roster.peers) {
    const m = cfg.measurements[p.peer]
    const word = { ...peerClasses(m.cpuMs, m.bandwidthKbps, m.latencyMs, tuning),
      spareSlots: m.spareSlots, cell: CONTROL_NO_CELL }
    fields[p.peer] = word
    for (const seat of p.seats) {
      const index = cfg.spawnIndices?.[seat] ?? seat % cfg.course.spawns.length
      const spawn = cfg.course.spawns[index]
      if (!Number.isInteger(index) || !spawn) {
        refuse('zones', `createZoneMatch.spawnIndices/${seat}`, 'missing spawn; supply a course spawn index for every seat')
      }
      word.cell = cellOf(cfg.zones.grid, spawn.t.x, spawn.t.z)
      controls[seat] = packControl(word)
    }
  }
  const localFields = fields[cfg.localPeer]
  // Last reported cell of each local seat, starting at its spawn cell (the epoch-0 control word).
  const localCells = localSeats.map(seat => unpackControl(controls[seat], { ...localFields }).cell)
  const recipe = createFiestaDomainFactory(R, {
    course: cfg.course, zones: cfg.zones, profile: cfg.profile, kind: cfg.kind,
    seatCount: cfg.roster.seatCount, spawnIndices: cfg.spawnIndices,
  })
  // DomainSim has no disposal hook. Retain worlds, including rebuild temporaries, until match disposal.
  const worlds: FiestaDomain[] = []
  function own(sim: DomainSim<PlayerInput>): DomainSim<PlayerInput> {
    if (sim instanceof FiestaDomain) worlds.push(sim)
    return sim
  }
  function freeWorlds(): void {
    for (let i = 0; i < worlds.length; i++) worlds[i].inner.world.sim.free()
    worlds.length = 0
  }
  const factory: DomainFactory<PlayerInput> = {
    create: (spec, tick) => own(recipe.create(spec, tick)),
    rebuild: (spec, tick, sources) => own(recipe.rebuild(spec, tick, sources)),
    reset: (spec, tick) => own(recipe.reset(spec, tick)),
  }
  const memory = Array.from({ length: cfg.roster.seatCount }, () => newMemory())
  // The global and seat domains can request the same bot tick; advance its brain only once.
  const capacity = tuning.epochTicks * tuning.keyframeEvery + tuning.snapshotRing + tuning.leadTicks +
    FIESTA_TUNING.maxPrediction + FIESTA_TUNING.maxDelay
  const botCodes = Array.from({ length: cfg.roster.seatCount }, () => new InputBuffer(inputCodec.neutral, capacity))
  let session: ZoneSession<PlayerInput>
  // The assignment is planned leadTicks ahead: a state created at its boundary S holds the spawn pose until it steps
  // S. Until then the seat lives in the state that is stepping now (kept for the handoff grace), remembered here.
  const running: (FiestaDomain | undefined)[] = new Array(cfg.roster.seatCount).fill(undefined)
  function started(start: number, sim: FiestaDomain): boolean {
    return start === 0 || sim.tick > start
  }
  function seatDomain(seat: number): FiestaDomain | undefined {
    const state = session.domain(session.assignment.seatDomain[seat])
    if (!state?.replica || !(state.sim instanceof FiestaDomain) || !state.sim.seats.includes(seat)) return undefined
    if (started(state.start, state.sim)) return running[seat] = state.sim
    const prev = running[seat]
    return prev !== undefined && prev.seats.includes(seat) ? prev : undefined
  }
  try {
    session = new ZoneSession({
      ...FIESTA_TUNING,
      localPeer: cfg.localPeer, roster: cfg.roster, tuning, factory, codec: inputCodec,
      controls, farSink: cfg.farSink,
      botInput(seat, tick, out) {
        const known = botCodes[seat].get(tick)
        if (known !== undefined) {
          decodeInput(known, out)
          return
        }
        const domain = seatDomain(seat)
        if (domain === undefined) {
          decodeInput(inputCodec.neutral, out)
          return
        }
        const code = takeoverInput(cfg.course, memory[seat], domain.state(seat), tick, out)
        botCodes[seat].set(tick, code)
      },
    }, net)
  } catch (error) {
    freeWorlds()
    throw error
  }
  let sampleInputs: ((out: PlayerInput[]) => void) | undefined
  // Keep this callback and the control fields across frames; the session owns the output buffers.
  function sample(inputs: PlayerInput[], words: Uint32Array): void {
    sampleInputs!(inputs)
    for (let i = 0; i < localSeats.length; i++) {
      const seat = localSeats[i]
      const domain = seatDomain(seat)
      // A live seat always reports a cell: CONTROL_NO_CELL takes it out of every domain, and then no replica
      // simulates it, so it could never report a cell again. Off the grid it stays in the nearest edge cell.
      if (domain !== undefined) {
        const pos = domain.state(seat).pos
        const cell = clampedCellOf(cfg.zones.grid, pos.x, pos.z)
        if (cell !== CONTROL_NO_CELL) localCells[i] = cell
      }
      localFields.cell = localCells[i]
      words[i] = packControl(localFields)
    }
  }
  const domains: FiestaDomain[] = []
  const listed = new Set<FiestaDomain>()
  let disposed = false
  return {
    stats: session.stats,
    frame(dtS, sampleLocal) {
      sampleInputs = sampleLocal
      try {
        return session.frame(dtS, sample)
      } finally {
        sampleInputs = undefined
      }
    },
    get ledger() {
      const sim = session.domain(0)?.sim
      if (!(sim instanceof MatchLedger)) {
        refuse('zones', 'createZoneMatch.ledger', 'local ledger is unavailable; read results before disposing the match')
      }
      return sim
    },
    get domains() {
      let count = 0
      listed.clear()
      const specs = session.assignment.domains
      for (let i = 0; i < specs.length; i++) {
        const state = session.domain(specs[i].id)
        if (!state?.replica || !(state.sim instanceof FiestaDomain)) continue
        if (started(state.start, state.sim)) {
          if (!listed.has(state.sim)) domains[count++] = state.sim
          listed.add(state.sim)
          continue
        }
        // Not stepping yet: list the states its seats are stepping in now.
        for (const seat of specs[i].seats) {
          const sim = seatDomain(seat)
          if (sim === undefined || sim === state.sim || listed.has(sim)) continue
          domains[count++] = sim
          listed.add(sim)
        }
      }
      domains.length = count
      return domains
    },
    confirmedHash: (domain, tick) => session.confirmedHash(domain, tick),
    dispose() {
      if (disposed) return
      disposed = true
      session.dispose()
      domains.length = 0
      freeWorlds()
    },
  }
}
