import type { WorldState } from '@etcito/game-engine/world-state'
import type { CharState } from '@royal-fiesta/sim/character/system'
import { PlayerStatus } from '@royal-fiesta/sim/match/roundSystem'
import type { PlayerStatusValue } from '@royal-fiesta/sim/match/roundSystem'
import { refuse } from '@royal-fiesta/sim/refusal'
import type { EmittedScene } from './sceneEmitter.ts'

export type RoundPhase = 'intro' | 'playing' | 'overtime' | 'ended'

export interface CharObservation extends CharState {
  seat: number
  entity: number
  status: PlayerStatusValue
}

export interface RoundObservation {
  tick: number
  phase: RoundPhase
  alive: number
  qualified: number
  eliminated: number
  seats: CharObservation[]
  faults: number
  events: Record<string, number>
}

/**
 * Handoff: Engine round runtime with DomainBot inputs uses observeRound's decoded snapshot and
 * charStateOf's CharState projection; today observeRound reads eight scene seats and round.phase.
 */
export function observeRound(
  state: WorldState,
  scene: EmittedScene,
  faults: number,
  events: Record<string, number>,
): RoundObservation {
  const phaseNames: RoundPhase[] = ['intro', 'playing', 'overtime', 'ended']
  const phaseRank = state.resources.round?.phase
  if (typeof phaseRank !== 'number' || !phaseNames[phaseRank]) {
    refuse('ege-round', 'round/phase', `unknown phase ${String(phaseRank)}`)
  }

  const seats: CharObservation[] = []
  let alive = 0
  let qualified = 0
  let eliminated = 0
  for (let seat = 0; seat < 8; seat++) {
    const entity = scene.seatEntities[seat]
    const key = String(entity)
    const seatRecord = state.components.seat?.[key]
    if (!seatRecord) refuse('ege-round', `seat/${seat}`, `entity ${entity} has no seat record; emit the scene with emitEngineScene`)
    const character = state.components.character?.[key]
    if (!character) refuse('ege-round', `seat/${seat}`, `entity ${entity} has no character record; emit the scene with emitEngineScene`)
    const transform = state.components['ege.transform']?.[key]
    if (!transform) refuse('ege-round', `seat/${seat}`, `entity ${entity} has no transform record`)
    const velocity = state.components['ege.velocity']?.[key]
    const status = seatRecord.status as PlayerStatusValue
    if (status === PlayerStatus.alive) alive++
    if (status === PlayerStatus.qualified) qualified++
    if (status === PlayerStatus.eliminated) eliminated++
    const pos = transform.pos as number[]
    const facing = character.facing as number[]
    const vel = (velocity?.lin ?? [0, 0, 0]) as number[]
    seats.push({
      seat,
      entity,
      status,
      pos: { x: pos[0], y: pos[1], z: pos[2] },
      vel: { x: vel[0], y: vel[1], z: vel[2] },
      facing: { x: facing[0], z: facing[1] },
      mode: character.mode as number,
      grounded: character.grounded === 1,
      groundObstacle: character.ground_obstacle as number,
      knockbacks: character.knockbacks as number,
      teleportTick: character.teleport_tick as number,
    })
  }
  return { tick: state.tick, phase: phaseNames[phaseRank], alive, qualified, eliminated, seats, faults, events }
}

export function charStateOf(o: CharObservation): CharState {
  return {
    pos: o.pos,
    vel: o.vel,
    facing: o.facing,
    mode: o.mode,
    grounded: o.grounded,
    groundObstacle: o.groundObstacle,
    knockbacks: o.knockbacks,
    teleportTick: o.teleportTick,
  }
}
