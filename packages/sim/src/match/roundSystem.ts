import type { SnapReader, SnapWriter } from '@gamesaloon/rollback'
import type { CharacterSystem, CharState } from '../character/system.ts'
import { inBox } from '../course.ts'
import type { ResolvedCourse } from '../course.ts'
import type { PlayerInput } from '../input.ts'
import { refuse } from '../refusal.ts'
import type { SimSystem, WorldCtx } from '../world.ts'
import type { RoundPlan } from './rules.ts'
import type { MatchSetup } from './setup.ts'

export const PlayerStatus = { out: 0, alive: 1, qualified: 2, eliminated: 3 } as const
export type PlayerStatusValue = typeof PlayerStatus[keyof typeof PlayerStatus]

export type RoundReason = 'target' | 'timeCap' | 'lastStanding' | 'allFell'

export interface RoundResult {
  plan: RoundPlan
  courseIndex: number
  startTick: number
  endTick: number
  participants: number[]
  qualified: number[]
  eliminated: number[]
  reason: RoundReason
}

// Snapshot encodings that keep the contract layout:
// - checkpoint i16: >= 0 is a checkpoint index, checkpoints.length means finished,
//   and -1 - s means no checkpoint yet with own spawn index s (the respawn point).
// - capTicks: once the round is over it holds endTick - startTick, so endTick survives restore.
const MAX_ORDER = 64

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
const scratchOrder: number[] = []
const scratchD2: number[] = []

export class RoundSystem implements SimSystem<PlayerInput> {
  readonly name = 'round'
  readonly #setup: MatchSetup
  readonly #playerCount: number
  #active = false
  #plan: RoundPlan = { index: 0, kind: 'race', final: false, target: 0 }
  #courseIndex = -1
  #startTick = 0
  #capTicks = 0
  readonly #status: Uint8Array
  readonly #checkpoint: Int16Array
  readonly #finishOrder: number[] = []
  readonly #fallOrder: number[] = []
  readonly #fellThisTick: number[] = []

  constructor(setup: MatchSetup) {
    this.#setup = setup
    this.#playerCount = setup.playerCount
    this.#status = new Uint8Array(setup.playerCount)
    this.#checkpoint = new Int16Array(setup.playerCount)
  }

  init(_ctx: WorldCtx<PlayerInput>): void {}

  begin(ctx: WorldCtx<PlayerInput>, plan: RoundPlan, courseIndex: number, participants: readonly number[], spawnOrder: readonly number[], capTicks: number): void {
    if (courseIndex < 0 || courseIndex >= this.#setup.courses.length) {
      refuse('round', 'begin.courseIndex', `${courseIndex} is outside 0..${this.#setup.courses.length - 1}; pass an index into setup.courses`)
    }
    if (spawnOrder.length < participants.length) {
      refuse('round', 'begin.spawnOrder', `${spawnOrder.length} spawns for ${participants.length} participants; give one spawn per participant`)
    }
    if (!Number.isInteger(capTicks) || capTicks < 1) {
      refuse('round', 'begin.capTicks', `${capTicks} is not a positive integer; pass roundTicks(course, profile)`)
    }
    const course = this.#setup.courses[courseIndex]
    const chars = ctx.system<CharacterSystem>('characters')
    this.#active = true
    this.#plan = { index: plan.index, kind: plan.kind, final: plan.final, target: plan.target }
    this.#courseIndex = courseIndex
    this.#startTick = ctx.tick
    this.#capTicks = capTicks
    this.#finishOrder.length = 0
    this.#fallOrder.length = 0
    this.#fellThisTick.length = 0
    this.#status.fill(PlayerStatus.out)
    this.#checkpoint.fill(-1)
    for (let k = 0; k < participants.length; k++) {
      const p = participants[k]
      const s = spawnOrder[k]
      if (!Number.isInteger(p) || p < 0 || p >= this.#playerCount || this.#status[p] !== PlayerStatus.out) {
        refuse('round', `begin.participants[${k}]`, `${p} is not a new player index in 0..${this.#playerCount - 1}; list each player once`)
      }
      if (!Number.isInteger(s) || s < 0 || s >= course.spawns.length) {
        refuse('round', `begin.spawnOrder[${k}]`, `${s} is outside 0..${course.spawns.length - 1}; use a spawn index of course ${course.id}`)
      }
      this.#status[p] = PlayerStatus.alive
      this.#checkpoint[p] = -1 - s
    }
    for (let p = 0; p < this.#playerCount; p++) {
      if (this.#status[p] === PlayerStatus.alive) {
        chars.place(ctx, p, course.spawns[-1 - this.#checkpoint[p]])
        chars.freeze(p, false)
        chars.resetKnockbacks(p)
      } else if (!chars.isParked(p)) {
        chars.park(ctx, p)
      }
    }
  }

  get active(): boolean {
    return this.#active
  }

  get over(): boolean {
    if (!this.#active) return false
    for (let p = 0; p < this.#playerCount; p++) {
      if (this.#status[p] === PlayerStatus.alive) return false
    }
    return true
  }

  status(p: number): number {
    return this.#status[p]
  }

  // -1 when no checkpoint is reached; checkpoints.length once finished.
  checkpoint(p: number): number {
    const c = this.#checkpoint[p]
    return c < 0 ? -1 : c
  }

  ticksLeft(ctx: WorldCtx<PlayerInput>): number {
    if (!this.#active) return 0
    return Math.max(0, this.#capTicks - (ctx.tick - this.#startTick))
  }

  // Higher is better. Race: finished > checkpoint > closeness to the next goal. Survival: status.
  progress(ctx: WorldCtx<PlayerInput>, p: number): number {
    const st = this.#status[p]
    if (!this.#active || st === PlayerStatus.out) return -1
    if (this.#plan.kind === 'survival') return st === PlayerStatus.eliminated ? 0 : st === PlayerStatus.qualified ? 2 : 1
    const course = this.#course()
    if (this.#checkpoint[p] >= course.checkpoints.length) return 1e9 - this.#finishOrder.indexOf(p)
    const d2 = this.#nextGoalD2(ctx, course, p)
    return (this.checkpoint(p) + 2) * 1e6 - Math.min(d2, 999999)
  }

  end(ctx: WorldCtx<PlayerInput>): void {
    const chars = ctx.system<CharacterSystem>('characters')
    for (let p = 0; p < this.#playerCount; p++) chars.freeze(p, true)
    this.#active = false
  }

  preStep(_ctx: WorldCtx<PlayerInput>, _inputs: readonly PlayerInput[]): void {}

  postStep(ctx: WorldCtx<PlayerInput>): void {
    if (!this.#active || this.over) return
    const course = this.#course()
    const chars = ctx.system<CharacterSystem>('characters')
    this.#fellThisTick.length = 0
    if (this.#plan.kind === 'race') this.#raceStep(ctx, course, chars)
    else this.#survivalStep(ctx, course, chars)
  }

  #raceStep(ctx: WorldCtx<PlayerInput>, course: ResolvedCourse, chars: CharacterSystem): void {
    const cps = course.checkpoints
    const target = this.#plan.target
    for (let p = 0; p < this.#playerCount; p++) {
      if (this.#status[p] !== PlayerStatus.alive) continue
      const pos = chars.state(ctx, p, scratchState).pos
      // Highest box first, so skipping checkpoints counts.
      for (let c = cps.length - 1; c > this.checkpoint(p); c--) {
        if (inBox(cps[c].box, pos)) {
          this.#checkpoint[p] = c
          break
        }
      }
      if (course.finish !== null && inBox(course.finish, pos)) {
        this.#qualify(p)
        this.#checkpoint[p] = cps.length
        chars.freeze(p, true)
        if (this.#finishOrder.length >= target) break
        continue
      }
      if (pos.y < course.killPlaneY) {
        const c = this.#checkpoint[p]
        chars.place(ctx, p, c >= 0 ? cps[c].respawn : course.spawns[-1 - c])
      }
    }
    const alive = this.#aliveCount()
    if (this.#finishOrder.length >= target || alive === 0) {
      this.#eliminateAlive()
      this.#close(ctx)
      return
    }
    if (!this.#capReached(ctx)) return
    if (this.#finishOrder.length === 0) {
      this.#progressOrder(ctx, course, scratchOrder)
      const n = Math.min(target, scratchOrder.length)
      for (let i = 0; i < n; i++) {
        this.#qualify(scratchOrder[i])
        chars.freeze(scratchOrder[i], true)
      }
    }
    this.#eliminateAlive()
    this.#close(ctx)
  }

  #survivalStep(ctx: WorldCtx<PlayerInput>, course: ResolvedCourse, chars: CharacterSystem): void {
    for (let p = 0; p < this.#playerCount; p++) {
      if (this.#status[p] !== PlayerStatus.alive) continue
      if (chars.state(ctx, p, scratchState).pos.y < course.killPlaneY) {
        this.#status[p] = PlayerStatus.eliminated
        this.#fallOrder.push(p)
        this.#fellThisTick.push(p)
        chars.park(ctx, p)
      }
    }
    const alive = this.#aliveCount()
    const fell = this.#fellThisTick
    if (alive === 0 && fell.length > 0) {
      // Everyone left fell together: they qualify, lowest index first (fell is in index order).
      const n = this.#plan.final ? 1 : fell.length
      for (let i = 0; i < n; i++) this.#qualify(fell[i])
      this.#close(ctx)
      return
    }
    if (alive <= this.#plan.target) {
      this.#qualifyAlive()
      this.#close(ctx)
      return
    }
    if (!this.#capReached(ctx)) return
    if (this.#plan.final) {
      let winner = -1
      let best = 0
      for (let p = 0; p < this.#playerCount; p++) {
        if (this.#status[p] !== PlayerStatus.alive) continue
        const kb = chars.state(ctx, p, scratchState).knockbacks
        if (winner < 0 || kb < best) {
          winner = p
          best = kb
        }
      }
      this.#qualify(winner)
      this.#eliminateAlive()
    } else {
      this.#qualifyAlive()
    }
    this.#close(ctx)
  }

  result(): RoundResult {
    if (this.#courseIndex < 0) refuse('round', 'result', 'no round was begun; call begin first')
    if (this.#aliveCount() > 0) refuse('round', 'result', 'the round is not over; read result only when over is true')
    const participants: number[] = []
    const eliminated: number[] = []
    for (let i = 0; i < this.#fallOrder.length; i++) {
      const p = this.#fallOrder[i]
      if (this.#status[p] === PlayerStatus.eliminated) eliminated.push(p)
    }
    let eliminatedNotFell = false
    for (let p = 0; p < this.#playerCount; p++) {
      if (this.#status[p] === PlayerStatus.out) continue
      participants.push(p)
      if (this.#status[p] === PlayerStatus.eliminated && !this.#fallOrder.includes(p)) {
        eliminated.push(p)
        eliminatedNotFell = true
      }
    }
    const qualified = this.#finishOrder.slice()
    return {
      plan: { index: this.#plan.index, kind: this.#plan.kind, final: this.#plan.final, target: this.#plan.target },
      courseIndex: this.#courseIndex,
      startTick: this.#startTick,
      endTick: this.#startTick + this.#capTicks,
      participants,
      qualified,
      eliminated,
      reason: this.#reason(participants, qualified, eliminatedNotFell),
    }
  }

  // Derived from the snapshotted state only, so restore reproduces it.
  #reason(participants: readonly number[], qualified: readonly number[], eliminatedNotFell: boolean): RoundReason {
    const target = this.#plan.target
    if (this.#plan.kind === 'race') {
      const nCp = this.#course().checkpoints.length
      let finished = 0
      for (let i = 0; i < participants.length; i++) {
        if (this.#checkpoint[participants[i]] >= nCp) finished++
      }
      return finished >= Math.min(target, participants.length) ? 'target' : 'timeCap'
    }
    for (let i = 0; i < qualified.length; i++) {
      if (this.#fallOrder.includes(qualified[i])) return 'allFell'
    }
    if (this.#plan.final) return eliminatedNotFell ? 'timeCap' : 'lastStanding'
    return qualified.length > target ? 'timeCap' : 'target'
  }

  snapshot(w: SnapWriter): void {
    w.u8(this.#active ? 1 : 0)
    w.i32(this.#plan.index)
    w.u8(this.#plan.kind === 'race' ? 0 : 1)
    w.u8(this.#plan.final ? 1 : 0)
    w.u8(this.#plan.target)
    w.i32(this.#courseIndex)
    w.u32(this.#startTick)
    w.u32(this.#capTicks)
    for (let p = 0; p < this.#playerCount; p++) {
      w.u8(this.#status[p])
      w.i16(this.#checkpoint[p])
    }
    writeList(w, this.#finishOrder)
    writeList(w, this.#fallOrder)
    writeList(w, this.#fellThisTick)
  }

  restore(r: SnapReader, _ctx: WorldCtx<PlayerInput>): void {
    this.#active = r.u8() !== 0
    const index = r.i32()
    const kind = r.u8()
    if (kind > 1) refuse('round', 'snapshot/plan.kind', `got ${kind}; restore a round snapshot`)
    const final = r.u8() !== 0
    const target = r.u8()
    this.#plan = { index, kind: kind === 0 ? 'race' : 'survival', final, target }
    const courseIndex = r.i32()
    if (courseIndex < -1 || courseIndex >= this.#setup.courses.length) {
      refuse('round', 'snapshot/courseIndex', `${courseIndex} is outside -1..${this.#setup.courses.length - 1}; restore with the same match setup`)
    }
    this.#courseIndex = courseIndex
    this.#startTick = r.u32()
    this.#capTicks = r.u32()
    for (let p = 0; p < this.#playerCount; p++) {
      const st = r.u8()
      if (st > PlayerStatus.eliminated) refuse('round', `snapshot/status[${p}]`, `got ${st}; restore a round snapshot`)
      this.#status[p] = st
      this.#checkpoint[p] = r.i16()
    }
    this.#readList(r, this.#finishOrder, 'finishOrder')
    this.#readList(r, this.#fallOrder, 'fallOrder')
    this.#readList(r, this.#fellThisTick, 'fellThisTick')
  }

  #readList(r: SnapReader, out: number[], label: string): void {
    const n = r.u32()
    if (n > MAX_ORDER) refuse('round', `snapshot/${label}`, `${n} entries, at most ${MAX_ORDER}; restore a round snapshot`)
    out.length = 0
    for (let i = 0; i < n; i++) {
      const p = r.u8()
      if (p >= this.#playerCount) refuse('round', `snapshot/${label}[${i}]`, `player ${p} >= playerCount ${this.#playerCount}; restore with the same match setup`)
      out.push(p)
    }
  }

  #course(): ResolvedCourse {
    return this.#setup.courses[this.#courseIndex]
  }

  #aliveCount(): number {
    let n = 0
    for (let p = 0; p < this.#playerCount; p++) {
      if (this.#status[p] === PlayerStatus.alive) n++
    }
    return n
  }

  #capReached(ctx: WorldCtx<PlayerInput>): boolean {
    return ctx.tick - this.#startTick >= this.#capTicks
  }

  #qualify(p: number): void {
    this.#status[p] = PlayerStatus.qualified
    this.#finishOrder.push(p)
  }

  #qualifyAlive(): void {
    for (let p = 0; p < this.#playerCount; p++) {
      if (this.#status[p] === PlayerStatus.alive) this.#qualify(p)
    }
  }

  #eliminateAlive(): void {
    for (let p = 0; p < this.#playerCount; p++) {
      if (this.#status[p] === PlayerStatus.alive) this.#status[p] = PlayerStatus.eliminated
    }
  }

  // Keeps endTick in the contract layout: capTicks becomes the round length once over.
  #close(ctx: WorldCtx<PlayerInput>): void {
    this.#capTicks = ctx.tick - this.#startTick
  }

  #nextGoalD2(ctx: WorldCtx<PlayerInput>, course: ResolvedCourse, p: number): number {
    const pos = ctx.system<CharacterSystem>('characters').state(ctx, p, scratchState).pos
    const next = this.checkpoint(p) + 1
    const goal = next < course.checkpoints.length ? course.checkpoints[next].box.center : course.finish?.center
    if (goal === undefined) return 0
    const dx = pos.x - goal.x, dy = pos.y - goal.y, dz = pos.z - goal.z
    return dx * dx + dy * dy + dz * dz
  }

  // Alive players by checkpoint desc, squared distance to the next goal asc, index asc.
  #progressOrder(ctx: WorldCtx<PlayerInput>, course: ResolvedCourse, out: number[]): void {
    out.length = 0
    scratchD2.length = 0
    for (let p = 0; p < this.#playerCount; p++) {
      if (this.#status[p] !== PlayerStatus.alive) continue
      out.push(p)
      scratchD2.push(this.#nextGoalD2(ctx, course, p))
    }
    // Stable insertion sort; ties keep ascending index.
    for (let i = 1; i < out.length; i++) {
      const p = out[i], d = scratchD2[i]
      let j = i - 1
      while (j >= 0 && this.#before(p, d, out[j], scratchD2[j])) {
        out[j + 1] = out[j]
        scratchD2[j + 1] = scratchD2[j]
        j--
      }
      out[j + 1] = p
      scratchD2[j + 1] = d
    }
  }

  #before(a: number, da: number, b: number, db: number): boolean {
    const ca = this.checkpoint(a), cb = this.checkpoint(b)
    if (ca !== cb) return ca > cb
    return da < db
  }
}

function writeList(w: SnapWriter, list: readonly number[]): void {
  w.u32(list.length)
  for (let i = 0; i < list.length; i++) w.u8(list[i])
}
