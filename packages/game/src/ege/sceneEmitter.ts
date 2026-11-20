import type { EgeScene, EngineInstance } from '@etcito/game-engine'
import { assemblyScene, buildAssembly } from '@etcito/game-engine/formats'
import type { AssemblyExtra, AssemblyItem, EgeAssembly, MoverJson } from '@etcito/game-engine/formats'
import type { LevelSpec, ProfileName, ResolvedCourse } from '@royal-fiesta/sim/course'
import { legacyLevel } from '@royal-fiesta/sim/course'
import { CAPSULE } from '@royal-fiesta/sim/character/capsule'
import type { CharacterCapsule } from '@royal-fiesta/sim/character/capsule'
import { CHAR } from '@royal-fiesta/sim/character/constants'
import { GRAVITY_Y } from '@royal-fiesta/sim/world'
import { PROFILES } from '@royal-fiesta/sim/match/setup'
import { refuse } from '@royal-fiesta/sim/refusal'
import { seatSpawn } from '@royal-fiesta/sim/zones/seatSpawn'
import type { ColliderSpec, Surface } from '@royal-fiesta/sim/course'
import type { CourseV1, ResolvedGameAsset } from '../courseV1.ts'
import { RF_EGE_WORLD_KIND } from './files.ts'
import { assetColliders, engineColliders } from './colliders.ts'
import { FEATURE_EMITTERS } from './featureEmitters.ts'
import type { RawEntity } from './featureEmitters.ts'

export interface EmitInput {
  course: CourseV1
  assets: ReadonlyMap<string, ResolvedGameAsset>
  capsule?: CharacterCapsule
  setup: { profile: ProfileName; seed: number }
  show?: { worldKind: 'show_seat' | 'show_field' | 'show_hub'; seatOf: readonly number[]; inputSlots: readonly number[]; humans: readonly boolean[] }
}

export type ShowSeatMetadata = { roomSeat: number; roundSeat: number; inputSlot: number; entity: number }
export type ShowOwnershipMetadata = { entity: number; zoneId: number; owner: number | null; group: number }
export type ShowSceneMetadata = {
  worldKind: 'show_seat' | 'show_field' | 'show_hub'
  seats: readonly ShowSeatMetadata[]
  ownership: readonly ShowOwnershipMetadata[]
}

// Show zone identity allocation (an internal convention implementing the G7.1 transfer contract, not a gameplay
// rule or wire format). Every value is computed and range-checked as an exact JS number before u32 conversion.
// - Physical seat anchor: id roomSeat+1 (1..60), numeric owner roundSeat, group roomSeat+1. The seat capsule is the
//   body of its own group, so nonphysical seat-owned children carrying the same group follow it through the engine's
//   zone create/rebuild belongs rule (the anchor's numeric owner selects the domain).
// - The seat's nonphysical child row (character references, bot memory and bot route) is id 61+roomSeat (61..120),
//   same owner and group as the anchor; the seat capsule stays the group's authoritative physical member.
// - G7.3 cumulative publishers use 65536+roomSeat*32+fieldRank (65536..67455 for rooms 0..59 and 19 fields) and team
//   contributions start at 131072; the scene emits the seat publishers and reserves the team range against collisions.
// - show_feature_membership rows: id 0x40000000+authoredFeatureIndex*64+roomSeat, owner roundSeat, group roomSeat+1,
//   with authoredFeatureIndex 0..16777215 and roomSeat 0..59. The interval 0x40000000..0x7fffffff is reserved
//   exclusively for these rows; the scene emits no template membership rows, so emitEngineScene refuses any emitted
//   zone id inside it. Rows are created at runtime by the owning feature scripts, which attach this identity
//   immediately and reuse a transferred row by authored feature index plus live character entity.
// Course features carry no zone identity and are never grouped with seats.
//
// show_control.code is an S1 wire code: the value 0 encodes both axes as -1 (a full diagonal), not neutral. The scene
// therefore seeds SHOW_CONTROL_NEUTRAL (32639, S1 neutral) rather than relying on the record's default of 0.
export const SHOW_ROOM_SEAT_LAST = 59
export const SHOW_CONTROL_NEUTRAL = 32639
export const SHOW_SEAT_CHILD_ZONE_FIRST = 61
export const SHOW_SEAT_CHILD_ZONE_LAST = 120
export const SHOW_PUBLISH_ZONE_FIRST = 65536
export const SHOW_PUBLISH_STRIDE = 32
export const SHOW_PUBLISH_FIELD_COUNT = 19
export const SHOW_PUBLISH_ZONE_LAST = SHOW_PUBLISH_ZONE_FIRST + (SHOW_ROOM_SEAT_LAST + 1) * SHOW_PUBLISH_STRIDE - 1
export const SHOW_TEAM_ZONE_FIRST = 131072
export const SHOW_MEMBERSHIP_ZONE_FIRST = 0x40000000
export const SHOW_MEMBERSHIP_ZONE_LAST = 0x7fffffff
export const SHOW_MEMBERSHIP_SEAT_STRIDE = 64
export const SHOW_MEMBERSHIP_FEATURE_LAST = 16777215
const NO_ENTITY = 0xffffffff

export type ShowZoneIdentity = { id: number; owner: number; group: number }

function seatIndex(value: number, field: string, path: string): void {
  if (!Number.isInteger(value) || value < 0 || value > SHOW_ROOM_SEAT_LAST) {
    refuse('ege-scene', `${path}/${field}`, `invalid ${field} ${value}; use an integer in 0..${SHOW_ROOM_SEAT_LAST}`)
  }
}

/**
 * Handoff: G7.1 Identity, inputs and world construction: assign complete scene ownership: showSeatZone returns the
 * physical seat anchor identity {id: roomSeat+1, owner: roundSeat, group: roomSeat+1} that seatAndDataEntities emits
 * today; the scene ownership entry point remains the Handoff at sceneEmitter.ts:481 emitEngineScene.
 */
export function showSeatZone(roomSeat: number, roundSeat: number, path = 'show/seat'): ShowZoneIdentity {
  seatIndex(roomSeat, 'roomSeat', path)
  seatIndex(roundSeat, 'roundSeat', path)
  return { id: (roomSeat + 1) >>> 0, owner: roundSeat >>> 0, group: (roomSeat + 1) >>> 0 }
}

/** Whether `id` lies in the interval reserved exclusively for show_feature_membership rows. */
export function isShowMembershipZoneId(id: number): boolean {
  return id >= SHOW_MEMBERSHIP_ZONE_FIRST && id <= SHOW_MEMBERSHIP_ZONE_LAST
}

/**
 * Handoff: G7.1 Identity, inputs and world construction: scale catch and swimming membership: showMembershipZone
 * validates and returns the ege.zone.id {id: 0x40000000+authoredFeatureIndex*64+roomSeat, owner: roundSeat,
 * group: roomSeat+1} of a seat-owned show_feature_membership row; the catch/swim scripts attach the same values to the
 * rows they create (owner and character = live character entity, index = authored feature index, feature = current
 * feature entity). The scene emits no such rows and refuses emitted ids in the reserved interval.
 */
export function showMembershipZone(authoredFeatureIndex: number, roomSeat: number, roundSeat: number, path = 'show/membership'): ShowZoneIdentity {
  if (!Number.isInteger(authoredFeatureIndex) || authoredFeatureIndex < 0 || authoredFeatureIndex > SHOW_MEMBERSHIP_FEATURE_LAST) {
    refuse('ege-scene', `${path}/authoredFeatureIndex`, `invalid authored feature index ${authoredFeatureIndex}; use an integer in 0..${SHOW_MEMBERSHIP_FEATURE_LAST}`)
  }
  const seat = showSeatZone(roomSeat, roundSeat, path)
  const id = SHOW_MEMBERSHIP_ZONE_FIRST + authoredFeatureIndex * SHOW_MEMBERSHIP_SEAT_STRIDE + roomSeat
  if (!Number.isSafeInteger(id) || !isShowMembershipZoneId(id)) {
    refuse('ege-scene', path, `membership zone id ${id} leaves the reserved interval; keep the feature index and room seat in range`)
  }
  return { id: id >>> 0, owner: seat.owner, group: seat.group }
}

/** The identity of a seat's nonphysical child row: id 61+roomSeat, same numeric owner and group as its anchor. */
export function showSeatChildZone(roomSeat: number, roundSeat: number, path = 'show/seat'): ShowZoneIdentity {
  const seat = showSeatZone(roomSeat, roundSeat, path)
  return { id: (SHOW_SEAT_CHILD_ZONE_FIRST + roomSeat) >>> 0, owner: seat.owner, group: seat.group }
}

/** Whether `id` lies in the seat-cumulative publisher interval emitted by complete scene ownership. */
export function isShowPublishZoneId(id: number): boolean {
  return id >= SHOW_PUBLISH_ZONE_FIRST && id <= SHOW_PUBLISH_ZONE_LAST
}

/**
 * The identity of one of a seat's nineteen cumulative publishers: id 65536+roomSeat*32+fieldRank, numeric owner
 * roundSeat and the anchor's group. The publish script writes the field value only through this stable child.
 */
export function showPublishZone(roomSeat: number, fieldRank: number, roundSeat: number, path = 'show/publish'): ShowZoneIdentity {
  const seat = showSeatZone(roomSeat, roundSeat, path)
  if (!Number.isInteger(fieldRank) || fieldRank < 0 || fieldRank >= SHOW_PUBLISH_FIELD_COUNT) {
    refuse('ege-scene', `${path}/fieldRank`, `invalid field rank ${fieldRank}; use an integer in 0..${SHOW_PUBLISH_FIELD_COUNT - 1}`)
  }
  const id = SHOW_PUBLISH_ZONE_FIRST + roomSeat * SHOW_PUBLISH_STRIDE + fieldRank
  return { id: id >>> 0, owner: seat.owner, group: seat.group }
}

export interface EmittedScene {
  show?: ShowSceneMetadata
  courseId: string
  assembly: EgeAssembly
  text: string
  scene: EgeScene
  seatEntities: number[]
  obstacleEntities: number[]
  itemBodies: ReadonlyMap<string, number>
  featureEntities: number[]
  index(name: string): number
}

const ROUND_KIND_RANK: Readonly<Record<LevelSpec['kind'], number>> = {
  race: 0,
  survival: 1,
  team: 2,
  collection: 3,
  hunt: 4,
  logic: 5,
  final: 6,
}

const FINAL_RULE_RANK = { none: 0, crown: 1, lastStanding: 2 } as const
const RESPAWN_MODE_RANK = { checkpoint: 0, home: 1, none: 2 } as const
const point = (v: { x: number; y: number; z: number }): [number, number, number] => [v.x, v.y, v.z]
const tuple = (v: { x: number; y: number; z: number; w?: number }): number[] =>
  v.w === undefined ? [v.x, v.y, v.z] : [v.x, v.y, v.z, v.w]

const SURFACE_RANK: Readonly<Record<Surface, number>> = { normal: 0, ice: 1, mud: 2, rubber: 3 }

function unscaleColliders(list: readonly ColliderSpec[], s: { x: number; y: number; z: number }): ColliderSpec[] {
  return list.map((c): ColliderSpec => {
    const t = { x: c.t.x / s.x, y: c.t.y / s.y, z: c.t.z / s.z }
    if (c.shape === 'cuboid') return { ...c, half: { x: c.half.x / s.x, y: c.half.y / s.y, z: c.half.z / s.z }, t }
    if (c.shape === 'roundCuboid') return { ...c, half: { x: c.half.x / s.x, y: c.half.y / s.y, z: c.half.z / s.z }, border: c.border / Math.min(s.x, s.y, s.z), t }
    if (c.shape === 'convexHull') return c
    const k = s.x
    return { ...c, radius: c.radius / k, ...('halfHeight' in c ? { halfHeight: c.halfHeight / k } : {}), t }
  })
}

function obstacleSurface(kind: Surface | undefined, friction: number, obstacle: number) {
  return { kind: SURFACE_RANK[kind ?? 'normal'], friction, obstacle }
}

function itemBodyNames(sim: ResolvedCourse): { name: string; friction: number; surface: Surface }[] {
  const out: { name: string; friction: number; surface: Surface }[] = []
  for (const item of sim.mechanisms?.items ?? []) {
    for (const body of item.bodies) {
      out.push({ name: `${item.id}/${body.id}`, friction: body.friction, surface: body.surface })
    }
  }
  return out
}

function obstacleParts(input: EmitInput, sim: ResolvedCourse): {
  items: AssemblyItem[]
  movers: MoverJson[]
  extras: AssemblyExtra[]
} {
  const rawObstacles = input.course.json.obstacles
  const items: AssemblyItem[] = []
  if (Array.isArray(rawObstacles)) {
    for (let i = 0; i < rawObstacles.length; i++) {
      const value = rawObstacles[i]
      if (typeof value !== 'object' || value === null) continue
      const obstacle = value as Record<string, unknown>
      const id = obstacle.id
      const assetId = obstacle.asset
      const resolved = typeof assetId === 'string' ? input.assets.get(assetId) : undefined
      if (typeof id !== 'string' || typeof assetId !== 'string' || !resolved?.asset.physics) continue
      const collision = resolved.source.json && typeof resolved.source.json === 'object'
        ? (resolved.source.json as Record<string, unknown>).collision
        : undefined
      const t = obstacle.t as [number, number, number]
      const r = obstacle.r as [number, number, number, number]
      const s = obstacle.s as [number, number, number]
      items.push({
        id, asset: assetId, t, r, s,
        collision: assetColliders(Array.isArray(collision) ? collision : [], `courses/${input.course.id}.course.json#/obstacles/${i}/colliders`),
        physics: resolved.asset.physics,
      })
    }
  }
  const movers: MoverJson[] = []
  const extras: AssemblyExtra[] = []
  for (let i = 0; i < sim.obstacles.length; i++) {
    const obstacle = sim.obstacles[i]
    const name = `movers/${obstacle.id}`
    movers.push({
      id: obstacle.id,
      t: tuple(obstacle.t) as [number, number, number],
      r: tuple(obstacle.r) as [number, number, number, number],
      s: tuple(obstacle.s) as [number, number, number],
      friction: obstacle.friction,
      colliders: engineColliders(unscaleColliders(obstacle.colliders, obstacle.s),
        `courses/${input.course.id}.course.json#/obstacles/${i}/colliders`),
      motion: obstacle.motion,
      ...(obstacle.sweep === undefined ? {} : { sweep: obstacle.sweep }),
    })
    extras.push({ entity: name, components: {
      'ege.render': { shape: 0 },
      surface: obstacleSurface(obstacle.surface, obstacle.friction, i),
    } })
  }
  for (const body of itemBodyNames(sim)) {
    extras.push({ entity: body.name, components: {
      'ege.render': { shape: 0 },
      surface: obstacleSurface(body.surface, body.friction, -1),
    } })
  }
  return { items, movers, extras }
}

function featureEntities(input: EmitInput, sim: ResolvedCourse): RawEntity[] {
  const entities: RawEntity[] = []
  const features = sim.features ?? []
  for (let i = 0; i < features.length; i++) {
    const spec = features[i]
    const emitter = FEATURE_EMITTERS[spec.kind]
    if (!emitter) {
      const registered = Object.keys(FEATURE_EMITTERS).sort()
      refuse('ege-scene', `courses/${input.course.id}.course.json#/features/${i}/kind`,
        `feature kind '${spec.kind}' has no engine emitter; registered: ${registered.length ? registered.join(', ') : '(none)'}`)
    }
    const emitted = emitter(spec, { course: sim, index: i, path: `courses/${input.course.id}.course.json`, assets: input.assets, seatCount: input.show?.seatOf.length ?? 8, worldKind: input.show?.worldKind ?? RF_EGE_WORLD_KIND })
    entities.push(emitted.root, ...emitted.children)
  }
  return entities
}

function validateShow(input: EmitInput): void {
  const show = input.show
  if (!show) return
  const path = `courses/${input.course.id}.course.json#/show`
  if (!['show_seat', 'show_field', 'show_hub'].includes(show.worldKind)) refuse('ege-scene', `${path}/worldKind`, 'invalid world kind; select a show world')
  if (show.seatOf.length !== show.inputSlots.length || show.seatOf.length !== show.humans.length) refuse('ege-scene', path, 'roster lengths differ; provide one input slot and human flag per seat')
  const slots = new Set<number>()
  let previous = -1
  for (let i = 0; i < show.seatOf.length; i++) {
    const room = show.seatOf[i], slot = show.inputSlots[i], human = show.humans[i]
    if (!Number.isInteger(room) || room < 0 || room > 59 || room <= previous) refuse('ege-scene', `${path}/seatOf/${i}`, 'invalid or unordered room seat; provide unique ascending seats in 0..59')
    if (typeof human !== 'boolean' || !Number.isInteger(slot) || (human ? slot < 0 || slot > (show.worldKind === 'show_hub' ? 0 : 7) || slots.has(slot) : slot !== -1)) refuse('ege-scene', `${path}/inputSlots/${i}`, 'invalid or duplicate human slot; use unique supported slots for humans and -1 for bots')
    if (human) slots.add(slot)
    previous = room
  }
}

function seatAndDataEntities(input: EmitInput, sim: ResolvedCourse, level: LevelSpec): RawEntity[] {
  const entities: RawEntity[] = []
  const capsule = input.capsule ?? CAPSULE
  const seatEntities: number[] = []
  for (let i = 0; i < (input.show?.seatOf.length ?? 8); i++) {
    const spawn = seatSpawn(sim, i)
    const seatEntity = entities.length
    seatEntities.push(seatEntity)
    entities.push({
      name: `seat/${i}`,
      body: { type: 'dynamic', gravity_scale: 0, can_sleep: false, ccd: false },
      colliders: [{
        shape: 'capsule',
        radius: capsule.radius,
        half_height: capsule.halfHeight,
        density: 0,
        friction: 0,
        restitution: 0,
        group: 'char',
      }],
      components: {
        ...(input.show ? {
          'ege.zone.id': showSeatZone(input.show.seatOf[i], i, `courses/${input.course.id}.course.json#/show/seatOf/${i}`),
          show_seat_identity: { room_seat: input.show.seatOf[i], round_seat: i, input_slot: input.show.inputSlots[i], bot: input.show.humans[i] ? 0 : 1 },
          show_control: { code: SHOW_CONTROL_NEUTRAL },
          show_result_a: { seat: i, status: 1, finish_tick: -1, finish_sub: -1, lap: 0, stage: -1, route_mm: 0, falls: 0, score: 0, last_score_tick: -1 },
          show_result_b: { hold_ticks: 0, possessing: 0, last_acquire_tick: -1, matches: 0, cross_ticks: 0, out_tick: -1, out_sub: -1, team: -1, opening_rank: -1 },
        } : {}),
        'ege.transform': { pos: point(spawn.t), rot: [0, 0, 0, 1] },
        'ege.render': { shape: 0 },
        'ege.body_props': {
          lock_rotations: 1,
          additional_mass: CHAR.mass,
          friction_combine: 1,
          groups_override: 0,
          memberships: 0,
          filter: 0,
          colliders_enabled: 1,
        },
        'ege.contacts': {
          count: 0,
          other: [0, 0, 0, 0],
          normal: Array(12).fill(0),
          point: Array(12).fill(0),
          depth: [0, 0, 0, 0],
        },
        seat: {
          seat: i,
          player: i,
          status: 1,
          team: level.teams === null ? 0 : i % 2,
          spawn: i,
          spawn_t: point(spawn.t),
          spawn_facing: [spawn.facing.x, spawn.facing.z],
          checkpoint: -1 - i,
          stage: -1,
          wait_until: -1,
          protect_until: -1,
        },
        character: {
          mode: 1,
          placed: 0,
          protected_until: -1,
          facing: [spawn.facing.x, spawn.facing.z],
          radius: capsule.radius,
          half_height: capsule.halfHeight,
          stand: capsule.stand,
        },
      },
    })
  }
  if (input.show) {
    const show = input.show
    for (let i = 0; i < show.seatOf.length; i++) {
      const seatEntity = seatEntities[i]
      entities.push({
        name: `show/seat/${i}`,
        components: {
          'ege.zone.id': showSeatChildZone(show.seatOf[i], i, `courses/${input.course.id}.course.json#/show/seatOf/${i}`),
          show_character_ref: { owner: seatEntity, target: NO_ENTITY, lever: NO_ENTITY, carry: NO_ENTITY },
          ...(show.humans[i] ? {} : {
            bot_memory: {
              owner: seatEntity,
              rng_state: input.setup.seed >>> 0,
              ticks: 0,
              wait_ticks: 0,
              path_index: 0,
              stuck_ticks: 0,
              last_x: 0,
              last_z: 0,
              wobble: 0,
            },
            bot_route: {
              owner: seatEntity,
              preference: 0,
              seed: 0,
              plan_tick: -1,
              next_plan_tick: 0,
              cost: 0,
              reachable: 0,
              region_count: 0,
              edge_count: 0,
              waypoint_count: 0,
            },
          }),
        },
      })
    }
    // The rules world owns no live seats and the hub has no competitive ledger, so only the two playable show kinds
    // publish. Each seat's nineteen cumulative fields are nonphysical children of its anchor group, one stable id each.
    if (show.worldKind !== 'show_hub') {
      for (let i = 0; i < show.seatOf.length; i++) {
        for (let field = 0; field < SHOW_PUBLISH_FIELD_COUNT; field++) {
          entities.push({
            name: `show/publish/${i}/${field}`,
            components: {
              'ege.zone.id': showPublishZone(show.seatOf[i], field, i, `courses/${input.course.id}.course.json#/show/seatOf/${i}`),
            },
          })
        }
      }
    }
  }
  for (let i = 0; i < sim.checkpoints.length; i++) {
    const gate = sim.checkpoints[i]
    entities.push({
      name: `gate/${i}`,
      components: {
        gate: {
          index: i,
          stage: level.route.stages[i] ?? -1,
          center: point(gate.box.center),
          half: point(gate.box.half),
          respawn_t: point(gate.respawn.t),
          respawn_facing: [gate.respawn.facing.x, gate.respawn.facing.z],
          cursor: 0,
        },
      },
    })
  }
  for (let i = 0; i < sim.spawns.length; i++) {
    const spawn = sim.spawns[i]
    entities.push({
      name: `spawn/${i}`,
      components: { spawn: { index: i, t: point(spawn.t), facing: [spawn.facing.x, spawn.facing.z] } },
    })
  }
  for (let i = 0; i < level.homes.length; i++) {
    const home = level.homes[i]
    entities.push({
      name: `home/${i}`,
      components: {
        home: {
          index: i,
          team: home.team,
          center: point(home.box.center),
          half: point(home.box.half),
          cursor: 0,
        },
      },
    })
    for (let k = 0; k < home.respawn.length; k++) {
      const spawn = home.respawn[k]
      entities.push({
        name: `home/${i}/spawn/${k}`,
        components: {
          home_spawn: { home: i, index: k, t: point(spawn.t), facing: [spawn.facing.x, spawn.facing.z] },
        },
      })
    }
  }
  for (let i = 0; i < sim.path.length; i++) {
    const node = sim.path[i]
    entities.push({
      name: `path/${i}`,
      components: { path_node: { index: i, p: point(node.p), jump: node.jump ? 1 : 0, dive: node.dive ? 1 : 0 } },
    })
  }
  return entities
}

function resources(input: EmitInput, sim: ResolvedCourse, level: LevelSpec): Record<string, Record<string, number | number[]>> {
  const finish = sim.finish
  const stages = level.route.stages
  return {
    round: {
      intro_ticks: PROFILES[input.setup.profile].introTicks,
      round_ticks: level.timeCapTicks,
      overtime_ticks: level.overtimeTicks,
      kind: ROUND_KIND_RANK[level.kind],
      final_rule: FINAL_RULE_RANK[level.finalRule ?? 'none'],
      phase: 0,
      frozen: 0,
      ended_tick: -1,
      entrants: input.show?.seatOf.length ?? 8,
      alive: 0,
      qualified: 0,
      eliminated: 0,
      trailing_team: -1,
    },
    course: {
      kill_plane_y: sim.killPlaneY,
      has_finish: finish === null ? 0 : 1,
      finish_center: finish === null ? [0, 0, 0] : point(finish.center),
      finish_half: finish === null ? [0, 0, 0] : point(finish.half),
      checkpoint_count: sim.checkpoints.length,
      spawn_count: sim.spawns.length,
      home_count: level.homes.length,
      path_count: sim.path.length,
      respawn_mode: RESPAWN_MODE_RANK[level.respawn.mode],
      wait_ticks: level.respawn.waitTicks,
      protect_ticks: level.respawn.protectTicks,
      slots: level.respawn.slots,
      spacing_m: level.respawn.spacingM,
      ordered: level.route.ordered ? 1 : 0,
      laps: level.route.laps,
      stage_count: stages.length,
      last_stage: stages.length === 0 ? -1 : stages[stages.length - 1],
      grab_players: level.grab.players ? 1 : 0,
      grab_objects: level.grab.objects ? 1 : 0,
    },
  }
}

/**
 * Handoff: Scene emitter part 2: obstacles, mechanisms, extras and features extends buildEngineAssembly; this function
 * currently emits the world, resources, seats and course-data entities. `EmittedScene.obstacleEntities`,
 * `EmittedScene.itemBodies` and `EmittedScene.featureEntities` are empty.
 */
export function buildEngineAssembly(input: EmitInput): EgeAssembly {
  validateShow(input)
  const sim = input.course.sim
  if (sim === null) {
    refuse(
      'ege-scene',
      `courses/${input.course.id}.course.json`,
      `the course has no simulation part (kind ${input.course.kind}); pass a race, survival, hub or gallery course`,
    )
  }
  const level = sim.level ?? legacyLevel(sim)
  const obstacles = obstacleParts(input, sim)
  const rawMechanisms = input.course.json.mechanisms
  return buildAssembly({
    worldKind: input.show?.worldKind ?? RF_EGE_WORLD_KIND,
    seed: input.setup.seed >>> 0,
    gravity: [0, GRAVITY_Y, 0],
    resources: resources(input, sim, level),
    entities: [...seatAndDataEntities(input, sim, level), ...featureEntities(input, sim)],
    items: obstacles.items,
    movers: obstacles.movers,
    extras: obstacles.extras,
    ...(rawMechanisms === undefined || rawMechanisms === null ? {} : { mechanisms: rawMechanisms as EgeAssembly['mechanisms'] }),
  })
}

function expectedSeatRow(ownership: readonly ShowOwnershipMetadata[], entity: number, expected: ShowZoneIdentity, label: string): void {
  const found = ownership.find(row => row.entity === entity)
  if (!found || found.zoneId !== expected.id || found.owner !== expected.owner || found.group !== expected.group) {
    refuse('ege-scene', `entities/${entity}/components/ege.zone.id`, `${label} has no seat-owned identity; emit id ${expected.id}, owner ${expected.owner}, group ${expected.group}`)
  }
}

/**
 * The copied ownership metadata of a converted show scene, in scene entity order: one row per actual ege.zone.id
 * record (`entity` is the template scene index, not a live handle). Refuses invalid or duplicate ids, ids in another
 * family's reserved interval, a seat or seat child whose record differs from the allocation, and a nonzero group
 * without a physical member. `featureCount` reserves the G7.3 team-publisher interval for the authored features.
 */
export function showSceneOwnership(scene: EgeScene, seatOf: readonly number[], featureCount = 0): ShowOwnershipMetadata[] {
  const ownership: ShowOwnershipMetadata[] = []
  const zoneIds = new Set<number>()
  const physicalGroups = new Set<number>()
  for (const [entity, row] of scene.entities.entries()) {
    const zone = row.components?.['ege.zone.id']
    if (!zone) continue
    const { id, owner, group } = zone
    const at = `entities/${entity}/components/ege.zone.id`
    if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0 || id > 0xffffffff || zoneIds.has(id) ||
        typeof owner !== 'number' || !Number.isInteger(owner) || owner < 0 || owner > 0xffffffff ||
        typeof group !== 'number' || !Number.isInteger(group) || group < 0 || group > 0xffffffff) {
      refuse('ege-scene', at, 'invalid or duplicate zone identity; provide unique nonzero u32 ids and u32 owner and group')
    }
    if (isShowMembershipZoneId(id)) {
      refuse('ege-scene', `${at}/id`, `zone id ${id} conflicts with the show_feature_membership interval ${SHOW_MEMBERSHIP_ZONE_FIRST}..${SHOW_MEMBERSHIP_ZONE_LAST}; emit ids below ${SHOW_MEMBERSHIP_ZONE_FIRST}`)
    }
    if (id >= SHOW_SEAT_CHILD_ZONE_FIRST && id <= SHOW_SEAT_CHILD_ZONE_LAST) {
      const roomSeat = id - SHOW_SEAT_CHILD_ZONE_FIRST
      const roundSeat = seatOf.indexOf(roomSeat)
      const expected = roundSeat < 0 ? null : showSeatChildZone(roomSeat, roundSeat)
      if (!expected || owner !== expected.owner || group !== expected.group) {
        refuse('ege-scene', at, `zone id ${id} is not a valid seat-child identity; use id ${SHOW_SEAT_CHILD_ZONE_FIRST}+roomSeat with its round-seat owner and anchor group`)
      }
    }
    if (isShowPublishZoneId(id)) {
      const offset = id - SHOW_PUBLISH_ZONE_FIRST
      const roomSeat = Math.floor(offset / SHOW_PUBLISH_STRIDE)
      const field = offset % SHOW_PUBLISH_STRIDE
      const roundSeat = seatOf.indexOf(roomSeat)
      if (roundSeat < 0 || field >= SHOW_PUBLISH_FIELD_COUNT) {
        refuse('ege-scene', at, `zone id ${id} is not a valid seat-cumulative publisher; use ${SHOW_PUBLISH_ZONE_FIRST}+roomSeat*${SHOW_PUBLISH_STRIDE}+field for an emitted seat and field 0..${SHOW_PUBLISH_FIELD_COUNT - 1}`)
      }
      const expected = showPublishZone(roomSeat, field, roundSeat)
      if (owner !== expected.owner || group !== expected.group) {
        refuse('ege-scene', at, `zone id ${id} is not a valid seat-cumulative publisher; use its round-seat owner ${expected.owner} and anchor group ${expected.group}`)
      }
    }
    if (featureCount > 0 && id >= SHOW_TEAM_ZONE_FIRST && id < SHOW_TEAM_ZONE_FIRST + featureCount * SHOW_PUBLISH_STRIDE) {
      refuse('ege-scene', at, `zone id ${id} conflicts with the team contribution publisher interval ${SHOW_TEAM_ZONE_FIRST}..${SHOW_TEAM_ZONE_FIRST + featureCount * SHOW_PUBLISH_STRIDE - 1}; the scene emits no template team publishers`)
    }
    zoneIds.add(id)
    if (row.body) physicalGroups.add(group)
    ownership.push({ entity, zoneId: id, owner: owner === 0xffff ? null : owner, group })
  }
  for (const row of ownership) {
    if (row.group !== 0 && !physicalGroups.has(row.group)) {
      refuse('ege-scene', `entities/${row.entity}/components/ege.zone.id/group`, `group ${row.group} has no physical anchor; give the authoritative seat or feature body the same group`)
    }
  }
  for (const [roundSeat, roomSeat] of seatOf.entries()) {
    const anchor = scene.entities.findIndex(row => row.name === `seat/${roundSeat}`)
    expectedSeatRow(ownership, anchor, showSeatZone(roomSeat, roundSeat), `seat ${roomSeat}`)
    const child = scene.entities.findIndex(row => row.name === `show/seat/${roundSeat}`)
    expectedSeatRow(ownership, child, showSeatChildZone(roomSeat, roundSeat), `seat ${roomSeat} child`)
  }
  return ownership
}

/**
 * Handoff: G7.1 Identity, inputs and world construction: assign complete scene ownership: emitEngineScene
 * (engine: EngineInstance, input: EmitInput): EmittedScene, exported here, attaches copied metadata after
 * assembly conversion; scene entities and their ege.zone.id records provide the state and keys.
 */
export function emitEngineScene(engine: EngineInstance, input: EmitInput): EmittedScene {
  const assembly = buildEngineAssembly(input)
  const built = assemblyScene(engine, assembly)
  const sim = input.course.sim!
  const bodies = itemBodyNames(sim)
  const seatEntities = Array.from({ length: input.show?.seatOf.length ?? 8 }, (_, i) => built.index(`seat/${i}`))
  let text = built.text
  if (input.show) {
    // Entity-typed child references are resolved against the converted scene, never a pre-conversion index: rebuild
    // them from the seat's scene name and mirror a real change back into the assembly the caller receives.
    let remapped = false
    for (let i = 0; i < input.show.seatOf.length; i++) {
      const seat = built.index(`seat/${i}`)
      const child = built.index(`show/seat/${i}`)
      const components = built.scene.entities[child]?.components
      if (!components) continue
      for (const name of ['show_character_ref', 'bot_memory', 'bot_route']) {
        const record = components[name]
        if (record !== undefined && typeof record.owner === 'number' && record.owner !== seat) {
          record.owner = seat
          remapped = true
        }
      }
    }
    if (remapped) {
      text = JSON.stringify(built.scene)
      const patched = new Map(built.scene.entities.flatMap((row, index) => row.name === undefined ? [] : [[row.name, index] as const]))
      for (const entity of (assembly.entities ?? []) as { name?: unknown; components?: unknown }[]) {
        if (typeof entity.name !== 'string') continue
        const index = patched.get(entity.name)
        if (index !== undefined) entity.components = built.scene.entities[index].components
      }
    }
  }
  const featureCount = sim.features?.length ?? 0
  const ownership = input.show ? showSceneOwnership(built.scene, input.show.seatOf, featureCount) : []
  return {
    ...(input.show ? { show: { worldKind: input.show.worldKind, seats: input.show.seatOf.map((roomSeat, roundSeat) => ({ roomSeat, roundSeat, inputSlot: input.show!.inputSlots[roundSeat], entity: seatEntities[roundSeat] })), ownership } } : {}),
    courseId: input.course.id,
    assembly,
    text,
    scene: built.scene,
    seatEntities,
    obstacleEntities: sim.obstacles.map(obstacle => built.index(`movers/${obstacle.id}`)),
    itemBodies: new Map(bodies.map(body => [body.name, built.index(body.name)])),
    featureEntities: (sim.features ?? []).map(feature => built.index(`feature/${feature.id}`)),
    index: built.index,
  }
}
