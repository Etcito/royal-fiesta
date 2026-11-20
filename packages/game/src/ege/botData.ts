// G7.3: authored bot navigation and behaviour serialization for the engine scene.
// The rows copy validated course data only: no route search, brain evaluation or gameplay geometry runs here.
// Entity-typed values are indices into the returned array, so a scene may place the whole list before any seats
// (the rules of a behaviour point at its behaviour row, and each edge points at its region row). Non-seat
// authored data has no owner: NO_ENTITY leaves it untouched by the engine's transfer remapping.

import {
  BOT_ACTIONS,
  BOT_PREDICATES,
  ROUTE_PREFERENCES,
  bindBehaviour,
  parseBehaviour,
} from '@royal-fiesta/sim/bots/behaviour'
import type { BotBehaviour } from '@royal-fiesta/sim/bots/behaviour'
import { regionOf } from '@royal-fiesta/sim/course'
import type { ResolvedCourse } from '@royal-fiesta/sim/course'
import { refuse } from '@royal-fiesta/sim/refusal'
import type { RawEntity } from './featureEmitters.ts'

const NO_ENTITY = 0xffffffff

// Record ranks are the declaration order of the v0 authoring enums: BOT_PREDICATES (always..nearFinish),
// BOT_ACTIONS (jump..useLever) and ROUTE_PREFERENCES (short, safe).
function rank<T extends string>(values: readonly T[], value: T): number {
  return values.indexOf(value)
}

function point(v: { x: number; y: number; z: number }): [number, number, number] {
  return [v.x, v.y, v.z]
}

// A parsed BotBehaviour writes absent optional conditions as null; parseBehaviour accepts them only when absent,
// so re-validation restores the authored shape before reading the validated values.
function plainRule(rule: unknown): unknown {
  if (typeof rule !== 'object' || rule === null || Array.isArray(rule)) return rule
  const copy = { ...(rule as Record<string, unknown>) }
  if (copy.phase === null) delete copy.phase
  if (copy.distance === null) delete copy.distance
  return copy
}

function revalidated(value: BotBehaviour, source: string): BotBehaviour {
  const raw = { ...(value as unknown as Record<string, unknown>) }
  if (Array.isArray(raw.rules)) raw.rules = raw.rules.map(plainRule)
  return parseBehaviour(raw, source)
}

function signalIndex(course: ResolvedCourse, name: string, path: string, field: string): number {
  const index = course.mechanisms?.signals.indexOf(name) ?? -1
  if (index < 0) {
    refuse('ege-bots', `${path}/${field}`,
      `unknown signal '${name}'; use a switch, lever or logic id of the course mechanisms`)
  }
  return index
}

function pullIndex(course: ResolvedCourse, name: string, path: string, field: string): number {
  const lever = course.mechanisms?.levers.some(entry => entry.id === name) ?? false
  if (!lever) {
    refuse('ege-bots', `${path}/${field}`,
      `unknown lever '${name}'; use a lever id of the course mechanisms`)
  }
  return signalIndex(course, name, path, field)
}

/**
 * Serializes the authored navigation and every validated behaviour into engine scene rows.
 * Behaviour structure comes from parseBehaviour and course binding from bindBehaviour, so malformed
 * required data and a useLever rule without a lever refuse with the authoring path and a repair.
 */
export function serializeBotData(
  course: ResolvedCourse,
  behaviours: readonly BotBehaviour[],
): readonly RawEntity[] {
  const source = `courses/${course.id}.course.json`
  const bound = behaviours.map((behaviour, index) =>
    bindBehaviour(revalidated(behaviour, `behaviours/${course.id}/${index}`), {
      id: course.id,
      levers: course.mechanisms?.levers ?? [],
    }))

  const entities: RawEntity[] = []
  const regionBase = entities.length
  for (let index = 0; index < course.regions.length; index++) {
    const region = course.regions[index]
    entities.push({
      name: `show/nav/region/${index}`,
      components: {
        show_nav_region: {
          owner: NO_ENTITY,
          index,
          region: region.id,
          center: point(region.box.center),
          half: point(region.box.half),
          adjacent_count: region.adjacent.length,
        },
      },
    })
  }
  for (let regionIndex = 0; regionIndex < course.regions.length; regionIndex++) {
    const adjacent = course.regions[regionIndex].adjacent
    for (let edgeIndex = 0; edgeIndex < adjacent.length; edgeIndex++) {
      entities.push({
        name: `show/nav/edge/${regionIndex}/${edgeIndex}`,
        components: {
          show_nav_edge: {
            owner: regionBase + regionIndex,
            region_index: regionIndex,
            edge_index: edgeIndex,
            adjacent: adjacent[edgeIndex],
          },
        },
      })
    }
  }
  for (let index = 0; index < course.path.length; index++) {
    const node = course.path[index]
    const path = `${source}#/path/${index}`
    entities.push({
      name: `show/nav/node/${index}`,
      components: {
        show_nav_node: {
          owner: NO_ENTITY,
          index,
          p: point(node.p),
          jump: node.jump ? 1 : 0,
          dive: node.dive ? 1 : 0,
          region: regionOf(course, node.p),
          wait_signal: node.wait === undefined ? -1 : signalIndex(course, node.wait, path, 'wait'),
          pull_signal: node.pull === undefined ? -1 : pullIndex(course, node.pull, path, 'pull'),
        },
      },
    })
  }

  const behaviourBase = entities.length
  for (let index = 0; index < bound.length; index++) {
    const behaviour = bound[index]
    entities.push({
      name: `show/bot/behaviour/${index}`,
      components: {
        bot_behaviour: {
          owner: NO_ENTITY,
          index,
          decision_ticks: behaviour.tick.decisionTicks,
          reaction_ticks: behaviour.tick.reactionTicks,
          wobble_ticks: behaviour.tick.wobbleTicks,
          stuck_ticks: behaviour.tick.stuckTicks,
          preference: rank(ROUTE_PREFERENCES, behaviour.route.preference),
          advance_m: behaviour.route.advanceDist,
          arrive_m: behaviour.route.arriveDist,
          rule_count: behaviour.rules.length,
        },
      },
    })
  }
  for (let behaviourIndex = 0; behaviourIndex < bound.length; behaviourIndex++) {
    const behaviour = bound[behaviourIndex]
    const owner = behaviourBase + behaviourIndex
    for (let index = 0; index < behaviour.rules.length; index++) {
      const rule = behaviour.rules[index]
      entities.push({
        name: `show/bot/rule/${behaviourIndex}/${index}`,
        components: {
          bot_rule: {
            owner,
            behaviour: owner,
            index,
            predicate: rank(BOT_PREDICATES, rule.predicate),
            action: rank(BOT_ACTIONS, rule.action),
            has_phase: rule.phase === null ? 0 : 1,
            phase_from: rule.phase === null ? 0 : rule.phase.from,
            phase_to: rule.phase === null ? 0 : rule.phase.to,
            has_distance: rule.distance === null ? 0 : 1,
            distance_m: rule.distance === null ? 0 : rule.distance,
          },
        },
      })
    }
  }
  return entities
}
