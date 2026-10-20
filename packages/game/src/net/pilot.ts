import { Rng } from '@gamesaloon/rollback'
import { newMemory, raceBrain, rollSkill, survivalBrain } from '@royal-fiesta/sim/bots/brain'
import type { BotSkill, BrainInput, BrainMemory } from '@royal-fiesta/sim/bots/brain'
import { CharMode } from '@royal-fiesta/sim/character/constants'
import { decodeInput, NEUTRAL_CODE } from '@royal-fiesta/sim/input'
import type { PlayerInput } from '@royal-fiesta/sim/input'
import { PlayerStatus } from '@royal-fiesta/sim/match/roundSystem'
import { Phase } from '@royal-fiesta/sim/match/matchSim'
import type { CharacterView, MatchSim, MatchViewState } from '@royal-fiesta/sim/match/matchSim'
import type { Pose } from '@royal-fiesta/sim/vec'

const HAZARD_RADIUS = 2.5

// View-side only: reads MatchSim view methods (phase, character, course, obstacleCount, obstacleSpec, obstaclePose); never writes the sim or uses its RNG.
export class Pilot {
  readonly player: number
  #rng: Rng
  #skill: BotSkill
  #mem: BrainMemory = newMemory()
  #lastRound = -1
  #view: MatchViewState = {
    tick: 0, phase: 0, phaseTicksLeft: 0, roundIndex: 0, roundKind: null, final: false, courseIndex: 0,
    roundTicksLeft: 0, alive: 0, target: 0, qualifiedCount: 0, winner: -1, podium: [],
  }
  #char: CharacterView = {
    pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, facing: { x: 0, z: 1 },
    mode: 0, status: 0, parked: false, teleportTick: 0,
  }
  #pose: Pose = { t: { x: 0, y: 0, z: 0 }, r: { x: 0, y: 0, z: 0, w: 1 } }

  constructor(player: number, seed: number) {
    this.player = player
    this.#rng = new Rng(seed).fork(0x9170 + player)
    this.#skill = rollSkill(this.#rng)
  }

  sample(sim: MatchSim, out: PlayerInput): PlayerInput {
    const v = sim.phase(this.#view)
    const course = sim.course()
    if (v.phase !== Phase.playing || v.roundKind === null || course === null) return decodeInput(NEUTRAL_CODE, out)
    if (v.roundIndex !== this.#lastRound) {
      const fresh = newMemory()
      const m = this.#mem
      m.pathIndex = fresh.pathIndex
      m.stuckTicks = fresh.stuckTicks
      m.lastX = fresh.lastX
      m.lastZ = fresh.lastZ
      m.wobble = fresh.wobble
      m.ticks = fresh.ticks
      this.#lastRound = v.roundIndex
    }
    const c = sim.character(this.player, this.#char)
    if (c.parked || c.status !== PlayerStatus.alive) return decodeInput(NEUTRAL_CODE, out)
    const input: BrainInput = {
      course,
      pos: c.pos,
      vel: c.vel,
      facing: c.facing,
      grounded: c.mode === CharMode.ground,
      mode: c.mode,
      obstacleAhead: false,
      hazardNear: this.#hazardNear(sim, c.pos.x, c.pos.z),
    }
    const code = v.roundKind === 'survival'
      ? survivalBrain(input, this.#skill, this.#mem, this.#rng)
      : raceBrain(input, this.#skill, this.#mem, this.#rng)
    return decodeInput(code, out)
  }

  #hazardNear(sim: MatchSim, x: number, z: number): boolean {
    const n = sim.obstacleCount()
    for (let i = 0; i < n; i++) {
      const k = sim.obstacleSpec(i).motion.kind
      if (k !== 'spinner' && k !== 'pendulum' && k !== 'rotatingDoor' && k !== 'movingPlatform') continue
      const t = sim.obstaclePose(i, this.#pose).t
      const dx = t.x - x
      const dz = t.z - z
      if (dx * dx + dz * dz <= HAZARD_RADIUS * HAZARD_RADIUS) return true
    }
    return false
  }
}
