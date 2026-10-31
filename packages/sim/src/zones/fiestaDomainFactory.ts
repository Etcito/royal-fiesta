import { SnapReader, SnapWriter } from '@gamesaloon/rollback'
import type { DomainFactory, DomainSim, DomainSpec } from '@gamesaloon/rollback/zones'
import { mergeEntityStreams, RapierDomainFactory } from '@gamesaloon/rollback-rapier'
import type {
  DomainEntityBuilder, DomainJointBuilder, KinematicPart, RapierDomainHooks, RapierModule,
} from '@gamesaloon/rollback-rapier'
import { CHAR } from '../character/constants.ts'
import { CharacterSystem, characterBody } from '../character/system.ts'
import type { ResolvedCourse } from '../course.ts'
import { levelOf } from '../course.ts'
import { G, groups } from '../groups.ts'
import type { PlayerInput } from '../input.ts'
import { planRound, roundTicks } from '../match/rules.ts'
import type { MatchProfile } from '../match/setup.ts'
import { refuse } from '../refusal.ts'
import type { FinalRule, RoundKind } from '../season/kinds.ts'
import { GRAVITY_Y, readBlob } from '../world.ts'
import { cellOf } from './cells.ts'
import { FiestaDomain } from './fiestaDomain.ts'
import type { FiestaDomainConfig } from './fiestaDomain.ts'
import { MatchLedger } from './ledger.ts'
import type { MatchLedgerConfig } from './ledger.ts'
import { partMode } from './zonesFile.ts'
import type { ZonesFile } from './zonesFile.ts'

export interface FiestaDomainFactoryConfig {
  readonly course: ResolvedCourse
  readonly zones: ZonesFile
  readonly profile: MatchProfile
  /** Round kind used by the legacy plan when no slot is supplied. */
  readonly kind: RoundKind
  readonly slot?: {
    readonly kind: RoundKind
    readonly final: boolean
    readonly finalRule: FinalRule | null
    readonly target: number
    readonly playoff: boolean
    readonly roundIndex: number
    readonly seed: number
    readonly teams: Uint8Array | null
    readonly overtimeTicks: number
    readonly openingRanks?: Uint16Array | null
  }
  /** Roster seats; every domain gets its own subset in spec.seats. */
  readonly seatCount: number
  /** Roster-indexed spawn index into course.spawns; defaults to the seat id (seatSpawn: rows behind past the spawns). */
  readonly spawnIndices?: readonly number[]
}

const CHARACTER_KIND = 1
const NO_PARAMS = new Uint8Array(0)
const NO_PARTS: readonly KinematicPart[] = []
// Shadow proxies stand in for another domain's characters, so they collide like one.
const PROXY_GROUPS = groups(G.CHAR, G.STATIC | G.MOVING | G.CHAR)
const GRAVITY = { x: 0, y: GRAVITY_Y, z: 0 }

/**
 * Domains for the fiesta: the global ledger, or a FiestaDomain around a RapierDomainSim.
 * FiestaDomain owns the ObstacleSystem and the CharacterSystem, so the Rapier hooks only
 * supply the seat bodies and the shadow proxies.
 */
export function createFiestaDomainFactory(
  R: RapierModule,
  config: FiestaDomainFactoryConfig,
): DomainFactory<PlayerInput> {
  const plan = planRound(0, config.seatCount)
  const slot = config.slot
  const schedule: MatchLedgerConfig = {
    seatCount: config.seatCount,
    kind: slot ? slot.kind : config.kind,
    final: slot ? slot.final : plan.final,
    finalRule: slot ? slot.finalRule : plan.final && config.kind === 'survival' ? 'lastStanding' : null,
    target: slot ? slot.target : plan.target,
    playoff: slot ? slot.playoff : false,
    overtimeTicks: slot ? slot.overtimeTicks : 0,
    seed: slot ? slot.seed : 0,
    roundIndex: slot ? slot.roundIndex : 0,
    teams: slot ? slot.teams : null,
    openingRanks: slot?.openingRanks ?? null,
    introTicks: config.profile.introTicks,
    roundTicks: Math.min(levelOf(config.course).timeCapTicks, roundTicks(config.course, config.profile)),
  }
  const domainConfig = (placeSeats: boolean): FiestaDomainConfig => ({
    course: config.course,
    zones: config.zones,
    schedule,
    spawnIndices: config.spawnIndices,
    placeSeats,
  })
  // Consumes the seat blocks of sources that this domain does not keep.
  const sink = new CharacterSystem({ playerCount: 1 })

  const buildEntity: DomainEntityBuilder = (kind) => {
    if (kind !== CHARACTER_KIND) {
      refuse('fiestaDomainFactory', `buildEntity(${kind})`, 'unknown entity kind; a domain holds characters only')
    }
    return characterBody(R, 0)
  }
  const buildJoint: DomainJointBuilder = () => {
    refuse('fiestaDomainFactory', 'buildJoint', 'joints are not part of V1; rebuild the world without them')
  }
  const hooks: RapierDomainHooks<PlayerInput> = {
    // FiestaDomain loads the course through its own WorldCtx and poses the kinematic
    // parts at the creation tick. Loading here again would add a second set of bodies.
    buildStatic() {},
    spawnSeat(world, seat) {
      // The entity id is a pure function of the seat, so it survives merge and split.
      world.adopt(seat + 1, CHARACTER_KIND, NO_PARAMS, seat)
    },
    applyInput() {},
    events() {},
    buildEntity,
    buildJoint,
    cellOf(x, z) { return cellOf(config.zones.grid, x, z) },
    // ObstacleSystem poses every kinematic part by tick; the world must not pose them too.
    kinematicParts() { return NO_PARTS },
    buildProxy() {
      return {
        body: R.RigidBodyDesc.kinematicPositionBased(),
        colliders: [R.ColliderDesc.capsule(CHAR.halfHeight, CHAR.radius)
          .setDensity(0)
          .setFriction(0)
          .setFrictionCombineRule(R.CoefficientCombineRule.Min)
          .setRestitution(0)
          .setCollisionGroups(PROXY_GROUPS)],
      }
    },
  }
  const rapier = new RapierDomainFactory(R, hooks, { gravity: GRAVITY })

  function create(spec: DomainSpec, tick: number): DomainSim<PlayerInput> {
    if (spec.kind === 'global') return new MatchLedger(spec, tick, schedule)
    return new FiestaDomain(rapier.create(spec, tick), domainConfig(true))
  }

  function rebuild(spec: DomainSpec, tick: number, sources: SnapReader[]): DomainSim<PlayerInput> {
    if (spec.kind === 'global') {
      // The ledger exports its full state, so a handoff keeps the round results.
      const ledger = new MatchLedger(spec, tick, schedule)
      for (let i = 0; i < sources.length; i++) ledger.restore(sources[i])
      return ledger
    }
    const blobs: Uint8Array[] = []
    for (let i = 0; i < sources.length; i++) blobs.push(readBlob(sources[i]))
    const fresh = freshSeats(spec, tick, blobs)
    if (fresh !== null) {
      blobs.push(readBlob(fresh))
      sources = [...sources, fresh]
    }
    const inner = blobs.map(blob => new SnapReader(blob))
    const domain = new FiestaDomain(rapier.rebuild(spec, tick, inner), domainConfig(false))
    applyTrailers(domain, spec, sources, config, sink)
    return domain
  }

  /**
   * A seat in no source export: its old domain's replicas were all lost (planEpoch builds the domain from the other
   * sources), or it had no domain last epoch. Every replica lacks the same exports, so each one adds the same source
   * last (sources merge first-wins): those seats created at their spawn, alive.
   */
  function freshSeats(spec: DomainSpec, tick: number, blobs: readonly Uint8Array[]): SnapReader | null {
    const carried = new Set<number>()
    for (const e of mergeEntityStreams(blobs.map(blob => new SnapReader(blob))).entities) carried.add(e.owner)
    const seats = spec.seats.filter(seat => !carried.has(seat))
    if (seats.length === 0) return null
    const domain = new FiestaDomain(rapier.create({ ...spec, kind: 'seat', seats, cells: [] }, tick), domainConfig(true))
    const w = new SnapWriter()
    try {
      domain.exportEntities(w)
    } finally {
      domain.inner.world.sim.free()
    }
    return new SnapReader(w.bytes().slice())
  }

  function reset(spec: DomainSpec, tick: number): DomainSim<PlayerInput> {
    return create(spec, tick)
  }

  return { create, rebuild, reset }
}

/** The inner blob is consumed above; each source reader now sits at its FiestaDomain trailer. */
function applyTrailers(
  domain: FiestaDomain,
  spec: DomainSpec,
  sources: readonly SnapReader[],
  config: FiestaDomainFactoryConfig,
  sink: CharacterSystem,
): void {
  const keptSeats = new Set<number>()
  const keptSeesaws = new Set<number>()
  let mechanisms: [SnapReader, SnapReader, SnapReader] | null = null
  for (let s = 0; s < sources.length; s++) {
    const r = sources[s]
    const seatCount = r.u16()
    for (let i = 0; i < seatCount; i++) {
      const seat = r.u16()
      // Sources merge first-wins, like the entity stream they came from.
      if (spec.seats.includes(seat) && !keptSeats.has(seat)) {
        domain.readSeat(r, seat)
        keptSeats.add(seat)
      } else {
        sink.readPlayer(r, 0)
        r.u8()
        r.i16()
      }
    }
    const seesawCount = r.u16()
    for (let i = 0; i < seesawCount; i++) {
      const index = r.u16()
      const angle = r.f64()
      const prevAngle = r.f64()
      const angVel = r.f64()
      if (keptSeesaws.has(index) || !ownedSeesaw(config, spec, index)) continue
      domain.obstacles.setSeesawState(index, angle, prevAngle, angVel)
      keptSeesaws.add(index)
    }
    // Mechanism state is course-wide, not per seat: the first source's copy is kept, like the entity stream.
    const logic = new SnapReader(readBlob(r))
    const mech = new SnapReader(readBlob(r))
    const dynamic = new SnapReader(readBlob(r))
    if (mechanisms === null) mechanisms = [logic, mech, dynamic]
  }
  if (mechanisms !== null) domain.adoptMechanisms(mechanisms[0], mechanisms[1], mechanisms[2])
  // The creation tick's pose must use the see-saw angles restored above.
  domain.obstacles.placeKinematic(domain.ctx, domain.tick)
}

function ownedSeesaw(config: FiestaDomainFactoryConfig, spec: DomainSpec, index: number): boolean {
  const obstacle = config.course.obstacles[index]
  if (obstacle === undefined) {
    refuse('fiestaDomainFactory', `seesaws/${index}`, 'missing course obstacle; rebuild with the same course')
  }
  return obstacle.motion.kind === 'seesaw' && partMode(config.zones, obstacle) === 'physics' &&
    spec.cells.includes(cellOf(config.zones.grid, obstacle.t.x, obstacle.t.z))
}
