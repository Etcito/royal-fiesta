// Binds a MatchSim to a RenderPort: bean and obstacle instances, interpolated poses and the follow camera.
// View side only: reads the sim view API and the smoother, never writes either.
import type { CorrectionSmoother } from '@gamesaloon/rollback'
import type { PrimsAsset } from '@royal-fiesta/game/prims'
import type { ResolvedCourse } from '@royal-fiesta/sim/course'
import type { CharacterView, MatchSim, MatchViewState } from '@royal-fiesta/sim/match/matchSim'
import { Phase } from '@royal-fiesta/sim/match/matchSim'
import { pose } from '@royal-fiesta/sim/vec'
import { NO_DRESSING } from '../content.ts'
import type { CourseDressing } from '../content.ts'
import { followCamera } from './camera.ts'
import { PALETTE } from './palette.ts'
import type { CameraPose, RenderPort } from './port.ts'

export interface SceneViewOptions {
  port: RenderPort; viewport: number; localPlayer: number; assets: (name: string) => PrimsAsset; bean: PrimsAsset
  // Replaces followCamera while the camera frames the local player (not the podium).
  camera?: (focus: { x: number; y: number; z: number }, frameDtS: number) => CameraPose
  // The content's character asset (GameContent.character()); the bean when absent.
  character?: PrimsAsset
  // Course decor and environment, swapped on every course change. Default NO_DRESSING.
  dressing?: CourseDressing
}

const UNIT: readonly [number, number, number] = [1, 1, 1]
// Pose layout in the obstacle buffers: t xyz then r xyzw.
const OB = 7

export class SceneView {
  private readonly opts: SceneViewOptions
  private readonly port: RenderPort
  private readonly beanAsset: number
  private readonly dressing: CourseDressing
  // Course id whose dressing is entered, so leave() pairs with exactly one enter().
  private dressed: string | null = null
  // registerAsset is idempotent, but the handle is cached so each name is registered once.
  private readonly handles = new Map<string, number>()
  private beans: number[] = []
  private beanShown: boolean[] = []
  private obstacles: number[] = []
  private course: ResolvedCourse | null = null
  private ci = -1
  private tick = -1
  private obPrev = new Float64Array(0)
  private obCur = new Float64Array(0)
  private chPrev = new Float64Array(0)
  private chCur = new Float64Array(0)
  private facing = new Float64Array(0)
  private cam: CameraPose | null = null
  private readonly state: MatchViewState = {
    tick: 0, phase: 0, phaseTicksLeft: 0, roundIndex: 0, roundKind: null, final: false, courseIndex: -1,
    roundTicksLeft: 0, alive: 0, target: 0, qualifiedCount: 0, winner: -1, podium: [],
  }
  private readonly view: CharacterView = {
    pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, facing: { x: 0, z: 1 },
    mode: 0, status: 0, parked: false, teleportTick: -1,
  }
  private readonly pose = pose()
  private readonly shown = new Float64Array(3)

  constructor(opts: SceneViewOptions) {
    this.opts = opts
    this.port = opts.port
    this.dressing = opts.dressing ?? NO_DRESSING
    const character = opts.character ?? opts.bean
    this.beanAsset = this.asset(character.id, character)
  }

  get camera(): CameraPose | null {
    return this.cam
  }

  get instanceCount(): number {
    return this.beans.length + this.obstacles.length
  }

  get courseIndex(): number {
    return this.ci
  }

  update(sim: MatchSim, smoother: CorrectionSmoother | null, alpha: number, frameDtS: number): void {
    const port = this.port
    this.ci = sim.phase(this.state).courseIndex
    const course = sim.course()
    let reset = false
    if (course !== this.course) {
      this.loadObstacles(sim, course)
      this.dress(course)
      reset = true
    }
    const players = sim.setup.playerCount
    if (this.beans.length === 0) this.createBeans(players)

    const tick = sim.tick
    const advanced = tick !== this.tick
    if (advanced || reset) {
      this.readObstacles(sim, advanced && !reset)
      this.readCharacters(sim, advanced && !reset, tick)
      this.tick = tick
    }

    const t: [number, number, number] = [0, 0, 0]
    const r: [number, number, number, number] = [0, 0, 0, 1]
    const prev = this.obPrev
    const cur = this.obCur
    for (let i = 0; i < this.obstacles.length; i++) {
      const b = i * OB
      for (let k = 0; k < 3; k++) t[k] = prev[b + k] + (cur[b + k] - prev[b + k]) * alpha
      // nlerp along the shorter arc.
      const dot = prev[b + 3] * cur[b + 3] + prev[b + 4] * cur[b + 4] + prev[b + 5] * cur[b + 5] + prev[b + 6] * cur[b + 6]
      const sign = dot < 0 ? -1 : 1
      let n = 0
      for (let k = 0; k < 4; k++) {
        const a = prev[b + 3 + k]
        r[k] = a + (cur[b + 3 + k] * sign - a) * alpha
        n += r[k] * r[k]
      }
      n = Math.sqrt(n)
      for (let k = 0; k < 4; k++) r[k] /= n
      const s = this.course!.obstacles[i].s
      port.setTransform(this.obstacles[i], t, r, [s.x, s.y, s.z])
    }

    const c = this.view
    const d = this.shown
    const local = this.opts.localPlayer
    let camPos: { x: number; y: number; z: number } | null = null
    let camFacing = { x: 0, z: 1 }
    let onLocal = false
    for (let p = 0; p < players; p++) {
      sim.character(p, c)
      if (c.parked) {
        this.show(p, false)
        continue
      }
      this.show(p, true)
      const b = p * 3
      for (let k = 0; k < 3; k++) d[k] = this.chPrev[b + k] + (this.chCur[b + k] - this.chPrev[b + k]) * alpha
      if (smoother !== null) smoother.applyEntity(p, d)
      const fx = this.facing[p * 2]
      const fz = this.facing[p * 2 + 1]
      const half = Math.atan2(fx, fz) / 2
      port.setTransform(this.beans[p], [d[0], d[1], d[2]], [0, Math.sin(half), 0, Math.cos(half)], UNIT)
      if (p === local) {
        camPos = { x: d[0], y: d[1], z: d[2] }
        camFacing = { x: fx, z: fz }
        onLocal = true
      }
    }
    // The podium freezes the winners and parks the rest, so the local player may have no camera:
    // frame the podium itself or the capture is the void.
    if (this.state.phase === Phase.podium && this.state.podium.length > 0) {
      let px = 0
      let py = 0
      let pz = 0
      for (let i = 0; i < this.state.podium.length; i++) {
        const b = this.state.podium[i] * 3
        px += this.chCur[b]
        py += this.chCur[b + 1]
        pz += this.chCur[b + 2]
      }
      const n = this.state.podium.length
      camPos = { x: px / n, y: py / n, z: pz / n }
      camFacing = { x: 0, z: 1 }
      onLocal = false
    }
    if (camPos !== null) {
      const hook = this.opts.camera
      this.cam = hook !== undefined && onLocal ? hook(camPos, frameDtS) : followCamera(this.cam, camPos, camFacing, frameDtS)
      port.setCamera(this.opts.viewport, this.cam)
    }
  }

  dispose(): void {
    for (let i = 0; i < this.beans.length; i++) this.port.destroyInstance(this.beans[i])
    for (let i = 0; i < this.obstacles.length; i++) this.port.destroyInstance(this.obstacles[i])
    this.beans = []
    this.beanShown = []
    this.obstacles = []
    this.dress(null)
    this.course = null
    this.tick = -1
  }

  private asset(name: string, a: PrimsAsset): number {
    let h = this.handles.get(name)
    if (h === undefined) {
      h = this.port.registerAsset(name, a)
      this.handles.set(name, h)
    }
    return h
  }

  private loadObstacles(sim: MatchSim, course: ResolvedCourse | null): void {
    for (let i = 0; i < this.obstacles.length; i++) this.port.destroyInstance(this.obstacles[i])
    this.obstacles = []
    this.course = course
    const n = course === null ? 0 : sim.obstacleCount()
    for (let i = 0; i < n; i++) {
      const spec = sim.obstacleSpec(i)
      this.obstacles.push(this.port.createInstance(this.asset(spec.asset, this.opts.assets(spec.asset)), null))
    }
    this.obPrev = new Float64Array(n * OB)
    this.obCur = new Float64Array(n * OB)
  }

  private dress(course: ResolvedCourse | null): void {
    if (this.dressed !== null) this.dressing.leave(this.port)
    this.dressed = null
    if (course === null) return
    this.dressing.enter(this.port, course.id)
    this.dressed = course.id
  }

  private createBeans(players: number): void {
    for (let p = 0; p < players; p++) {
      this.beans.push(this.port.createInstance(this.beanAsset, PALETTE[p]))
      this.beanShown.push(true)
    }
    this.chPrev = new Float64Array(players * 3)
    this.chCur = new Float64Array(players * 3)
    this.facing = new Float64Array(players * 2)
  }

  // keep = false after a course change: prev = cur, so nothing is interpolated across the reset.
  private readObstacles(sim: MatchSim, keep: boolean): void {
    if (keep) {
      // The old cur becomes prev; the old prev buffer is reused for the new cur.
      const t = this.obPrev
      this.obPrev = this.obCur
      this.obCur = t
    }
    const prev = this.obPrev
    const cur = this.obCur
    const q = this.pose
    for (let i = 0; i < this.obstacles.length; i++) {
      const b = i * OB
      sim.obstaclePose(i, q)
      cur[b] = q.t.x
      cur[b + 1] = q.t.y
      cur[b + 2] = q.t.z
      cur[b + 3] = q.r.x
      cur[b + 4] = q.r.y
      cur[b + 5] = q.r.z
      cur[b + 6] = q.r.w
      if (!keep) for (let k = 0; k < OB; k++) prev[b + k] = cur[b + k]
    }
  }

  private readCharacters(sim: MatchSim, keep: boolean, tick: number): void {
    const c = this.view
    for (let p = 0; p < this.beans.length; p++) {
      sim.character(p, c)
      const b = p * 3
      const fresh = !keep || c.teleportTick >= tick - 2
      if (!fresh) {
        this.chPrev[b] = this.chCur[b]
        this.chPrev[b + 1] = this.chCur[b + 1]
        this.chPrev[b + 2] = this.chCur[b + 2]
      }
      this.chCur[b] = c.pos.x
      this.chCur[b + 1] = c.pos.y
      this.chCur[b + 2] = c.pos.z
      if (fresh) {
        this.chPrev[b] = c.pos.x
        this.chPrev[b + 1] = c.pos.y
        this.chPrev[b + 2] = c.pos.z
      }
      this.facing[p * 2] = c.facing.x
      this.facing[p * 2 + 1] = c.facing.z
    }
  }

  private show(p: number, visible: boolean): void {
    if (this.beanShown[p] === visible) return
    this.port.setVisible(this.beans[p], visible)
    this.beanShown[p] = visible
  }
}
