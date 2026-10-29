import type { AnimationGraph, AnimationGraphState, GraphStep } from '@etcito/raa-anim'
import { loadAnimBrick } from './brick.ts'
import { VisualIk, type CharacterTransform, type IkActive, type IkTargets } from './ik.ts'
import { mapParams, newParamMemory, type CharObservation, type ParamMemory } from './params.ts'

type Brick = Awaited<ReturnType<typeof loadAnimBrick>>
type Rig = ReturnType<Brick['loadRig']>
type Clip = ReturnType<Brick['loadClip']>
export type CharacterPose = GraphStep & Pick<ReturnType<Brick['sampleClip']>, 'model'> & { readonly ik?: IkActive }
/** `xf` and `ik` are the sim placement and targets for visual IK; the corrected pose never reaches the sim. */
export interface CharacterObservation extends CharObservation {
  readonly id: number; readonly xf?: CharacterTransform; readonly ik?: IkTargets
}
interface Entry {
  graph: AnimationGraph; state: AnimationGraphState; memory: ParamMemory; pose?: CharacterPose
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
function restModels(bones: RestBone[]): Float32Array {
  const out = new Float32Array(bones.length * 16)
  bones.forEach((bone, i) => {
    const { t, r: [x, y, z, w], s } = bone.rest
    const local = new Float32Array([
      (1 - 2*y*y - 2*z*z)*s[0], (2*x*y + 2*z*w)*s[0], (2*x*z - 2*y*w)*s[0], 0,
      (2*x*y - 2*z*w)*s[1], (1 - 2*x*x - 2*z*z)*s[1], (2*y*z + 2*x*w)*s[1], 0,
      (2*x*z + 2*y*w)*s[2], (2*y*z - 2*x*w)*s[2], (1 - 2*x*x - 2*y*y)*s[2], 0,
      t[0], t[1], t[2], 1,
    ])
    const parent = bones.findIndex(b => b.name === bone.parent)
    out.set(parent < 0 ? local : multiply(out.subarray(parent * 16, parent * 16 + 16), local), i * 16)
  })
  return out
}

/** View-only owner. Call observeTick for each observed sim snapshot, in order.
 * Rendering reads pose(); it never steps. Missing ticks are deliberately not replayed.
 * Start a new driver for a new simulation timeline. Returned arrays are read-only to callers.
 */
export class AnimDriver {
  private readonly entries = new Map<number, Entry>()
  private tick = -1
  private disposed = false
  private readonly api: Brick
  private readonly json: string
  private readonly rig: Rig
  private readonly clips: Clip[]
  private readonly rest: Float32Array
  private readonly ik: VisualIk | null

  private constructor(api: Brick, json: string, rig: Rig, clips: Clip[], rest: Float32Array, ik: VisualIk | null) {
    this.api = api; this.json = json; this.rig = rig; this.clips = clips; this.rest = rest; this.ik = ik
  }

  /** rigJson is S16 (without the SDF Modeler bindings/smooth extension). */
  static async load(graphJson: string, rigJson: string, clipJson: readonly string[], opts: { ik?: boolean } = {}): Promise<AnimDriver> {
    const api = await loadAnimBrick(), rig = api.loadRig(rigJson), clips: Clip[] = []
    try {
      for (const json of clipJson) clips.push(api.loadClip(rig, json))
      const rest = restModels(JSON.parse(rigJson).bones)
      // Validate even before the first character joins.
      api.loadGraph(graphJson, rig, clips).free()
      const ik = opts.ik === false ? null : VisualIk.create(api, rigJson)
      return new AnimDriver(api, graphJson, rig, clips, rest, ik)
    } catch (error) {
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
    for (const character of characters) {
      let entry = this.entries.get(character.id)
      if (!entry) {
        const graph = this.api.loadGraph(this.json, this.rig, this.clips)
        let state: AnimationGraphState
        try { state = graph.newState() } catch (error) { graph.free(); throw error }
        entry = { graph, state, memory: newParamMemory() }
        this.entries.set(character.id, entry)
      }
      const step = entry.graph.step(entry.state, { ...mapParams(character, entry.memory) })
      const model = new Float32Array(this.rest.length)
      for (let i = 0; i < model.length; i += 16) {
        model.set(multiply(step.skin.subarray(i, i + 16), this.rest.subarray(i, i + 16)), i)
      }
      // IK runs after the single graph step, from that fresh pose; its output only feeds rendering.
      const { xf, ik: targets } = character
      if (this.ik !== null && xf !== undefined && targets !== undefined) {
        const out = this.ik.evaluate({ model, skin: step.skin }, xf, targets)
        entry.pose = { ...step, model: out.model, skin: out.skin, ik: out.active }
      } else entry.pose = { ...step, model }
    }
    this.tick = tick
  }

  /** Latest pose and tick-local visual events/root delta; reading does not re-emit or apply them. */
  pose(id: number): CharacterPose | undefined { return this.entries.get(id)?.pose }
  get observedTick(): number { return this.tick }

  remove(id: number): void {
    const entry = this.entries.get(id)
    if (!entry) return
    entry.state.free(); entry.graph.free(); this.entries.delete(id)
  }

  dispose(): void {
    if (this.disposed) return
    for (const id of this.entries.keys()) this.remove(id)
    for (const clip of this.clips) clip.free()
    this.ik?.dispose(); this.rig.free(); this.disposed = true
  }
}
