import { Rng } from '@gamesaloon/rollback'
import type { SnapReader, SnapWriter } from '@gamesaloon/rollback'
import type { RapierModule } from '@gamesaloon/rollback-rapier'
import { CHAR, CharMode } from '../character/constants.ts'
import type { ResolvedCourse } from '../course.ts'
import type { CharacterSystem, CharState } from '../character/system.ts'
import { G, groups } from '../groups.ts'
import { NEUTRAL_CODE } from '../input.ts'
import type { PlayerInput } from '../input.ts'
import { PlayerStatus } from '../match/roundSystem.ts'
import type { RoundSystem } from '../match/roundSystem.ts'
import type { MatchSetup } from '../match/setup.ts'
import type { ObstacleSystem } from '../obstacles/system.ts'
import { refuse } from '../refusal.ts'
import type { SimSystem, WorldCtx } from '../world.ts'
import { bindBehaviour } from './behaviour.ts'
import type { BotBehaviour } from './behaviour.ts'
import { newMemory, raceBrain, rollSkill, survivalBrain } from './brain.ts'
import type { BotSkill, BrainInput, BrainMemory } from './brain.ts'
import { courseCapabilities } from './courseRead.ts'
import { updateRoute } from './routes.ts'
import type { RoutePlan } from './routes.ts'

const RNG_SALT = 0xb0700000
const KNEE = 0.4
const AHEAD_DIST = 1.2
const AHEAD_MAX_NY = 0.6
const HAZARD_RADIUS = 1.6
const PROBE_GROUPS = groups(G.PROBE, G.STATIC | G.MOVING)
const HAZARD_GROUPS = groups(G.PROBE, G.MOVING)
const ROT_ID = { x: 0, y: 0, z: 0, w: 1 }
const STUCK_MOVE = 0.02
const MAX_PLAN_ITEMS = 4096

type Collider = InstanceType<RapierModule['Collider']>

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
const scratchPos = { x: 0, y: 0, z: 0 }
let scratchRay: InstanceType<RapierModule['Ray']> | null = null
let scratchBall: InstanceType<RapierModule['Ball']> | null = null

// Same cadence as the original brain: no horizontal progress for a tick counts as stuck.
function trackStuck(m: BrainMemory, pos: { x: number; z: number }): void {
  const dx = pos.x - m.lastX
  const dz = pos.z - m.lastZ
  if (Math.sqrt(dx * dx + dz * dz) < STUCK_MOVE) m.stuckTicks++
  else m.stuckTicks = 0
  m.lastX = pos.x
  m.lastZ = pos.z
}

export class BotSystem implements SimSystem<PlayerInput> {
  readonly name = 'bots'
  readonly #playerCount: number
  // Every player gets a stream, a skill and a ring at construction, so a later setBot or
  // drop needs no allocation and the snapshot layout never changes.
  readonly #isBot: Uint8Array
  readonly #rng: Rng[] = []
  readonly #skill: BotSkill[] = []
  readonly #mem: BrainMemory[] = []
  readonly #ring: Int32Array[] = []
  readonly #head: Int32Array
  // JSON behaviours are opt-in: no profile keeps the original brain on every bot.
  readonly #behaviour: (BotBehaviour | null)[] = []
  readonly #known = new Map<string, BotBehaviour>()
  readonly #route: (RoutePlan | null)[] = []
  readonly #planSeed: Uint32Array
  // Course path index the JSON brain is steering at, per player.
  readonly #waypoint: Int32Array
  // Last delayed code written this tick; scratch, for tests and view-side pilots.
  readonly #last: Int32Array
  // Hazard query scratch, valid only inside one preStep.
  #hazard = false

  constructor(setup: MatchSetup, behaviours: readonly BotBehaviour[] = []) {
    const n = setup.playerCount
    this.#playerCount = n
    this.#isBot = new Uint8Array(n)
    this.#head = new Int32Array(n)
    this.#planSeed = new Uint32Array(n)
    this.#waypoint = new Int32Array(n).fill(-1)
    this.#last = new Int32Array(n).fill(NEUTRAL_CODE)
    const root = new Rng(setup.seed)
    for (let p = 0; p < n; p++) {
      this.#isBot[p] = setup.humans[p] ? 0 : 1
      const rng = root.fork(RNG_SALT + p)
      this.#rng.push(rng)
      const skill = rollSkill(rng)
      this.#skill.push(skill)
      this.#mem.push(newMemory())
      this.#ring.push(new Int32Array(skill.reactionTicks).fill(NEUTRAL_CODE))
      this.#behaviour.push(null)
      this.#route.push(null)
      this.#planSeed[p] = (setup.seed ^ Math.imul(p + 1, 0x9e3779b1)) >>> 0
    }
    if (behaviours.length > 0) this.setBehaviours(behaviours)
  }

  init(_ctx: WorldCtx<PlayerInput>): void {}

  #check(p: number, what: string): void {
    if (!Number.isInteger(p) || p < 0 || p >= this.#playerCount) {
      refuse('bots', `${what}(${p})`, `player index out of range 0..${this.#playerCount - 1}; pass a valid player index`)
    }
  }

  isBot(p: number): boolean {
    this.#check(p, 'isBot')
    return this.#isBot[p] !== 0
  }

  setBot(p: number, on: boolean): void {
    this.#check(p, 'setBot')
    this.#isBot[p] = on ? 1 : 0
  }

  // Give every player a JSON behaviour, cycling the list in player order. Course binding and
  // route planning happen on the next preStep, before any bot input is written.
  setBehaviours(behaviours: readonly BotBehaviour[]): void {
    if (behaviours.length === 0) {
      refuse('bots', 'setBehaviours', 'no behaviours; pass at least one loaded profile')
    }
    for (let p = 0; p < this.#playerCount; p++) this.setBehaviour(p, behaviours[p % behaviours.length])
  }

  setBehaviour(p: number, behaviour: BotBehaviour | null): void {
    this.#check(p, 'setBehaviour')
    if (behaviour !== null) this.#known.set(behaviour.id, behaviour)
    this.#behaviour[p] = behaviour
    this.#route[p] = null
    this.#waypoint[p] = -1
  }

  // The delayed input the character received this tick (scratch, not snapshotted).
  actionOf(p: number): number {
    this.#check(p, 'actionOf')
    return this.#last[p]
  }

  #resetPlayer(p: number): void {
    const m = this.#mem[p]
    const fresh = newMemory()
    m.pathIndex = fresh.pathIndex
    m.stuckTicks = fresh.stuckTicks
    m.lastX = fresh.lastX
    m.lastZ = fresh.lastZ
    m.wobble = fresh.wobble
    m.ticks = fresh.ticks
    this.#ring[p].fill(NEUTRAL_CODE)
    this.#head[p] = 0
    this.#route[p] = null
    this.#waypoint[p] = -1
  }

  resetForRound(_ctx: WorldCtx<PlayerInput>): void {
    for (let p = 0; p < this.#playerCount; p++) this.#resetPlayer(p)
  }

  preStep(ctx: WorldCtx<PlayerInput>, _inputs: readonly PlayerInput[]): void {
    if (!ctx.hasSystem('round') || !ctx.hasSystem('obstacles')) return
    const round = ctx.system<RoundSystem>('round')
    const obstacles = ctx.system<ObstacleSystem>('obstacles')
    // RoundSystem exposes no plan before the round is over; a round's course is always
    // picked from the pool of its kind, so the loaded course kind is the plan kind.
    const ci = obstacles.courseIndex
    if (ci < 0) return
    const course = obstacles.courses[ci]
    const survival = course.kind === 'survival'
    const chars = ctx.system<CharacterSystem>('characters')
    const caps = courseCapabilities(course)
    // Bind every profile to the course before a single bot input is written: a useLever
    // profile on a leverless course refuses the tick without half-stepping the others.
    for (let p = 0; p < this.#playerCount; p++) {
      const beh = this.#behaviour[p]
      if (beh !== null && this.#isBot[p] !== 0) bindBehaviour(beh, caps)
    }
    const localTick = obstacles.localTick(ctx)
    for (let p = 0; p < this.#playerCount; p++) {
      if (this.#isBot[p] === 0 || round.status(p) !== PlayerStatus.alive) continue
      const st = chars.state(ctx, p, scratchState)
      if (st.mode === CharMode.parked || st.mode === CharMode.frozen) continue
      const b: BrainInput = {
        course,
        pos: st.pos,
        vel: st.vel,
        facing: st.facing,
        grounded: st.grounded,
        mode: st.mode,
        obstacleAhead: this.#obstacleAhead(ctx, st),
        hazardNear: this.#hazardNear(ctx, st),
      }
      const beh = this.#behaviour[p]
      if (beh !== null) {
        const mem = this.#mem[p]
        trackStuck(mem, st.pos)
        const route = updateRoute(this.#route[p], {
          course, behaviour: beh, pos: st.pos, seed: this.#planSeed[p], tick: localTick,
        })
        this.#route[p] = route
        const next = this.#nextWaypoint(p, course, route, st.pos, beh.route.advanceDist)
        // The brain steers at one node: its nearest-of-list choice would otherwise fall back
        // to a node just passed and orbit it instead of following the route forward.
        const steer = next === null ? route : { ...route, waypoints: [next] }
        b.bot = { behaviour: beh, route: steer, localTick }
      }
      const code = survival
        ? survivalBrain(b, this.#skill[p], this.#mem[p], this.#rng[p])
        : raceBrain(b, this.#skill[p], this.#mem[p], this.#rng[p])
      const out = this.#delay(p, code)
      this.#last[p] = out
      chars.override(p, out)
    }
  }

  // Advance the planner's ordered waypoint list while the current node is within advance
  // distance (same rule as the original race brain). Returns null without a usable waypoint.
  #nextWaypoint(p: number, course: ResolvedCourse, plan: RoutePlan, pos: { x: number; z: number }, advanceDist: number): number | null {
    const list = plan.waypoints
    if (list.length === 0) return null
    let cursor = this.#waypoint[p]
    let at = list.indexOf(cursor)
    if (at < 0) {
      cursor = list.find(w => w >= cursor) ?? list[list.length - 1]
      at = list.indexOf(cursor)
    }
    for (;;) {
      const node = course.path[cursor]
      if (node === undefined) break
      const dx = node.p.x - pos.x, dz = node.p.z - pos.z
      if (Math.sqrt(dx * dx + dz * dz) > advanceDist || at >= list.length - 1) break
      at++
      cursor = list[at]
    }
    this.#waypoint[p] = cursor
    return cursor
  }

  // Ring of reactionTicks entries: the code pushed now comes out reactionTicks ticks later.
  #delay(p: number, code: number): number {
    const ring = this.#ring[p]
    if (ring.length === 0) return code
    const h = this.#head[p]
    const out = ring[h]
    ring[h] = code
    this.#head[p] = h + 1 === ring.length ? 0 : h + 1
    return out
  }

  // Same query pattern as the character ground probe: one scratch Ray, the PROBE group word.
  #obstacleAhead(ctx: WorldCtx<PlayerInput>, st: CharState): boolean {
    if (scratchRay === null) scratchRay = new ctx.R.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 })
    const ray = scratchRay
    const fx = st.facing.x
    const fz = st.facing.z
    const fl = Math.sqrt(fx * fx + fz * fz)
    if (fl < 1e-6) return false
    ray.origin.x = st.pos.x
    ray.origin.y = st.pos.y - CHAR.halfHeight - CHAR.radius + KNEE
    ray.origin.z = st.pos.z
    ray.dir.x = fx / fl
    ray.dir.y = 0
    ray.dir.z = fz / fl
    const hit = ctx.physics.world.castRayAndGetNormal(ray, AHEAD_DIST, true, undefined, PROBE_GROUPS)
    return hit !== null && hit.normal.y < AHEAD_MAX_NY
  }

  // Any MOVING collider whose closest point is within HAZARD_RADIUS horizontally. The result
  // is a boolean, so the callback order of the query does not matter.
  #hazardNear(ctx: WorldCtx<PlayerInput>, st: CharState): boolean {
    if (scratchBall === null) scratchBall = new ctx.R.Ball(HAZARD_RADIUS)
    scratchPos.x = st.pos.x
    scratchPos.y = st.pos.y
    scratchPos.z = st.pos.z
    this.#hazard = false
    ctx.physics.world.intersectionsWithShape(scratchPos, ROT_ID, scratchBall, this.#onHazard, undefined, HAZARD_GROUPS)
    return this.#hazard
  }

  // Bound once, so the query allocates no closure per bot.
  readonly #onHazard = (c: Collider): boolean => {
    if (((c.collisionGroups() >>> 16) & G.MOVING) === 0) return true
    const proj = c.projectPoint(scratchPos, true)
    if (proj === null) return true
    const dx = proj.point.x - scratchPos.x
    const dz = proj.point.z - scratchPos.z
    if (dx * dx + dz * dz <= HAZARD_RADIUS * HAZARD_RADIUS) {
      this.#hazard = true
      return false
    }
    return true
  }

  postStep(_ctx: WorldCtx<PlayerInput>): void {}

  playerDropped(_ctx: WorldCtx<PlayerInput>, p: number): void {
    this.#check(p, 'playerDropped')
    this.#isBot[p] = 1
  }

  snapshot(w: SnapWriter): void {
    for (let p = 0; p < this.#playerCount; p++) {
      const m = this.#mem[p]
      const ring = this.#ring[p]
      w.u8(this.#isBot[p])
      w.u32(this.#rng[p].state)
      w.i32(m.pathIndex)
      w.i32(m.stuckTicks)
      w.f64(m.lastX)
      w.f64(m.lastZ)
      w.f64(m.wobble)
      w.i32(m.ticks)
      w.u32(this.#head[p])
      for (let i = 0; i < ring.length; i++) w.u32(ring[i])
      w.str(this.#behaviour[p]?.id ?? '')
      this.#writePlan(w, this.#route[p])
      w.i32(this.#waypoint[p])
    }
  }

  // Route plans are pure but depend on the position at their last replan tick, so they are
  // snapshotted to make a restore resume exactly where the original plan was heading.
  #writePlan(w: SnapWriter, plan: RoutePlan | null): void {
    w.bool(plan !== null)
    if (plan === null) return
    w.u32(plan.seed)
    w.i32(plan.planTick)
    w.i32(plan.nextPlanTick)
    w.f64(plan.cost)
    w.bool(plan.reachable)
    w.u16(plan.regions.length)
    for (const id of plan.regions) w.i32(id)
    w.u16(plan.edges.length)
    for (const e of plan.edges) { w.i32(e.from); w.i32(e.to) }
    w.u16(plan.waypoints.length)
    for (const i of plan.waypoints) w.i32(i)
  }

  #readPlan(r: SnapReader, p: number, preference: 'short' | 'safe'): RoutePlan | null {
    if (!r.bool()) return null
    const where = `snapshot/bots/${p}/route`
    const plan: RoutePlan = {
      preference, seed: r.u32(), planTick: r.i32(), nextPlanTick: r.i32(), cost: r.f64(),
      reachable: r.bool(), regions: [], edges: [], waypoints: [],
    }
    const len = (what: string): number => {
      const n = r.u16()
      if (n > MAX_PLAN_ITEMS) refuse('bots', where, `${n} ${what}, at most ${MAX_PLAN_ITEMS}; restore a snapshot from the same match setup`)
      return n
    }
    for (let i = len('regions'); i > 0; i--) plan.regions.push(r.i32())
    for (let i = len('edges'); i > 0; i--) plan.edges.push({ from: r.i32(), to: r.i32() })
    for (let i = len('waypoints'); i > 0; i--) plan.waypoints.push(r.i32())
    return plan
  }

  restore(r: SnapReader, _ctx: WorldCtx<PlayerInput>): void {
    for (let p = 0; p < this.#playerCount; p++) {
      const m = this.#mem[p]
      const ring = this.#ring[p]
      this.#isBot[p] = r.u8()
      this.#rng[p].state = r.u32()
      m.pathIndex = r.i32()
      m.stuckTicks = r.i32()
      m.lastX = r.f64()
      m.lastZ = r.f64()
      m.wobble = r.f64()
      m.ticks = r.i32()
      const head = r.u32()
      if (head >= Math.max(1, ring.length)) {
        refuse('bots', `snapshot/bots/${p}/head`, `${head} is outside the reaction ring of ${ring.length}; restore a snapshot from the same match setup`)
      }
      this.#head[p] = head
      for (let i = 0; i < ring.length; i++) ring[i] = r.u32()
      const id = r.str()
      let beh: BotBehaviour | null = null
      if (id !== '') {
        beh = this.#known.get(id) ?? null
        if (beh === null) {
          refuse('bots', `snapshot/bots/${p}/behaviour`, `unknown behaviour '${id}'; restore with the same behaviour profiles`)
        }
      }
      this.#behaviour[p] = beh
      this.#route[p] = this.#readPlan(r, p, beh?.route.preference ?? 'short')
      this.#waypoint[p] = r.i32()
    }
  }
}
