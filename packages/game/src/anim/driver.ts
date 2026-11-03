import { multiplyInto, localMatrixInto } from './poseMath.ts'
import type { AnimationGraph, AnimationGraphState, GraphStep } from './brick.ts'
import { loadAnimBrick } from './brick.ts'
import { POSE_LAYERS, type PoseLayerInstance } from './layers.ts'
import { WALK_LAYER, type WalkLayerInstance } from './walkCycle.ts'
import { localPose, toPoseFrame, VisualIk, type CharacterTransform, type IkActive, type IkTargets } from './ik.ts'
import { mapParams, newParamMemory, type CharObservation, type ParamMemory } from './params.ts'

type Brick = Awaited<ReturnType<typeof loadAnimBrick>>
type Rig = ReturnType<Brick['loadRig']>
type Clip = ReturnType<Brick['loadClip']>
export type CharacterPose = GraphStep & Pick<ReturnType<Brick['sampleClip']>, 'model'> & { readonly local?: Float32Array; readonly ik?: IkActive }
/** `xf` and `ik` are the sim placement and targets for visual IK; the corrected pose never reaches the sim. */
export interface CharacterObservation extends CharObservation {
  readonly id: number; readonly xf?: CharacterTransform; readonly ik?: IkTargets
}
interface Execution {
  state: AnimationGraphState; refs: number; tick: number; before?: Uint8Array
}
interface Entry {
  cohort: number; layers: PoseLayerInstance[]; walk: WalkLayerInstance
  execution: Execution; memory: ParamMemory; pose?: CharacterPose
}

interface SharedPose {
  cohort: number; execution: Execution; base: CharacterPose
  ik: Map<string, CharacterPose>
}

// Translation/yaw are instance placement, not animation state. Round only world-to-local
// cancellation noise (10 nanometres); different ground planes, grabs and look targets stay separate.
function ikKey(xf: CharacterTransform, targets: IkTargets): string {
  const point = (v: { x: number; y: number; z: number } | null | undefined, direction = false) =>
    v == null ? null : toPoseFrame(v, xf, direction).map(n => Math.round(n * 1e8))
  return JSON.stringify([targets.mode, point(targets.look), point(targets.grab),
    point(targets.ground?.point), point(targets.ground?.normal, true)])
}

// Column-major multiplication: skin * restModel recovers the animated bone model.
function multiply(a: ArrayLike<number>, b: ArrayLike<number>): Float32Array {
  const out = new Float32Array(16)
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    for (let k = 0; k < 4; k++) out[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k]
  }
  return out
}

interface RestBone {
  name: string; parent: string | null
  rest: { t: number[]; r: number[]; s: number[] }
}
function localMatrix(t: ArrayLike<number>, r: ArrayLike<number>, s: ArrayLike<number>): Float32Array {
  const [x, y, z, w] = Array.from(r)
  return new Float32Array([
    (1 - 2*y*y - 2*z*z)*s[0], (2*x*y + 2*z*w)*s[0], (2*x*z - 2*y*w)*s[0], 0,
    (2*x*y - 2*z*w)*s[1], (1 - 2*x*x - 2*z*z)*s[1], (2*y*z + 2*x*w)*s[1], 0,
    (2*x*z + 2*y*w)*s[2], (2*y*z - 2*x*w)*s[2], (1 - 2*x*x - 2*y*y)*s[2], 0,
    t[0], t[1], t[2], 1,
  ])
}
function restModels(bones: RestBone[], parents: readonly number[]): Float32Array {
  const out = new Float32Array(bones.length * 16)
  bones.forEach((bone, i) => {
    const { t, r, s } = bone.rest, local = localMatrix(t, r, s), parent = parents[i]
    out.set(parent < 0 ? local : multiply(out.subarray(parent * 16, parent * 16 + 16), local), i * 16)
  })
  return out
}

// Invert the affine 3x3 basis and translation, including non-unit rest scales.
function affineInverse(m: ArrayLike<number>): Float32Array {
  const cross = (a: number[], b: number[]) =>
    [a[1]*b[2] - a[2]*b[1], a[2]*b[0] - a[0]*b[2], a[0]*b[1] - a[1]*b[0]]
  const cols = [0, 4, 8].map(o => [m[o], m[o + 1], m[o + 2]])
  const rows = [cross(cols[1], cols[2]), cross(cols[2], cols[0]), cross(cols[0], cols[1])]
  const det = cols[0].reduce((sum, v, i) => sum + v * rows[0][i], 0)
  const out = new Float32Array(16)
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) out[c * 4 + r] = rows[r][c] / det
    out[12 + r] = -(out[r]*m[12] + out[4 + r]*m[13] + out[8 + r]*m[14])
  }
  out[15] = 1
  return out
}

/** View-only owner. Call observeTick for each observed sim snapshot, in order.
 * Rendering reads pose(); it never steps. Missing ticks are deliberately not replayed.
 * Start a new driver for a new simulation timeline. Returned arrays are read-only to callers.
 */
export class AnimDriver {
  private readonly entries = new Map<number, Entry>()
  private nextCohort = 1
  private cache = true
  private stats = { evaluated: 0, shared: 0, ikEvaluated: 0, ikShared: 0 }
  /** Last observed tick, for presentation profiling; never read by the simulation. */
  get cacheStats() { return this.stats }
  private tick = -1
  private disposed = false
  private readonly rig: Rig
  private readonly clips: Clip[]
  private readonly graph: AnimationGraph
  private readonly rest: Float32Array
  private readonly parents: number[]
  private readonly boneNames: string[]
  private readonly inverseRest: Float32Array
  private readonly ik: VisualIk | null

  private constructor(rig: Rig, clips: Clip[], graph: AnimationGraph, rest: Float32Array, inverseRest: Float32Array, parents: number[], boneNames: string[], ik: VisualIk | null) {
    this.rig = rig; this.clips = clips; this.graph = graph; this.rest = rest; this.ik = ik
    this.inverseRest = inverseRest; this.parents = parents; this.boneNames = boneNames
  }

  /** rigJson is S16 (without the SDF Modeler bindings/smooth extension). */
  static async load(graphJson: string, rigJson: string, clipJson: readonly string[], opts: { ik?: boolean; cache?: boolean; fastIk?: boolean } = {}): Promise<AnimDriver> {
    const api = await loadAnimBrick(), rig = api.loadRig(rigJson), clips: Clip[] = []
    let graph: AnimationGraph | undefined
    let ik: VisualIk | null = null
    try {
      for (const json of clipJson) clips.push(api.loadClip(rig, json))
      const bones = JSON.parse(rigJson).bones as RestBone[]
      const boneNames = bones.map(b => b.name)
      const parents = bones.map(b => b.parent === null ? -1 : boneNames.indexOf(b.parent))
      const rest = restModels(bones, parents), inverseRest = new Float32Array(rest.length)
      for (let i = 0; i < rest.length; i += 16) inverseRest.set(affineInverse(rest.subarray(i, i + 16)), i)
      // One immutable compiled graph per rig; execution states remain independent.
      graph = api.loadGraph(graphJson, rig, clips)
      ik = opts.ik === false ? null : VisualIk.create(api, rigJson, opts.fastIk !== false)
      const driver = new AnimDriver(rig, clips, graph, rest, inverseRest, parents, boneNames, ik)
      driver.cache = opts.cache !== false
      return driver
    } catch (error) {
      graph?.free(); ik?.dispose()
      for (const clip of clips) clip.free()
      rig.free()
      throw error
    }
  }

  observeTick(tick: number, characters: readonly CharacterObservation[]): void {
    if (this.disposed) throw new Error('animation driver disposed')
    if (!Number.isSafeInteger(tick) || tick < 0) throw new RangeError('invalid simulation tick')
    if (tick <= this.tick) return // duplicate renders and stale observations cannot rewind the view
    const present = new Set(characters.map(c => c.id))
    if (present.size !== characters.length) throw new Error('duplicate character id')
    for (const id of this.entries.keys()) if (!present.has(id)) this.remove(id)
    // Tick-local ownership bounds memory by the visible character count. Histories only
    // merge when equivalent; departure/rejoin starts at cohort zero with a fresh graph/layers.
    const shared = new Map<string, SharedPose>()
    this.stats = { evaluated: 0, shared: 0, ikEvaluated: 0, ikShared: 0 }
    for (const character of characters) {
      let entry = this.entries.get(character.id)
      if (!entry) {
        const layers = POSE_LAYERS.map(layer => layer.create(this.boneNames))
        const walk = layers[POSE_LAYERS.indexOf(WALK_LAYER)] as WalkLayerInstance
        const state = this.graph.newState()
        entry = { cohort: 0, layers, walk, execution: { state, refs: 1, tick: -1 }, memory: newParamMemory() }
        this.entries.set(character.id, entry)
      }
      const params = mapParams(character, entry.memory)
      for (const layer of entry.layers) layer.observe(character)
      // Both speed calculations matter: graph params use sqrt; walk layers use hypot.
      // The prior cohort encodes the complete graph/layer history, including transitions.
      const key = JSON.stringify([entry.cohort, params, character.mode, Math.hypot(character.vel.x, character.vel.z),
        character.vel.x, character.vel.z, character.carry ?? 0, character.strokeTimer ?? 0, character.surface, character.slideSpeed ?? 0, character.carryId ?? -1])
      let cached = this.cache ? shared.get(key) : undefined
      let base: CharacterPose
      if (cached) {
        // Share the execution state too. A later divergent observation splits it lazily.
        if (entry.execution !== cached.execution) {
          this.release(entry.execution)
          entry.execution = cached.execution
          entry.execution.refs++
        }
        base = cached.base
        this.stats.shared++
      } else {
        this.stats.evaluated++
        let execution = entry.execution
        if (execution.tick === tick) {
          // Another member already advanced this cohort with different inputs this tick.
          // Restore the pre-step snapshot only on a split, never once per cache hit.
          const state = this.graph.newState()
          try { state.restore(execution.before!) } catch (error) { state.free(); throw error }
          this.release(execution)
          entry.execution = execution = { state, refs: 1, tick: -1 }
        }
        execution.before = execution.refs > 1 ? execution.state.save() : undefined
        const step = this.graph.step(execution.state, { ...params })
        execution.tick = tick
        const model = new Float32Array(this.rest.length)
        for (let i = 0; i < model.length; i += 16) {
          multiplyInto(model, i, step.skin, i, this.rest, i)
        }
        const local = localPose(model, this.parents)
        for (const layer of entry.layers) {
          layer.apply(local, character)
        }
        const skin = new Float32Array(model.length)
        const matrix = new Float32Array(16)
        for (let bone = 0; bone < this.parents.length; bone++) {
          const o = bone * 10, m = bone * 16, parent = this.parents[bone]
          localMatrixInto(matrix, 0, local, o)
          if (parent < 0) model.set(matrix, m)
          else multiplyInto(model, m, model, parent * 16, matrix, 0)
          multiplyInto(skin, m, model, m, this.inverseRest, m)
        }
        base = { ...step, local, model, skin }
        cached = { cohort: this.nextCohort++, execution: entry.execution, base, ik: new Map() }
        if (this.cache) shared.set(key, cached)
      }
      entry.cohort = cached.cohort
      // IK starts from this tick's layered pose; its output only feeds rendering.
      const { xf, ik: targets } = character
      if (this.ik !== null && xf !== undefined && targets !== undefined) {
        const key = ikKey(xf, targets)
        const hit = this.cache ? cached.ik.get(key) : undefined
        if (hit) { entry.pose = hit; this.stats.ikShared++ }
        else {
          const out = this.ik.evaluate(base, xf, targets)
          entry.pose = { ...base, local: out["local"], model: out.model, skin: out.skin, ik: out.active }
          this.stats.ikEvaluated++
          if (this.cache) cached.ik.set(key, entry.pose)
        }
      } else entry.pose = base
    }
    this.tick = tick
  }

  /** Latest pose and tick-local visual events/root delta; reading does not re-emit or apply them. */
  pose(id: number): CharacterPose | undefined { return this.entries.get(id)?.pose }
  footDown(id: number): -1 | 0 | 1 { return this.entries.get(id)?.walk.footDown ?? 0 }
  get observedTick(): number { return this.tick }

  remove(id: number): void {
    const entry = this.entries.get(id)
    if (!entry) return
    this.release(entry.execution); this.entries.delete(id)
  }

  private release(execution: Execution): void {
    if (--execution.refs === 0) { execution.state.free() }
  }

  dispose(): void {
    if (this.disposed) return
    for (const id of this.entries.keys()) this.remove(id)
    this.graph.free()
    for (const clip of this.clips) clip.free()
    this.ik?.dispose(); this.rig.free(); this.disposed = true
  }
}
