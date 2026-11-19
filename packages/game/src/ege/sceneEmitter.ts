import type { EgeScene, EngineInstance } from '@etcito/game-engine'
import { assemblyScene, buildAssembly } from '@etcito/game-engine/formats'
import type { EgeAssembly } from '@etcito/game-engine/formats'
import type { LevelSpec, ProfileName, ResolvedCourse } from '@royal-fiesta/sim/course'
import { legacyLevel } from '@royal-fiesta/sim/course'
import { CAPSULE } from '@royal-fiesta/sim/character/capsule'
import type { CharacterCapsule } from '@royal-fiesta/sim/character/capsule'
import { CHAR } from '@royal-fiesta/sim/character/constants'
import { GRAVITY_Y } from '@royal-fiesta/sim/world'
import { PROFILES } from '@royal-fiesta/sim/match/setup'
import { refuse } from '@royal-fiesta/sim/refusal'
import { seatSpawn } from '@royal-fiesta/sim/zones/seatSpawn'
import type { CourseV1, ResolvedGameAsset } from '../courseV1.ts'
import { RF_EGE_WORLD_KIND } from './files.ts'
import type { RawEntity } from './featureEmitters.ts'

export interface EmitInput {
  course: CourseV1
  assets: ReadonlyMap<string, ResolvedGameAsset>
  capsule?: CharacterCapsule
  setup: { profile: ProfileName; seed: number }
}

export interface EmittedScene {
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

function seatAndDataEntities(input: EmitInput, sim: ResolvedCourse, level: LevelSpec): RawEntity[] {
  const entities: RawEntity[] = []
  const capsule = input.capsule ?? CAPSULE
  for (let i = 0; i < 8; i++) {
    const spawn = seatSpawn(sim, i)
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
      entrants: 8,
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
  const sim = input.course.sim
  if (sim === null) {
    refuse(
      'ege-scene',
      `courses/${input.course.id}.course.json`,
      `the course has no simulation part (kind ${input.course.kind}); pass a race, survival, hub or gallery course`,
    )
  }
  const level = sim.level ?? legacyLevel(sim)
  return buildAssembly({
    worldKind: RF_EGE_WORLD_KIND,
    seed: input.setup.seed >>> 0,
    gravity: [0, GRAVITY_Y, 0],
    resources: resources(input, sim, level),
    entities: seatAndDataEntities(input, sim, level),
  })
}

export function emitEngineScene(engine: EngineInstance, input: EmitInput): EmittedScene {
  const assembly = buildEngineAssembly(input)
  const built = assemblyScene(engine, assembly)
  return {
    courseId: input.course.id,
    assembly,
    text: built.text,
    scene: built.scene,
    seatEntities: Array.from({ length: 8 }, (_, i) => built.index(`seat/${i}`)),
    obstacleEntities: [],
    itemBodies: new Map(),
    featureEntities: [],
    index: built.index,
  }
}
