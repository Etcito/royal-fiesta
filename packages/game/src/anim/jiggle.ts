// Jiggle bones of worn cosmetics (owner 2026-11-04: a jester hat's horns swing as the penguin turns and runs).
// View side only, like the rest of the animation: it reads the penguin pose the renderer already has and writes skin
// palettes to the render port. It never touches the simulation, its snapshots or rollback, and nothing in
// packages/sim imports it.
//
// A referenced cosmetic takes the full live penguin pose, with extra bones following their own penguin ancestors.
// JiggleWorld.setPoseSkin reconstructs that animated pose in WASM every frame, before adding secondary motion.
// A legacy cosmetic can instead carry a small armature mounted on a penguin bone (rig.parentBone / skin.mount).
// A mounted armature at rest follows its bone rigidly: every one of its bones gets the penguin skin matrix of the
// mount bone (wornPalette). Its jiggle bones are stepped by raa-anim's JiggleWorld (Rust/WASM): one world per view,
// one handle per worn instance, one step call per rendered frame after the main pose.
//
// Low priority (owner): the graphics option `jiggle` ('off' | 'local' | 'all', MAMA's render-options contract, set
// through setJiggleQuality) picks who jiggles; 'all' only steps characters within JIGGLE_DISTANCE of the camera, at
// most JIGGLE_MAX_INSTANCES nearest; a frame later than JIGGLE_LATE_FRAME_S skips the step. A skipped or culled
// instance follows its bone rigidly and restarts from its animated pose when it is stepped again.
import { loadAnimBrick, type AnimBrick } from './brick.ts'
import type { QuatT, SkinnedAssetT, Vec3T } from '../render/port.ts'

export type JiggleQuality = 'off' | 'local' | 'all'
export const JIGGLE_DISTANCE = 25
export const JIGGLE_MAX_INSTANCES = 32
export const JIGGLE_LATE_FRAME_S = 1 / 30

let quality: JiggleQuality = 'all'

/** The page-wide jiggle quality (the Graphics page's `jiggle`); anything unknown means the default, 'all'. */
export function setJiggleQuality(value: unknown): void {
  quality = value === 'off' || value === 'local' ? value : 'all'
}
export function jiggleQuality(): JiggleQuality {
  return quality
}

/** The bones of a worn cosmetic's own armature and the penguin bone it is mounted on, or null for a penguin-rig copy. */
export function mountOf(skin: SkinnedAssetT | undefined): { mount: number; bones: number } | null {
  return skin?.mount === undefined ? null : { mount: skin.mount, bones: skin.rig.bones.length }
}

/** Whether a worn cosmetic has secondary bones (a referenced rig or a mounted armature) that jiggle. */
export function hasJiggle(skin: SkinnedAssetT | undefined): boolean {
  return skin !== undefined && (skin.mount !== undefined || skin.sourceBones !== undefined)
    && (skin.rig.bones as readonly { jiggle?: unknown }[]).some(b => b.jiggle !== undefined)
}

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])

/**
 * The skin palette of a worn skinned cosmetic for this penguin pose, without jiggle: the pose itself for a copy of the
 * penguin rig, else the mount bone's skin matrix for every bone of the cosmetic's own armature.
 */
export function wornPalette(skin: SkinnedAssetT | undefined, penguinSkin: Float32Array): Float32Array {
  if (skin?.sourceBones) {
    const out = new Float32Array(skin.sourceBones.length * 16)
    skin.sourceBones.forEach((source, i) => out.set(penguinSkin.subarray(source * 16, source * 16 + 16), i * 16))
    return out
  }
  const m = mountOf(skin)
  if (m === null) return penguinSkin
  const out = new Float32Array(m.bones * 16)
  const at = m.mount * 16
  const mount = at + 16 <= penguinSkin.length ? penguinSkin.subarray(at, at + 16) : IDENTITY
  for (let b = 0; b < m.bones; b++) out.set(mount, b * 16)
  return out
}

/** Column-major T * R * S of an instance placement. */
function placement(t: Vec3T, r: QuatT, s: Vec3T, out: Float32Array, at: number): void {
  const [x, y, z, w] = r
  out[at] = (1 - 2 * (y * y + z * z)) * s[0]; out[at + 1] = 2 * (x * y + z * w) * s[0]; out[at + 2] = 2 * (x * z - y * w) * s[0]; out[at + 3] = 0
  out[at + 4] = 2 * (x * y - z * w) * s[1]; out[at + 5] = (1 - 2 * (x * x + z * z)) * s[1]; out[at + 6] = 2 * (y * z + x * w) * s[1]; out[at + 7] = 0
  out[at + 8] = 2 * (x * z + y * w) * s[2]; out[at + 9] = 2 * (y * z - x * w) * s[2]; out[at + 10] = (1 - 2 * (x * x + y * y)) * s[2]; out[at + 11] = 0
  out[at + 12] = t[0]; out[at + 13] = t[1]; out[at + 14] = t[2]; out[at + 15] = 1
}

type World = ReturnType<AnimBrick['createJiggleWorld']>
type Rig = ReturnType<AnimBrick['loadRig']>
interface Pending {
  instance: number; skin: SkinnedAssetT; penguin: Float32Array
  t: Vec3T; r: QuatT; s: Vec3T; mine: boolean; distance2: number
}

/** One view's worn-cosmetic jiggle: add() every mounted cosmetic during a frame, then flush() once. */
export class CosmeticJiggle {
  private api: AnimBrick | null = null
  private world: World | null = null
  private loading: Promise<void> | null = null
  private unavailable = false
  private readonly rigs = new Map<SkinnedAssetT, Rig | null>()
  private readonly handles = new Map<number, { handle: number; skin: SkinnedAssetT }>()
  private pending: Pending[] = []
  // Bumped by dispose(): a brick load that resolves afterwards is dropped (the view may be used again).
  private generation = 0
  /** Instances stepped by the last flush (for checks); never read by the game. */
  stepped = 0

  /**
   * Queue the worn cosmetic `instance` for this frame: posed from `penguin` (the wearer's skin matrices) at the
   * placement t/r/s. `mine`: it is worn by the local player; `distance2`: squared distance to the camera.
   */
  add(instance: number, skin: SkinnedAssetT, penguin: Float32Array, t: Vec3T, r: QuatT, s: Vec3T, mine: boolean, distance2: number): void {
    this.pending.push({ instance, skin, penguin, t, r, s, mine, distance2 })
  }

  /** Step the queued instances that may jiggle (one JiggleWorld call) and give every queued one its palette. */
  flush(dtS: number, setPose: (instance: number, palette: Float32Array) => void): void {
    const queued = this.pending
    this.pending = []
    this.stepped = 0
    const active = this.pick(queued, dtS)
    // A frame with no active chains never calls world.step(), so its serial alone cannot detect the gap.
    // Discard stale spring state even when quality/distance/a late frame skips the entire batch.
    const instances = new Set(active.map(p => p.instance))
    for (const [instance, known] of this.handles) if (!instances.has(instance)) this.world?.reset(known.handle)
    const world = active.length > 0 ? this.ready() : null
    const done = new Set<Pending>()
    if (world !== null) {
      const handles: number[] = [], frames = new Float32Array(active.length * 32), stepping: Pending[] = []
      for (const p of active) {
        const handle = this.handleOf(world, p)
        if (handle === null) continue
        placement(p.t, p.r, p.s, frames, stepping.length * 32)
        let mount: Float32Array = IDENTITY
        if (p.skin.sourceBones) {
          // Re-pose on EVERY rendered frame, even between sim ticks. WASM reconstructs animated locals from
          // exactly the palette the body draws; only the spring offset has its own integration clock.
          world.setPoseSkin(handle, wornPalette(p.skin, p.penguin))
        } else {
          const at = p.skin.mount! * 16
          if (at + 16 <= p.penguin.length) mount = p.penguin.subarray(at, at + 16)
        }
        frames.set(mount, stepping.length * 32 + 16)
        handles.push(handle)
        stepping.push(p)
      }
      if (stepping.length > 0) {
        try {
          const palettes = world.step(dtS, Uint32Array.from(handles), frames.subarray(0, stepping.length * 32))
          let at = 0
          for (const p of stepping) {
            const size = p.skin.rig.bones.length * 16
            const sampled = palettes.slice(at, at + size)
            if (p.skin.sourceBones) {
              const result = wornPalette(p.skin, p.penguin)
              // Keep inherited matrices byte-identical to the body. All extra bones use the live animated pose
              // plus secondary motion, including extras attached to different penguin bones.
              for (let b = p.skin.inheritedBones!; b < p.skin.rig.bones.length; b++) {
                result.set(sampled.subarray(b * 16, b * 16 + 16), b * 16)
              }
              setPose(p.instance, result)
            } else setPose(p.instance, sampled)
            at += size
            done.add(p)
          }
          this.stepped = stepping.length
        } catch (error) {
          // Visual only: a refused step never breaks the frame; jiggle stays off for this view.
          console.warn('[jiggle] step refused; cosmetics follow their bones rigidly', error)
          this.unavailable = true
        }
      }
    }
    for (const p of queued) if (!done.has(p)) setPose(p.instance, wornPalette(p.skin, p.penguin))
  }

  /** Forget a destroyed worn instance. */
  release(instance: number): void {
    const known = this.handles.get(instance)
    if (known === undefined) return
    this.world?.remove(known.handle)
    this.handles.delete(instance)
  }

  /** Free the world and the loaded rigs; a later frame loads them again. */
  dispose(): void {
    this.generation++
    this.world?.free()
    this.world = null
    this.loading = null
    for (const rig of this.rigs.values()) rig?.free()
    this.rigs.clear()
    this.handles.clear()
    this.pending = []
  }

  // Who jiggles this frame: the quality option, then distance and count for 'all'; nobody on a late frame.
  private pick(queued: readonly Pending[], dtS: number): Pending[] {
    if (quality === 'off' || this.unavailable || dtS > JIGGLE_LATE_FRAME_S) return []
    const jiggling = queued.filter(p => hasJiggle(p.skin) && (quality === 'local' ? p.mine : p.mine || p.distance2 <= JIGGLE_DISTANCE * JIGGLE_DISTANCE))
    if (jiggling.length <= JIGGLE_MAX_INSTANCES) return jiggling
    return [...jiggling].sort((a, b) => (a.mine === b.mine ? a.distance2 - b.distance2 : a.mine ? -1 : 1)).slice(0, JIGGLE_MAX_INSTANCES)
  }

  // The world once the animation brick has loaded (null until then, and for good on a brick without jiggle).
  private ready(): World | null {
    if (this.world !== null || this.unavailable) return this.world
    const generation = this.generation
    this.loading ??= loadAnimBrick().then(api => {
      if (generation !== this.generation) return
      if (typeof (api as Partial<AnimBrick>).createJiggleWorld !== 'function') {
        console.warn('[jiggle] this raa-anim brick has no createJiggleWorld; cosmetics follow their bones rigidly')
        this.unavailable = true
        return
      }
      this.api = api
      this.world = api.createJiggleWorld()
    }, error => {
      console.warn('[jiggle] the animation brick did not load; cosmetics follow their bones rigidly', error)
      this.unavailable = true
    })
    return null
  }

  private handleOf(world: World, p: Pending): number | null {
    const known = this.handles.get(p.instance)
    if (known !== undefined && known.skin === p.skin) return known.handle
    if (known !== undefined) this.release(p.instance)
    let rig = this.rigs.get(p.skin)
    if (rig === undefined) {
      try {
        const { bindings: _b, smooth: _s, ...s16 } = p.skin.rig as unknown as Record<string, unknown>
        rig = this.api!.loadRig(JSON.stringify(s16))
      } catch (error) {
        console.warn('[jiggle] a cosmetic armature was refused; it follows its bone rigidly', error)
        rig = null
      }
      this.rigs.set(p.skin, rig)
    }
    if (rig === null) return null
    const handle = world.add(rig)
    this.handles.set(p.instance, { handle, skin: p.skin })
    return handle
  }
}
