import { Rng } from '@gamesaloon/rollback'
import type { RegionHints, SimView, Simulation, SnapReader, SnapWriter } from '@gamesaloon/rollback'
import type { RapierModule } from '@gamesaloon/rollback-rapier'
import { BotSystem } from '../bots/botSystem.ts'
import { CharacterSystem } from '../character/system.ts'
import type { CharState } from '../character/system.ts'
import { regionOf } from '../course.ts'
import type { ObstacleSpec, ResolvedCourse } from '../course.ts'
import type { PlayerInput } from '../input.ts'
import { ObstacleSystem } from '../obstacles/system.ts'
import { refuse } from '../refusal.ts'
import type { Pose, Vec3 } from '../vec.ts'
import { FiestaWorld } from '../world.ts'
import type { SimSystem, WorldCtx } from '../world.ts'
import { hex8 } from './log.ts'
import type { MatchLog, RoundLogEntry } from './log.ts'
import { PlayerStatus, RoundSystem } from './roundSystem.ts'
import type { RoundReason, RoundResult } from './roundSystem.ts'
import { coursePool, pickCourse, planRound, roundTicks } from './rules.ts'
import type { RoundPlan } from './rules.ts'
import { PROFILES, setupHash, validateSetup } from './setup.ts'
import type { MatchProfile, MatchSetup } from './setup.ts'

export const Phase = { intro: 0, playing: 1, roundEnd: 2, intermission: 3, podium: 4, done: 5 } as const

export interface MatchViewState {
  tick: number
  phase: number
  phaseTicksLeft: number
  roundIndex: number
  roundKind: 'race' | 'survival' | null
  final: boolean
  courseIndex: number
  roundTicksLeft: number
  alive: number
  target: number
  qualifiedCount: number
  winner: number
  podium: number[]
}

export interface CharacterView {
  pos: Vec3
  vel: Vec3
  facing: { x: number; z: number }
  mode: number
  status: number
  parked: boolean
  teleportTick: number
}

const MATCH_RNG_SALT = 0x6d617463
const PODIUM_SIZE = 3
const REASONS: readonly RoundReason[] = ['target', 'timeCap', 'lastStanding', 'allFell']

// Scratch only; never part of sim state.
const scratchState: CharState = {
  pos: { x: 0, y: 0, z: 0 },
  vel: { x: 0, y: 0, z: 0 },
  facing: { x: 0, z: 0 },
  mode: 0,
  grounded: false,
  groundObstacle: -1,
  knockbacks: 0,
  teleportTick: 0,
}

function writeList(w: SnapWriter, list: readonly number[]): void {
  w.u8(list.length)
  for (let i = 0; i < list.length; i++) w.u8(list[i])
}

function readList(r: SnapReader, playerCount: number, path: string): number[] {
  const n = r.u8()
  if (n > playerCount) refuse('match', path, `${n} entries for ${playerCount} players; restore a snapshot from the same match setup`)
  const out: number[] = []
  for (let i = 0; i < n; i++) out.push(r.u8())
  return out
}

// The phase machine. It runs first (S5 order), so every other system sees this tick's phase.
// roundIndex -1 means the match has not started; the first preStep (tick 0) enters round 0's intro.
class MatchSystem implements SimSystem<PlayerInput> {
  readonly name = 'match'
  readonly #setup: MatchSetup
  readonly #profile: MatchProfile
  readonly #obstacles: ObstacleSystem
  readonly #chars: CharacterSystem
  readonly #bots: BotSystem
  readonly #round: RoundSystem
  readonly #rng: Rng
  phase: number = Phase.intro
  phaseTicksLeft = 0
  roundIndex = -1
  lastCourse = -1
  // Derived from roundIndex and results; rebuilt on restore.
  plan: RoundPlan = { index: 0, kind: 'race', final: false, target: 0 }
  results: RoundResult[] = []
  winner = -1
  podium: number[] = []
  // finalTick: the first tick whose state has phase done (set when done is entered, to tick + 1).
  // finalHash: stateHash of that state, recorded at the start of the step that runs finalTick.
  finalTick = -1
  finalHash = 0
  hashed = false

  constructor(setup: MatchSetup, obstacles: ObstacleSystem, chars: CharacterSystem, bots: BotSystem, round: RoundSystem) {
    this.#setup = setup
    this.#profile = PROFILES[setup.profile]
    this.#obstacles = obstacles
    this.#chars = chars
    this.#bots = bots
    this.#round = round
    this.#rng = new Rng(setup.seed).fork(MATCH_RNG_SALT)
  }

  init(_ctx: WorldCtx<PlayerInput>): void {}

  preStep(ctx: WorldCtx<PlayerInput>, _inputs: readonly PlayerInput[]): void {
    if (this.roundIndex < 0) {
      this.#enterIntro(ctx, 0)
      return
    }
    const phase = this.phase
    if (phase === Phase.done) return
    if (phase === Phase.playing) {
      if (!this.#round.over) return
      this.#round.end(ctx)
      this.results.push(this.#round.result())
      this.#enter(Phase.roundEnd, this.#profile.roundEndTicks)
      return
    }
    if (this.phaseTicksLeft > 0) this.phaseTicksLeft--
    if (this.phaseTicksLeft > 0) return
    if (phase === Phase.intro) {
      this.#enterPlaying()
    } else if (phase === Phase.roundEnd) {
      const last = this.results[this.results.length - 1]
      if (last.plan.final || last.qualified.length <= 1) this.#enterPodium(ctx)
      else this.#enter(Phase.intermission, this.#profile.intermissionTicks)
    } else if (phase === Phase.intermission) {
      this.#enterIntro(ctx, this.roundIndex + 1)
    } else if (phase === Phase.podium) {
      this.#enter(Phase.done, 0)
      this.finalTick = ctx.tick + 1
    }
  }

  postStep(_ctx: WorldCtx<PlayerInput>): void {}

  #enter(phase: number, ticks: number): void {
    this.phase = phase
    this.phaseTicksLeft = ticks
  }

  // Players of round k: everyone for round 0, else the previous round's qualifiers in index order.
  participants(k: number): number[] {
    const out: number[] = []
    if (k === 0) {
      for (let p = 0; p < this.#setup.playerCount; p++) out.push(p)
      return out
    }
    const q = this.results[k - 1].qualified
    for (let i = 0; i < q.length; i++) out.push(q[i])
    out.sort((a, b) => a - b)
    return out
  }

  #enterIntro(ctx: WorldCtx<PlayerInput>, k: number): void {
    const setup = this.#setup
    const participants = this.participants(k)
    this.roundIndex = k
    this.plan = planRound(k, participants.length)
    const pool = coursePool(setup.courses, this.plan.final ? 'survival' : this.plan.kind, setup.profile)
    const ci = pickCourse(pool, this.lastCourse, this.#rng)
    this.lastCourse = ci
    const obstacles = this.#obstacles
    if (obstacles.courseIndex !== ci) {
      if (obstacles.courseIndex >= 0) obstacles.unload(ctx)
      obstacles.load(ctx, ci)
    }
    const course = setup.courses[ci]
    // Fisher-Yates over every spawn; the first participants.length entries are used.
    const spawnOrder: number[] = []
    for (let i = 0; i < course.spawns.length; i++) spawnOrder.push(i)
    for (let i = spawnOrder.length - 1; i > 0; i--) {
      const j = this.#rng.int(0, i)
      const t = spawnOrder[i]
      spawnOrder[i] = spawnOrder[j]
      spawnOrder[j] = t
    }
    this.#round.begin(ctx, this.plan, ci, participants, spawnOrder, roundTicks(course, this.#profile))
    for (let p = 0; p < setup.playerCount; p++) this.#chars.freeze(p, true)
    this.#bots.resetForRound(ctx)
    this.#enter(Phase.intro, this.#profile.introTicks)
  }

  #enterPlaying(): void {
    for (let p = 0; p < this.#setup.playerCount; p++) {
      if (this.#round.status(p) === PlayerStatus.alive) this.#chars.freeze(p, false)
    }
    this.#enter(Phase.playing, 0)
  }

  // Ranking: the last round's qualifiers (winner first), then everyone else in reverse
  // elimination order. Only the top PODIUM_SIZE are kept and shown.
  #enterPodium(ctx: WorldCtx<PlayerInput>): void {
    const ranking: number[] = []
    const last = this.results[this.results.length - 1]
    for (let i = 0; i < last.qualified.length; i++) ranking.push(last.qualified[i])
    for (let k = this.results.length - 1; k >= 0; k--) {
      const el = this.results[k].eliminated
      for (let i = el.length - 1; i >= 0; i--) {
        if (!ranking.includes(el[i])) ranking.push(el[i])
      }
    }
    this.winner = ranking.length > 0 ? ranking[0] : -1
    this.podium = ranking.slice(0, PODIUM_SIZE)
    const course = this.#setup.courses[this.lastCourse]
    for (let i = 0; i < this.podium.length; i++) {
      this.#chars.place(ctx, this.podium[i], course.spawns[i])
      this.#chars.freeze(this.podium[i], true)
    }
    this.#enter(Phase.podium, this.#profile.podiumTicks)
  }

  snapshot(w: SnapWriter): void {
    w.u8(this.phase)
    w.u32(this.phaseTicksLeft)
    w.i32(this.roundIndex)
    w.i32(this.lastCourse)
    w.u32(this.#rng.state)
    w.u8(this.results.length)
    for (let k = 0; k < this.results.length; k++) {
      const r = this.results[k]
      w.i32(r.plan.index)
      w.u8(r.plan.kind === 'race' ? 0 : 1)
      w.u8(r.plan.final ? 1 : 0)
      w.u8(r.plan.target)
      w.i32(r.courseIndex)
      w.u32(r.startTick)
      w.u32(r.endTick)
      writeList(w, r.participants)
      writeList(w, r.qualified)
      writeList(w, r.eliminated)
      w.u8(REASONS.indexOf(r.reason))
    }
    w.i16(this.winner)
    writeList(w, this.podium)
    w.i32(this.finalTick)
    w.u8(this.hashed ? 1 : 0)
    w.u32(this.finalHash)
  }

  restore(r: SnapReader, _ctx: WorldCtx<PlayerInput>): void {
    const n = this.#setup.playerCount
    const phase = r.u8()
    if (phase > Phase.done) refuse('match', 'snapshot/match/phase', `got ${phase}; restore a match snapshot`)
    this.phase = phase
    this.phaseTicksLeft = r.u32()
    this.roundIndex = r.i32()
    this.lastCourse = r.i32()
    this.#rng.state = r.u32()
    const count = r.u8()
    const results: RoundResult[] = []
    for (let k = 0; k < count; k++) {
      const index = r.i32()
      const kind = r.u8()
      if (kind > 1) refuse('match', `snapshot/match/results/${k}/plan.kind`, `got ${kind}; restore a match snapshot`)
      const final = r.u8() !== 0
      const target = r.u8()
      const courseIndex = r.i32()
      const startTick = r.u32()
      const endTick = r.u32()
      const participants = readList(r, n, `snapshot/match/results/${k}/participants`)
      const qualified = readList(r, n, `snapshot/match/results/${k}/qualified`)
      const eliminated = readList(r, n, `snapshot/match/results/${k}/eliminated`)
      const reason = r.u8()
      if (reason >= REASONS.length) refuse('match', `snapshot/match/results/${k}/reason`, `got ${reason}; restore a match snapshot`)
      results.push({
        plan: { index, kind: kind === 0 ? 'race' : 'survival', final, target },
        courseIndex, startTick, endTick, participants, qualified, eliminated, reason: REASONS[reason],
      })
    }
    this.results = results
    this.winner = r.i16()
    this.podium = readList(r, n, 'snapshot/match/podium')
    this.finalTick = r.i32()
    this.hashed = r.u8() !== 0
    this.finalHash = r.u32()
    this.plan = this.roundIndex < 0
      ? { index: 0, kind: 'race', final: false, target: 0 }
      : planRound(this.roundIndex, this.participants(this.roundIndex).length)
  }
}

export class MatchSim implements Simulation<PlayerInput> {
  readonly setup: MatchSetup
  readonly world: FiestaWorld<PlayerInput>
  readonly view: SimView
  readonly regions: RegionHints
  readonly #match: MatchSystem
  readonly #obstacles: ObstacleSystem
  readonly #chars: CharacterSystem
  readonly #round: RoundSystem

  constructor(R: RapierModule, setup: MatchSetup) {
    validateSetup(setup)
    this.setup = setup
    const n = setup.playerCount
    const bots = new BotSystem(setup)
    const obstacles = new ObstacleSystem(setup.courses)
    const chars = new CharacterSystem({ playerCount: n })
    const round = new RoundSystem(setup)
    const match = new MatchSystem(setup, obstacles, chars, bots, round)
    this.#match = match
    this.#obstacles = obstacles
    this.#chars = chars
    this.#round = round
    // The closures read this.world at call time; it is assigned below, before any use.
    this.view = {
      entities: n,
      stride: 3,
      read: (out: Float64Array) => chars.readPositions(this.world.ctx, out),
    }
    this.regions = {
      regionOf: (p: number) => {
        const c = this.course()
        if (c === null) return -1
        return regionOf(c, chars.state(this.world.ctx, p, scratchState).pos)
      },
      adjacent: (a: number, b: number) => {
        if (a === b) return true
        const c = this.course()
        if (c === null) return false
        for (let i = 0; i < c.regions.length; i++) {
          if (c.regions[i].id === a) return c.regions[i].adjacent.includes(b)
        }
        return false
      },
    }
    this.world = new FiestaWorld<PlayerInput>(R, {
      playerCount: n,
      systems: [match, bots, obstacles, chars, round],
      view: this.view,
      regions: this.regions,
    })
  }

  get tick(): number { return this.world.tick }

  get done(): boolean { return this.#match.phase === Phase.done }

  // Once done, only physics and the tick advance. The first step run in phase done records
  // finalHash = stateHash of the state at finalTick, before that state changes.
  step(inputs: readonly PlayerInput[]): void {
    const m = this.#match
    if (m.phase !== Phase.done) {
      this.world.step(inputs)
      return
    }
    if (inputs.length !== this.setup.playerCount) {
      refuse('match', 'step(inputs)', `got ${inputs.length} inputs, expected ${this.setup.playerCount}; pass one input per player`)
    }
    if (!m.hashed) {
      m.finalHash = this.world.stateHash()
      m.hashed = true
    }
    this.world.physics.step()
  }

  snapshot(w: SnapWriter): void { this.world.snapshot(w) }

  restore(r: SnapReader): void { this.world.restore(r) }

  playerDropped(player: number): void { this.world.playerDropped(player) }

  beginResim(): void { this.world.beginResim() }

  endResim(): void { this.world.endResim() }

  phase(out: MatchViewState): MatchViewState {
    const m = this.#match
    const ctx = this.world.ctx
    const round = this.#round
    const started = m.roundIndex >= 0
    const inRound = started && (m.phase === Phase.intro || m.phase === Phase.playing)
    const last = m.results.length > 0 ? m.results[m.results.length - 1] : null
    out.tick = this.world.tick
    out.phase = m.phase
    out.phaseTicksLeft = m.phaseTicksLeft
    out.roundIndex = m.roundIndex
    out.roundKind = started ? m.plan.kind : null
    out.final = started && m.plan.final
    out.courseIndex = m.lastCourse
    out.roundTicksLeft = inRound ? round.ticksLeft(ctx) : 0
    let alive = 0
    let qualified = 0
    if (inRound) {
      for (let p = 0; p < this.setup.playerCount; p++) {
        const s = round.status(p)
        if (s === PlayerStatus.alive) alive++
        else if (s === PlayerStatus.qualified) qualified++
      }
    } else if (last !== null) {
      qualified = last.qualified.length
    } else {
      alive = this.setup.playerCount
    }
    out.alive = alive
    out.target = started ? m.plan.target : 0
    out.qualifiedCount = qualified
    out.winner = m.winner
    out.podium.length = 0
    for (let i = 0; i < m.podium.length; i++) out.podium.push(m.podium[i])
    return out
  }

  character(p: number, out: CharacterView): CharacterView {
    const ctx = this.world.ctx
    const st = this.#chars.state(ctx, p, scratchState)
    out.pos.x = st.pos.x
    out.pos.y = st.pos.y
    out.pos.z = st.pos.z
    out.vel.x = st.vel.x
    out.vel.y = st.vel.y
    out.vel.z = st.vel.z
    out.facing.x = st.facing.x
    out.facing.z = st.facing.z
    out.mode = st.mode
    out.status = this.#round.status(p)
    out.parked = this.#chars.isParked(p)
    out.teleportTick = st.teleportTick
    return out
  }

  obstacleCount(): number { return this.#obstacles.count }

  obstacleSpec(i: number): ObstacleSpec { return this.#obstacles.spec(i) }

  obstaclePose(i: number, out: Pose): Pose {
    const o = this.#obstacles
    return o.pose(i, o.localTick(this.world.ctx), out)
  }

  course(): ResolvedCourse | null {
    const ci = this.#obstacles.courseIndex
    return ci < 0 ? null : this.setup.courses[ci]
  }

  log(): MatchLog {
    const m = this.#match
    if (m.phase !== Phase.done) refuse('match', 'log()', `the match is in phase ${m.phase}, not done; step until done before reading the log`)
    // Before the first step in phase done the state is still the one at finalTick.
    const finalHash = m.hashed ? m.finalHash : this.world.stateHash()
    const s = this.setup
    const rounds: RoundLogEntry[] = []
    for (let k = 0; k < m.results.length; k++) {
      const r = m.results[k]
      rounds.push({
        index: r.plan.index,
        kind: r.plan.kind,
        final: r.plan.final,
        course: s.courses[r.courseIndex].id,
        startTick: r.startTick,
        endTick: r.endTick,
        participants: r.participants.slice(),
        target: r.plan.target,
        qualified: r.qualified.slice(),
        eliminated: r.eliminated.slice(),
        reason: r.reason,
      })
    }
    return {
      format: 'royal-fiesta.matchlog',
      version: 0,
      seed: s.seed,
      profile: s.profile,
      playerCount: s.playerCount,
      humans: s.humans.slice(),
      setupHash: hex8(setupHash(s)),
      rounds,
      winner: m.winner,
      podium: m.podium.slice(),
      finalTick: m.finalTick,
      finalHash: hex8(finalHash),
    }
  }

  stateHash(): number { return this.world.stateHash() }

  free(): void { this.world.free() }
}

export function createMatchSim(R: RapierModule, setup: MatchSetup): MatchSim {
  return new MatchSim(R, setup)
}
