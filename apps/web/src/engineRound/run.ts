import { encodeInput, NEUTRAL_CODE } from '@royal-fiesta/sim/input'
import { PROFILES } from '@royal-fiesta/sim/match/setup'
import type { ProfileName } from '@royal-fiesta/sim/course'
import { refuse } from '@royal-fiesta/sim/refusal'
import type { CourseV1 } from '../../../../packages/game/src/courseV1.ts'
import type { EngineRound } from '../../../../packages/game/src/ege/round.ts'
import type { RoundPhase } from '../../../../packages/game/src/ege/observe.ts'

export interface RoundRunArgs {
  course: string
  profile: ProfileName
  seed: number
  frames: number
  local: 'idle' | 'run' | 'dive' | 'sideways' | 'grab'
  captureAt: 'end' | 'dive' | 'firstFinish' | 'respawned'
  focus: string | null
}

const events = ['finish', 'fall', 'eliminate', 'gate', 'progress', 'score', 'team_score', 'possess', 'crown']
const modes = ['idle', 'run', 'dive', 'sideways', 'grab']
const captures = ['end', 'dive', 'firstFinish', 'respawned']

function fail(field: string, value: unknown, rule: string): never {
  refuse('engine-round', `args.${field}`, `is ${JSON.stringify(value)}; pass ${rule}`)
}

export function parseRunArgs(input: unknown): RoundRunArgs {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('course', input, 'an object with a course id')
  const value = input as Record<string, unknown>
  for (const key of Object.keys(value)) if (!['course', 'profile', 'seed', 'frames', 'local', 'captureAt', 'focus'].includes(key)) fail(key, value[key], 'only supported argument keys')
  if (typeof value.course !== 'string' || !/^[a-z0-9-]{1,40}$/.test(value.course)) fail('course', value.course, 'a course id matching ^[a-z0-9-]{1,40}$')
  const profile = value.profile ?? 'sprint'
  if (profile !== 'standard' && profile !== 'sprint') fail('profile', profile, 'standard or sprint')
  const seed = value.seed ?? 7
  if (!Number.isInteger(seed) || (seed as number) < 0 || (seed as number) > 0xffffffff) fail('seed', seed, 'an integer in 0..4294967295')
  const frames = value.frames ?? 600
  if (!Number.isInteger(frames) || (frames as number) < 1 || (frames as number) > 7200) fail('frames', frames, 'an integer in 1..7200')
  const local = value['local'] ?? 'run'
  if (typeof local !== 'string' || !modes.includes(local)) fail('local', local, 'idle, run, dive, sideways or grab')
  const captureAt = value.captureAt ?? 'end'
  if (typeof captureAt !== 'string' || !captures.includes(captureAt)) fail('captureAt', captureAt, 'end, dive, firstFinish or respawned')
  const focus = value.focus ?? null
  if (focus !== null && (typeof focus !== 'string' || !/^kind:[A-Za-z]+$/.test(focus))) fail('focus', focus, 'null or kind:<featureKind>')
  return { course: value.course, profile, seed: seed as number, frames: frames as number, local: local as RoundRunArgs['local'], captureAt: captureAt as RoundRunArgs['captureAt'], focus: focus as string | null }
}

/** Ticks a firstFinish capture waits after the first finish (the finisher is parked on its finish tick). */
export const FIRST_FINISH_TICKS = 3

export function localCode(local: RoundRunArgs['local'], tick: number, introTicks: number): number {
  if (tick < introTicks || local === 'idle') return NEUTRAL_CODE
  return encodeInput({ moveX: local === 'sideways' ? 1 : 0, moveZ: local === 'sideways' ? 0 : 1,
    jump: (local === 'run' || local === 'dive') && (tick - introTicks) % 45 === 0,
    dive: local === 'dive' && tick === introTicks + 60, grab: local === 'grab' })
}

export interface RoundFacts {
  course: string; kind: string; profile: ProfileName; tick: number; capturedAt: number; phase: RoundPhase
  seats: number; entities: number; bodies: number; faults: number; alive: number; qualified: number; eliminated: number
  events: Record<string, number>; local: { mode: number; status: number; pos: [number, number, number]; travelZ: number }
  botsMoved: number; upright: boolean; features: Record<string, number>
  focus: { kind: string; id: string; moved: boolean; changed: number } | null
}

type SceneEntity = { name?: string; body?: unknown; components?: Record<string, Record<string, unknown>> }
type AnyRound = EngineRound & { scene: { scene: { entities: SceneEntity[] }; seatEntities: number[] } }

/**
 * Handoff: Engine round page op, inventory row and ops registration calls createRoundRun to step
 * an offline round to its capture point and read its RoundFacts today.
 */
export function createRoundRun(round: EngineRound, args: RoundRunArgs, course: CourseV1): { step(): boolean; facts(): RoundFacts; done: boolean } {
  const r = round as AnyRound
  const initial = round.observe()
  const starts = initial.seats.map(seat => ({ x: seat.pos.x, z: seat.pos.z }))
  const pose = () => round.poses(r.scene.seatEntities)
  const initialPose = pose()
  const entities = r.scene.scene.entities as unknown as SceneEntity[]
  const featureSpecs = course.sim?.features ?? []
  const featureCounts: Record<string, number> = {}
  for (const feature of featureSpecs) featureCounts[feature.kind] = (featureCounts[feature.kind] ?? 0) + 1
  let done = false
  let capturedAt = round.tick
  let diveTick: number | null = null
  let finishTick: number | null = null
  let respawnTick: number | null = null
  let priorFalls = initial.events.fall ?? 0
  const focusKind = args.focus?.slice(5) ?? null
  const focusSpec = featureSpecs.find(item => item.kind === focusKind)
  const focusEntities = focusSpec ? entities.filter(entity => (entity.name ?? '').includes(focusSpec.id)) : []
  const focusStart = focusEntities.map(entity => ({ id: r.scene.index(entity.name ?? ''), render: entity.components?.['ege.render'] ?? {}, pose: round.poses([r.scene.index(entity.name ?? '')]) }))
  const shouldCapture = () => {
    const observation = round.observe()
    if (observation.seats[0]?.mode === 2 && diveTick === null) diveTick = round.tick
    if ((observation.events.finish ?? 0) > 0 && finishTick === null) finishTick = round.tick
    if ((observation.events.fall ?? 0) > priorFalls && respawnTick === null) respawnTick = -1
    if (respawnTick === -1 && observation.seats[0]?.status === 1 && (r as any).worldState().components.character?.[String(r.scene.seatEntities[0])]?.parked === 0) respawnTick = round.tick
    priorFalls = observation.events.fall ?? 0
    return args.captureAt === 'dive' ? diveTick !== null && round.tick >= diveTick + 10
      // The first finisher is parked at once; the rest of the field still runs for a few ticks only (ege-strip: the
      // whole field finished 36 ticks after the first, so a later capture showed an ended round and an empty floor).
      // Capture while the followed seat still runs, so the follow camera faces the finish with the field around it.
      : args.captureAt === 'firstFinish' ? finishTick !== null && (round.tick >= finishTick + FIRST_FINISH_TICKS || observation.seats[0]?.status !== 1)
      : args.captureAt === 'respawned' ? respawnTick !== null && respawnTick >= 0 && round.tick >= respawnTick + 30 : false
  }
  return {
    get done() { return done },
    step() {
      if (done) return false
      round.step(() => localCode(args.local, round.tick, PROFILES[args.profile].introTicks))
      if (round.tick >= args.frames || shouldCapture()) { done = true; capturedAt = round.tick }
      return true
    },
    facts() {
      const observation = round.observe()
      const seats = observation.seats
      const currentPose = pose()
      let botsMoved = 0
      for (let i = 1; i < seats.length; i++) if (Math.hypot(seats[i].pos.x - starts[i].x, seats[i].pos.z - starts[i].z) > 1) botsMoved++
      let upright = true
      for (let i = 0; i < seats.length; i++) if (Math.abs(currentPose[i * 23 + 3]) >= 1e-3 || Math.abs(currentPose[i * 23 + 5]) >= 1e-3) upright = false
      const local = seats[0]
      const eventCounts = Object.fromEntries(events.map(name => [name, observation.events[name] ?? 0]))
      const spec = focusSpec
      const state = round.worldState() as { components?: Record<string, Record<string, Record<string, unknown>>> }
      const moved = focusStart.some(start => {
        const now = round.poses([start.id])
        return Math.hypot(now[0] - start.pose[0], now[2] - start.pose[2]) > 0.5
      })
      const changed = focusStart.filter(start => {
        const render = state.components?.['ege.render']?.[String(start.id)]
        return render && (render.color !== start.render.color || render.visible !== start.render.visible)
      }).length
      return { course: args.course, kind: course.kind, profile: args.profile, tick: round.tick, capturedAt, phase: observation.phase,
        seats: seats.length, entities: entities.length, bodies: entities.filter(entity => entity.body).length, faults: observation.faults,
        alive: observation.alive, qualified: observation.qualified, eliminated: observation.eliminated, events: eventCounts,
        local: { mode: local.mode, status: local.status, pos: [local.pos.x, local.pos.y, local.pos.z], travelZ: local.pos.z - starts[0].z },
        botsMoved, upright, features: featureCounts,
        focus: spec ? { kind: spec.kind, id: spec.id, moved, changed } : null }
    },
  }
}
