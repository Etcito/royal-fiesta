import { Rng, SnapReader, SnapWriter, fnv1a32 } from '@gamesaloon/rollback'
import type { DomainSim, ShadowView, SleepEvent } from '@gamesaloon/rollback/zones'
import { mergeEntityStreams } from '@gamesaloon/rollback-rapier'
import type { BodyId, RapierDomainSim } from '@gamesaloon/rollback-rapier'
import { CharacterSystem } from '../character/system.ts'
import type { CharState } from '../character/system.ts'
import { inBox, levelOf } from '../course.ts'
import type { LevelSpec, ResolvedCourse, SpawnPoint } from '../course.ts'
import { createFeatures } from '../features/catalog.ts'
import type { CourseFeature, FeatureCtx, FeatureDraw, FeatureSeats, FeatureSound } from '../features/feature.ts'
import { neutralInput } from '../input.ts'
import type { PlayerInput } from '../input.ts'
import { PlayerStatus } from '../match/roundSystem.ts'
import type { PlayerStatusValue } from '../match/roundSystem.ts'
import { MechLogicSystem } from '../mechanisms/logicSystem.ts'
import { MechanismSystem } from '../mechanisms/system.ts'
import { ObstacleSystem } from '../obstacles/system.ts'
import { refuse } from '../refusal.ts'
import { finishCrossed, gateCrossed, newRouteState, readRoute, routeDistanceMm, subTick, writeRoute } from '../season/route.ts'
import type { RouteState } from '../season/route.ts'
import { dueRespawn, newRespawnState, nextSlot, readRespawn, respawnSlot, scheduleRespawn, writeRespawn } from '../season/respawn.ts'
import type { RespawnState } from '../season/respawn.ts'
import { writeBlob } from '../world.ts'
import type { SimSystem, WorldCtx } from '../world.ts'
import { cellOf } from './cells.ts'
import { encodeFar } from './farState.ts'
import { encodeFiestaEvents } from './ledger.ts'
import type { FiestaEvent, MatchLedgerConfig } from './ledger.ts'
import { partMode } from './zonesFile.ts'
import type { ZonesFile } from './zonesFile.ts'
import { seatSpawn } from './seatSpawn.ts'

export interface FiestaDomainConfig {
  readonly course: ResolvedCourse
  readonly zones: ZonesFile
  readonly schedule: MatchLedgerConfig
  /** Roster-indexed spawn assignments; defaults to seat modulo course spawn count. */
  readonly spawnIndices?: readonly number[]
  /** Rebuilds retain the imported body poses and then read the character trailer. */
  readonly placeSeats?: boolean
}

type SeatState = CharState & { seat: number; status: number }

/** The inner recipes own seat entities; applyInput and kinematicParts must be empty hooks.
 * Obstacles are created here as unregistered level bodies, never exported as entities.
 */
export class FiestaDomain implements DomainSim<PlayerInput> {
  readonly inner: RapierDomainSim<PlayerInput>
  readonly characters: CharacterSystem
  readonly obstacles: ObstacleSystem
  readonly mechanisms: MechanismSystem
  readonly mechLogic: MechLogicSystem
  readonly ctx: WorldCtx<PlayerInput>
  readonly features: readonly CourseFeature[]
  readonly #config: FiestaDomainConfig
  readonly #featureCtxs: readonly FeatureCtx[]
  readonly #featureSeats: FeatureSeats
  readonly #featureSounds: FeatureSound[] = []
  readonly #neutralInputs: readonly PlayerInput[]
  readonly #seats: readonly number[]
  readonly #entities: number[] = []
  readonly #bodies: BodyId[] = []
  readonly #status: Uint8Array
  readonly #checkpoint: Int16Array
  readonly #level: LevelSpec
  readonly #route: RouteState
  readonly #respawn: RespawnState
  readonly #prevY: Float64Array
  readonly #before: Float64Array
  readonly #spawn: SpawnPoint = { t: { x: 0, y: 0, z: 0 }, facing: { x: 0, z: 1 } }
  readonly #states: SeatState[] = []
  readonly #eventPool: FiestaEvent[] = []
  readonly #events: FiestaEvent[] = []
  readonly #seesaws: number[] = []
  readonly #seesaw = { angle: 0, prevAngle: 0, angVel: 0 }
  readonly #writer = new SnapWriter()
  #inputs: readonly PlayerInput[]
  #stepTick = -1

  constructor(inner: RapierDomainSim<PlayerInput>, config: FiestaDomainConfig) {
    this.inner = inner
    this.#config = config
    this.#seats = inner.spec.seats.slice()
    const n = this.#seats.length
    this.#status = new Uint8Array(n).fill(PlayerStatus.alive)
    this.#checkpoint = new Int16Array(n)
    this.features = createFeatures(config.course, config.course.id)
    this.#neutralInputs = Array.from({ length: n }, () => neutralInput())
    this.#inputs = this.#neutralInputs
    this.#level = levelOf(config.course)
    this.#route = newRouteState(n)
    // Spawn anchors follow checkpoint and home anchors, one per roster seat.
    this.#respawn = newRespawnState(n, config.course.checkpoints.length + this.#level.homes.length + config.schedule.seatCount)
    this.#prevY = new Float64Array(n)
    this.#before = new Float64Array(n * 3)
    this.characters = new CharacterSystem({ playerCount: n, externalBodies: true })
    this.obstacles = new ObstacleSystem([config.course])
    this.mechanisms = new MechanismSystem([config.course])
    this.mechLogic = new MechLogicSystem([config.course])
    const domain = this
    this.ctx = {
      R: inner.world.sim.R,
      get physics() { return inner.world.sim },
      get tick() { return domain.#stepTick >= 0 ? domain.#stepTick : inner.tick },
      get dt() { return inner.world.sim.dt },
      playerCount: n,
      get resimulating() { return inner.resimulating },
      system<S extends SimSystem<PlayerInput>>(name: string): S {
        const system = domain.#system(name)
        if (system === undefined) refuse('fiestaDomain', `system/${name}`, 'unknown system; use obstacles, mechanisms, mechLogic or characters')
        return system as S
      },
      hasSystem(name: string): boolean { return domain.#system(name) !== undefined },
    }
    this.#indexSeats()
    this.#bindBodies()
    this.obstacles.init(this.ctx)
    // All domain-local obstacle clocks have the same origin, including rebuilt worlds.
    this.#stepTick = 0
    this.obstacles.load(this.ctx, 0)
    this.mechanisms.load(this.ctx, 0)
    this.mechLogic.load(this.ctx, 0)
    this.#stepTick = -1
    this.obstacles.placeKinematic(this.ctx, this.tick)
    this.placeMechanisms()
    this.characters.init(this.ctx)
    for (let p = 0; p < n; p++) {
      const seat = this.#seats[p]
      // A seat past the course's spawns starts in a row behind them (seatSpawn), never inside another seat.
      const spawn = config.spawnIndices?.[seat] ?? seat
      if (!Number.isInteger(spawn) || spawn < 0 ||
          (config.spawnIndices !== undefined && spawn >= config.course.spawns.length)) {
        refuse('fiestaDomain', `spawns/${seat}`, 'missing spawn; provide a course spawn for every seat')
      }
      this.#checkpoint[p] = -1 - spawn
      if (config.placeSeats !== false) this.characters.place(this.ctx, p, seatSpawn(config.course, spawn))
      this.#states.push({ seat, status: PlayerStatus.alive, pos: { x: 0, y: 0, z: 0 },
        vel: { x: 0, y: 0, z: 0 }, facing: { x: 0, z: 0 }, mode: 0,
        grounded: false, groundObstacle: -1, knockbacks: 0, teleportTick: 0 })
      this.#prevY[p] = this.characters.state(this.ctx, p, this.#states[p]).pos.y
    }
    for (let i = 0; i < config.course.obstacles.length; i++) {
      const o = config.course.obstacles[i]
      if (o.motion.kind === 'seesaw' && partMode(config.zones, o) === 'physics' &&
          inner.spec.cells.includes(cellOf(config.zones.grid, o.t.x, o.t.z))) this.#seesaws.push(i)
    }
    this.#featureSeats = this.#createFeatureSeats()
    const root = new Rng(config.schedule.seed)
    const ctxs: FeatureCtx[] = []
    for (let i = 0; i < this.features.length; i++) {
      ctxs.push(this.#createFeatureCtx(root.fork(fnv1a32(new TextEncoder().encode(this.features[i].id)))))
    }
    this.#featureCtxs = ctxs
    for (let i = 0; i < this.features.length; i++) this.features[i].init(ctxs[i])
  }

  #system(name: string): SimSystem<PlayerInput> | undefined {
    switch (name) {
      case 'obstacles': return this.obstacles
      case 'mechanisms': return this.mechanisms as SimSystem<unknown> as SimSystem<PlayerInput>
      case 'mechLogic': return this.mechLogic as SimSystem<unknown> as SimSystem<PlayerInput>
      case 'characters': return this.characters
      default: return undefined
    }
  }

  /** Poses every animated mechanism body where its animation is at this tick (creation and handoff). */
  placeMechanisms(): void {
    this.mechLogic.placeAnimations(this.ctx, this.mechanisms)
  }

  /** Handoff: takes the mechanism and logic state of a source domain (the bodies were just created here). */
  adoptMechanisms(logic: SnapReader, mechanisms: SnapReader, dynamic: SnapReader): void {
    this.mechLogic.restore(logic, this.ctx, true)
    this.mechanisms.restore(mechanisms, this.ctx, true)
    this.mechanisms.importDynamic(this.ctx, dynamic)
    this.placeMechanisms()
  }

  get tick(): number { return this.inner.tick }
  set tick(tick: number) { this.inner.tick = tick }
  get seats(): readonly number[] { return this.#seats }
  get host(): Int16Array { return this.inner.host }
  get bot(): Uint8Array { return this.inner.bot }

  #indexSeats(): void {
    this.#writer.reset()
    this.inner.exportEntities(this.#writer)
    const records = mergeEntityStreams([new SnapReader(this.#writer.bytes())]).entities
    this.#entities.length = 0
    for (const seat of this.#seats) {
      const entity = records.find(record => record.owner === seat)
      if (entity === undefined) refuse('fiestaDomain', `seats/${seat}`, 'missing entity; spawn the seat in the inner world')
      this.#entities.push(entity.id)
    }
  }

  #bindBodies(): void {
    for (let p = 0; p < this.#entities.length; p++) this.#bodies[p] = this.inner.world.bodyOf(this.#entities[p])
    this.characters.bindBodies(this.#bodies)
  }

  #player(seat: number): number {
    const p = this.#seats.indexOf(seat)
    if (p < 0) refuse('fiestaDomain', `seats/${seat}`, 'seat is not in this domain; query its owning domain')
    return p
  }

  #charState(p: number): CharState {
    return this.characters.state(this.ctx, p, this.#states[p])
  }

  #featureNow(): number {
    return this.#stepTick >= 0 ? this.#stepTick : this.inner.tick
  }

  #createFeatureSeats(): FeatureSeats {
    const domain = this
    return {
      get count() { return domain.#seats.length },
      seat(i: number) { return domain.#seats[i] },
      pos(i: number, out) {
        const s = domain.#charState(i)
        out.x = s.pos.x
        out.y = s.pos.y
        out.z = s.pos.z
        return out
      },
      vel(i: number, out) {
        const s = domain.#charState(i)
        out.x = s.vel.x
        out.y = s.vel.y
        out.z = s.vel.z
        return out
      },
      mode(i: number) { return domain.#charState(i).mode },
      grounded(i: number) { return domain.#charState(i).grounded },
      groundCollider(i: number) { return domain.#charState(i).groundObstacle },
      status(i: number) { return domain.#status[i] },
      team(i: number) { return domain.#config.schedule.teams?.[domain.#seats[i]] ?? 0 },
      input(i: number) { return domain.#inputs[i] },
      protectedNow(i: number) {
        const until = domain.#charState(i).protectedUntil ?? -1
        return until >= 0 && domain.#featureNow() < until
      },
      setVelocity(i: number, v) {
        domain.ctx.physics.body(domain.#bodies[i]).setLinvel({ x: v.x, y: v.y, z: v.z }, true)
      },
      addVelocity(i: number, v) {
        const body = domain.ctx.physics.body(domain.#bodies[i])
        const cur = body.linvel()
        body.setLinvel({ x: cur.x + v.x, y: cur.y + v.y, z: cur.z + v.z }, true)
      },
      teleport(i: number, at: SpawnPoint) { domain.characters.place(domain.ctx, i, at) },
      kill(i: number) { domain.#killSeat(i) },
      setCarry(i: number, kind: number, id: number) { domain.characters.setCarry(i, kind, id) },
      carry(i: number) { return domain.#charState(i).carry ?? 0 },
      facing(i: number, out) {
        const s = domain.#charState(i)
        out.x = s.facing.x
        out.y = 0
        out.z = s.facing.z
        return out
      },
      setSwim(i: number, inside: boolean, drag: number, buoyancy: number) {
        domain.characters.setSwim(domain.ctx, i, inside, drag, buoyancy)
      },
      knock(i: number, v) { domain.characters.knock(domain.ctx, i, v) },
    }
  }

  #createFeatureCtx(rng: Rng): FeatureCtx {
    const domain = this
    return {
      get R() { return domain.inner.world.sim.R },
      get physics() { return domain.inner.world.sim },
      get tick() { return domain.#featureNow() },
      get roundTick() { return domain.#featureNow() - domain.#config.schedule.introTicks },
      get entrants() { return domain.#config.schedule.seatCount },
      get overtime() {
        const schedule = domain.#config.schedule
        return domain.#featureNow() > schedule.introTicks + schedule.roundTicks
      },
      trailingTeam: -1,
      get course() { return domain.#config.course },
      get seats() { return domain.#featureSeats },
      get rng() { return rng },
      emit(kind, seat, a, b) { domain.#emitSeat(seat, kind, a, b) },
      sound(id, pos, strength) {
        domain.#featureSounds.push({ id, pos: { x: pos.x, y: pos.y, z: pos.z }, strength, loop: false })
      },
    }
  }

  /** Without out, returns borrowed scratch, valid until the next query or step. */
  state(seat: number, out?: CharState): CharState {
    const p = this.#player(seat)
    this.#bindBodies()
    return this.characters.state(this.ctx, p, out ?? this.#states[p])
  }

  status(seat: number): PlayerStatusValue { return this.#status[this.#player(seat)] as PlayerStatusValue }

  drawFeatures(out: FeatureDraw[]): number {
    const start = out.length
    for (let i = 0; i < this.features.length; i++) this.features[i].draw(out)
    return out.length - start
  }

  drainFeatureSounds(out: FeatureSound[]): number {
    const start = out.length
    let kept = 0
    for (let i = 0; i < this.#featureSounds.length; i++) {
      const sound = this.#featureSounds[i]
      if (sound.loop) this.#featureSounds[kept++] = sound
      else out.push(sound)
    }
    this.#featureSounds.length = kept
    return out.length - start
  }

  step(inputs: readonly PlayerInput[], shadows: ShadowView): void {
    if (inputs.length !== this.#seats.length) refuse('fiestaDomain', 'inputs', 'wrong count; pass inputs in spec.seats order')
    this.#events.length = 0
    this.#inputs = inputs
    this.#stepTick = this.tick
    try {
      this.#bindBodies()
      this.obstacles.preStep(this.ctx, inputs)
      this.mechLogic.preStep(this.ctx, inputs)
      this.mechanisms.preStep(this.ctx, inputs)
      const schedule = this.#config.schedule
      const frozen = this.#stepTick < schedule.introTicks || this.#stepTick > schedule.introTicks + schedule.roundTicks + schedule.overtimeTicks
      for (let p = 0; p < this.#seats.length; p++) {
        this.characters.freeze(p, frozen)
        const pos = this.characters.state(this.ctx, p, this.#states[p]).pos
        this.#before[p * 3] = pos.x
        this.#before[p * 3 + 1] = pos.y
        this.#before[p * 3 + 2] = pos.z
      }
      this.characters.preStep(this.ctx, inputs)
      for (let i = 0; i < this.features.length; i++) this.features[i].preStep(this.#featureCtxs[i])
      this.inner.step(inputs, shadows)
      this.mechLogic.postStep(this.ctx)
      this.mechanisms.postStep(this.ctx)
      this.characters.postStep(this.ctx)
      for (let i = 0; i < this.features.length; i++) this.features[i].postStep(this.#featureCtxs[i])
      if (!frozen) this.#seatRules()
    } finally {
      this.#inputs = this.#neutralInputs
      this.#stepTick = -1
    }
  }

  #seatRules(): void {
    const course = this.#config.course
    const { route } = this.#level
    const lastStage = route.stages.length ? route.stages[route.stages.length - 1] : -1
    for (let p = 0; p < this.#seats.length; p++) {
      if (this.#status[p] !== PlayerStatus.alive) continue
      if (this.#respawn.waitUntil[p] >= 0) {
        if (dueRespawn(this.#respawn, p, this.#stepTick)) this.#placeRespawn(p)
        continue
      }
      const pos = this.characters.state(this.ctx, p, this.#states[p]).pos
      for (let c = 0; c < course.checkpoints.length; c++) {
        if (inBox(course.checkpoints[c].box, pos) && gateCrossed(route, this.#route, p, c)) {
          this.#checkpoint[p] = c
          this.#emit(p, 'gate', this.#route.stage[p], this.#route.lap[p])
        }
      }
      if (course.finish !== null && inBox(course.finish, pos)) {
        const result = finishCrossed(route, this.#route, p, lastStage)
        if (result === 'lap') this.#emit(p, 'gate', this.#route.stage[p], this.#route.lap[p])
        if (result === 'finish') {
          // The latest entry across the three slabs is entry into the box.
          let crossing = 0
          const axes = ['x', 'y', 'z'] as const
          for (let i = 0; i < axes.length; i++) {
            const axis = axes[i]
            const prev = this.#before[p * 3 + i]
            const lo = course.finish.center[axis] - course.finish.half[axis]
            const hi = course.finish.center[axis] + course.finish.half[axis]
            if (prev < lo) crossing = Math.max(crossing, subTick(prev, pos[axis], lo))
            else if (prev > hi) crossing = Math.max(crossing, subTick(prev, pos[axis], hi))
          }
          this.#status[p] = PlayerStatus.qualified
          this.#emit(p, 'finish', crossing, this.#route.lap[p])
          this.characters.park(this.ctx, p)
          continue
        }
      }
      if (pos.y < course.killPlaneY) {
        this.#fall(p, subTick(this.#prevY[p], pos.y, course.killPlaneY))
        continue
      }
      this.#prevY[p] = pos.y
    }
    const schedule = this.#config.schedule
    if ((schedule.kind === 'race' || schedule.kind === 'final') &&
        (this.#stepTick - schedule.introTicks) % 30 === 0) {
      for (let p = 0; p < this.#seats.length; p++) {
        if (this.#status[p] !== PlayerStatus.alive) continue
        const pos = this.characters.state(this.ctx, p, this.#states[p]).pos
        this.#emit(p, 'progress', routeDistanceMm(course, route, this.#route.stage[p], pos))
      }
    }
  }

  #fall(p: number, crossing: number): void {
    const { respawn } = this.#level
    if (respawn.mode === 'none') {
      this.#status[p] = PlayerStatus.eliminated
      this.#emit(p, 'eliminate', crossing)
      this.characters.park(this.ctx, p)
      return
    }
    this.#emit(p, 'fall', crossing)
    this.characters.park(this.ctx, p)
    scheduleRespawn(respawn, this.#respawn, p, this.#stepTick)
    if (dueRespawn(this.#respawn, p, this.#stepTick)) this.#placeRespawn(p)
  }

  #killSeat(p: number): void {
    if (p < 0 || p >= this.#seats.length || this.#status[p] !== PlayerStatus.alive) return
    const pos = this.#charState(p).pos
    this.#fall(p, subTick(this.#prevY[p], pos.y, this.#config.course.killPlaneY))
  }

  #placeRespawn(p: number): void {
    const course = this.#config.course
    const { respawn, homes } = this.#level
    const c = this.#checkpoint[p]
    const seat = this.#seats[p]
    let base = c >= 0 ? course.checkpoints[c].respawn : seatSpawn(course, -1 - c)
    let anchor = c >= 0 ? c : course.checkpoints.length + homes.length + seat
    if (respawn.mode === 'home') {
      const team = this.#config.schedule.teams?.[seat]
      const home = homes.findIndex(h => h.team === team)
      if (home >= 0) {
        anchor = course.checkpoints.length + home
        base = homes[home].respawn[0]
      }
    }
    const slot = nextSlot(this.#respawn, anchor, respawn)
    // Legacy immediate recovery retains the exact checkpoint/spawn placement.
    this.characters.place(this.ctx, p, respawn.waitTicks === 0 ? base : respawnSlot(base, slot, respawn, this.#spawn))
    this.#respawn.waitUntil[p] = -1
    this.#respawn.protectUntil[p] = this.#stepTick + respawn.protectTicks
    this.characters.setProtected(p, this.#respawn.protectUntil[p])
    this.#prevY[p] = this.characters.state(this.ctx, p, this.#states[p]).pos.y
  }

  #emit(p: number, kind: FiestaEvent['kind'], a = 0, b = 0): void {
    this.#emitSeat(this.#seats[p], kind, a, b)
  }

  #emitSeat(seat: number, kind: FiestaEvent['kind'], a = 0, b = 0): void {
    const index = this.#events.length
    const event = this.#eventPool[index] ?? (this.#eventPool[index] = { kind, seat: 0, tick: 0, a: 0, b: 0 })
    event.kind = kind
    event.seat = seat
    event.tick = this.#featureNow()
    event.a = a
    event.b = b
    this.#events.push(event)
  }

  snapshot(w: SnapWriter): void {
    this.inner.snapshot(w)
    this.obstacles.snapshot(w)
    this.mechLogic.snapshot(w)
    this.mechanisms.snapshot(w)
    this.characters.snapshot(w)
    for (let p = 0; p < this.#seats.length; p++) {
      w.u8(this.#status[p])
      w.i16(this.#checkpoint[p])
      w.f64(this.#prevY[p])
    }
    writeRoute(w, this.#route)
    writeRespawn(w, this.#respawn)
    for (let i = 0; i < this.features.length; i++) this.features[i].snapshot(w)
  }

  restore(r: SnapReader): void {
    this.inner.restore(r)
    this.obstacles.restore(r, this.ctx)
    this.mechLogic.restore(r, this.ctx)
    this.mechanisms.restore(r, this.ctx)
    this.characters.restore(r, this.ctx)
    for (let p = 0; p < this.#seats.length; p++) {
      this.#status[p] = r.u8()
      this.#checkpoint[p] = r.i16()
      this.#prevY[p] = r.f64()
    }
    readRoute(r, this.#route)
    readRespawn(r, this.#respawn)
    this.restoreFeatures(r)
    this.#indexSeats()
    this.#bindBodies()
    this.#events.length = 0
  }

  restoreFeatures(r: SnapReader): void {
    for (let i = 0; i < this.features.length; i++) this.features[i].restore(r, this.#featureCtxs[i])
    this.#featureSounds.length = 0
  }

  hash(): number { return this.inner.hash() }

  /** Blob(inner export), u16 seats, (u16 seat, player, u8 status, i16 checkpoint,
   * i16 stage, u8 lap, u8 finished, i32 waitUntil, i32 protectUntil, f64 prevY),
   * u16 seesaws, (u16 obstacle index, f64 angle, f64 prevAngle, f64 angVel),
   * Blob(mechLogic snapshot), Blob(mechanisms snapshot), Blob(dynamic mechanism bodies),
   * Blob(course feature states in course features order).
   * A negative checkpoint encodes the original spawn as -1 - spawnIndex.
   */
  exportEntities(w: SnapWriter): void {
    this.#writer.reset()
    this.inner.exportEntities(this.#writer)
    writeBlob(w, this.#writer.bytes())
    w.u16(this.#seats.length)
    for (let p = 0; p < this.#seats.length; p++) {
      w.u16(this.#seats[p])
      this.characters.writePlayer(w, p)
      this.#writeStatus(w, p)
    }
    w.u16(this.#seesaws.length)
    for (let s = 0; s < this.#seesaws.length; s++) {
      const i = this.#seesaws[s]
      const state = this.obstacles.seesawState(i, this.#seesaw)
      w.u16(i)
      w.f64(state.angle)
      w.f64(state.prevAngle)
      w.f64(state.angVel)
    }
    this.#writer.reset()
    this.mechLogic.snapshot(this.#writer)
    const logic = this.#writer.bytes().slice()
    this.#writer.reset()
    this.mechanisms.snapshot(this.#writer)
    const mechanisms = this.#writer.bytes().slice()
    this.#writer.reset()
    this.mechanisms.exportDynamic(this.ctx, this.#writer)
    const dynamic = this.#writer.bytes().slice()
    this.#writer.reset()
    for (let i = 0; i < this.features.length; i++) this.features[i].snapshot(this.#writer)
    writeBlob(w, logic)
    writeBlob(w, mechanisms)
    writeBlob(w, dynamic)
    writeBlob(w, this.#writer.bytes())
  }

  #writeStatus(w: SnapWriter, p: number): void {
    w.u8(this.#status[p])
    w.i16(this.#checkpoint[p])
    w.i16(this.#route.stage[p])
    w.u8(this.#route.lap[p])
    w.u8(this.#route.finished[p])
    w.i32(this.#respawn.waitUntil[p])
    w.i32(this.#respawn.protectUntil[p])
    w.f64(this.#prevY[p])
  }

  #readStatus(r: SnapReader, p: number): void {
    this.#status[p] = r.u8()
    this.#checkpoint[p] = r.i16()
    this.#route.stage[p] = r.i16()
    this.#route.lap[p] = r.u8()
    this.#route.finished[p] = r.u8()
    this.#respawn.waitUntil[p] = r.i32()
    this.#respawn.protectUntil[p] = r.i32()
    this.#prevY[p] = r.f64()
  }

  /** Factory handoffs read the seat id first, then restore this seat's trailer block. */
  readSeat(r: SnapReader, seat: number): void {
    const p = this.#player(seat)
    this.characters.readPlayer(r, p)
    this.#readStatus(r, p)
    this.#bindBodies()
    this.characters.restoreBody(this.ctx, p)
  }

  shadowOut(w: SnapWriter, to: number): void { this.inner.shadowOut(w, to) }
  events(w: SnapWriter): void { encodeFiestaEvents(w, this.#events) }

  far(w: SnapWriter, _stride: number): void {
    this.#bindBodies()
    for (let p = 0; p < this.#seats.length; p++) {
      this.characters.state(this.ctx, p, this.#states[p])
      this.#states[p].status = this.#status[p]
    }
    encodeFar(w, this.#states)
  }

  seatHost(seat: number, peer: number, bot: boolean): void { this.inner.seatHost(seat, peer, bot) }
  sleepEvents(out: SleepEvent[]): void { this.inner.sleepEvents(out) }
  sleepPose(id: number, w: SnapWriter): boolean { return this.inner.sleepPose(id, w) }
  beginResim(): void { this.inner.beginResim() }
  endResim(): void { this.inner.endResim() }
}
