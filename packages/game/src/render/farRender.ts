// Display-only far players, using the authored penguin in the cheaper shading tier.
import type { PrimsAsset } from '@royal-fiesta/game/prims'
import { loadAnimBrick } from '../anim/brick.ts'
import type { FarFeed } from '../net/farFeed.ts'
import { PALETTE, seatTint } from './palette.ts'
import type { QuatT, RenderPort, Vec3T } from './port.ts'
import { restPoseSkin, type SkinnedCharacter } from './sceneView.ts'

// A far seat borrows its palette colour, pulled towards its own luminance and then towards white, so the
// bean still reads as the same player without competing with the full skinned figures near the camera.
const DESATURATE = 0.2
const LIGHTEN = 0.25
// The bean capsule is modelled at unit scale, as the scene view draws it.
const UNIT: Vec3T = [1, 1, 1]

/** The lighter, desaturated tint of one far seat. Seats beyond the palette wrap through it. */
export function farTint(seat: number): Vec3T {
  const n = PALETTE.length
  const i = ((Math.trunc(seat) % n) + n) % n
  const base = PALETTE[i]
  const lum = 0.2126 * base[0] + 0.7152 * base[1] + 0.0722 * base[2]
  const r = base[0] + (lum - base[0]) * DESATURATE
  const g = base[1] + (lum - base[1]) * DESATURATE
  const b = base[2] + (lum - base[2]) * DESATURATE
  return [r + (1 - r) * LIGHTEN, g + (1 - g) * LIGHTEN, b + (1 - b) * LIGHTEN]
}

export function farFigureMode(search = typeof location === 'undefined' ? '' : location.search): 'penguin' | 'oldbean' {
  return new URLSearchParams(search).get('far') === 'oldbean' ? 'oldbean' : 'penguin'
}

export interface FarPenguinAsset { asset: PrimsAsset; skinned?: SkinnedCharacter }

/** Share idle and waddle clip samples across far seats at 15 Hz. The pose feed supplies
 * displacement for the choice of clip, while the root transform still follows every frame. */
export class FarPenguins {
  private readonly port: RenderPort
  private readonly asset: number
  private readonly rest: Float32Array | null
  private readonly last = new Map<number, { tick: number; position: Vec3T }>()
  private clips: Awaited<ReturnType<typeof loadFarClips>> | null = null
  private poses: readonly Float32Array[] = []
  private sampledTick = -1
  private disposed = false
  readonly ready: Promise<void>

  constructor(port: RenderPort, figure: FarPenguinAsset) {
    this.port = port
    const skinned = port.registerSkinned && port.setPose ? figure.skinned : undefined
    this.asset = skinned === undefined ? port.registerAsset(figure.asset.id, figure.asset) : port.registerSkinned!(skinned.assetId, skinned.skin)
    this.rest = skinned === undefined ? null : restPoseSkin(skinned.skin.rig as unknown as Parameters<typeof restPoseSkin>[0])
    this.ready = skinned === undefined ? Promise.resolve() : loadFarClips(skinned).then(clips => {
      if (this.disposed) clips.dispose()
      else this.clips = clips
    }).catch(error => console.error('[far penguins] idle and waddle clips unavailable', error))
  }

  create(tint: Vec3T | null): number {
    const instance = this.port.createInstance(this.asset, tint, 'vertex')
    if (this.rest !== null) this.port.setPose!(instance, this.rest)
    return instance
  }

  move(instance: number, position: Vec3T, tick: number): void {
    if (this.clips === null) return
    const sampleTick = 4 * Math.floor(tick / 4)
    const before = this.last.get(instance)
    if (before?.tick === sampleTick) return
    if (sampleTick !== this.sampledTick) {
      this.poses = this.clips.sample(sampleTick)
      this.sampledTick = sampleTick
    }
    const elapsed = before === undefined ? 0 : (sampleTick - before.tick) / 60
    const distance = before === undefined ? 0 : Math.hypot(position[0] - before.position[0], position[2] - before.position[2])
    const walking = elapsed > 0 && distance > 0.35 * elapsed && distance < 18 * elapsed
    this.port.setPose!(instance, this.poses[walking ? 1 : 0])
    this.last.set(instance, { tick: sampleTick, position })
  }

  forget(instance: number): void { this.last.delete(instance) }

  dispose(): void {
    this.disposed = true
    this.clips?.dispose()
    this.clips = null
    this.last.clear()
  }
}

async function loadFarClips(character: SkinnedCharacter) {
  const api = await loadAnimBrick()
  const { bindings: _b, smooth: _s, ...rigSource } = character.skin.rig as typeof character.skin.rig & { bindings?: unknown; smooth?: unknown }
  const rig = api.loadRig(JSON.stringify(rigSource))
  const clips: { clip: ReturnType<typeof api.loadClip>; ticks: number }[] = []
  const dispose = () => { for (const { clip } of clips) clip.free(); rig.free() }
  try {
    const sources = character.skin.clips as readonly { name: string; lengthTicks: number }[] | undefined
    for (const name of ['idle', 'waddle']) {
      const source = sources?.find(clip => clip.name === name)
      if (source === undefined || !(source.lengthTicks > 0)) throw new Error(`missing ${name} clip for ${character.assetId}`)
      clips.push({ clip: api.loadClip(rig, JSON.stringify(source)), ticks: source.lengthTicks })
    }
    return { sample: (tick: number) => clips.map(({ clip, ticks }) => api.sampleClip(clip, tick % ticks).skin), dispose }
  } catch (error) {
    dispose()
    throw error
  }
}

export interface FarRendererOptions {
  port: RenderPort
  // The zone content supplies a separate low-poly, unskinned character asset.
  bean: PrimsAsset
  penguin?: FarPenguinAsset
  feed: FarFeed
  // Seats this peer simulates in a NEAR domain are drawn by the near scene, never here.
  holdsLocalSeat: (seat: number) => boolean
}

interface FarInstance {
  seat: number
  instance: number
  visible: boolean
  // The update() that last included this seat; older entries are hidden.
  frame: number
}

export class FarRenderer {
  private readonly port: RenderPort
  private readonly feed: FarFeed
  private readonly holdsLocalSeat: (seat: number) => boolean
  private readonly beanAsset: number | null
  private readonly penguins: FarPenguins | null
  // Indexed by seat; an entry survives while the seat is absent so its instance is reused on return.
  private readonly bySeat: (FarInstance | undefined)[] = []
  private readonly created: FarInstance[] = []
  private frame = 0

  constructor(opts: FarRendererOptions) {
    this.port = opts.port
    this.feed = opts.feed
    this.holdsLocalSeat = opts.holdsLocalSeat
    this.penguins = opts.penguin === undefined ? null : new FarPenguins(opts.port, opts.penguin)
    this.beanAsset = this.penguins === null ? opts.port.registerAsset('zone-far-bean', opts.bean) : null
  }

  get instanceCount(): number {
    return this.created.length
  }

  /** Draws the feed's interpolated poses at displayTick; every other seat is hidden. */
  update(displayTick: number): void {
    const frame = ++this.frame
    const shown = this.feed.read(displayTick, this.holdsLocalSeat)
    for (let i = 0; i < shown.length; i++) {
      const entity = shown[i]
      if (this.holdsLocalSeat(entity.seat) || !Number.isFinite(entity.x) || !Number.isFinite(entity.y) ||
        !Number.isFinite(entity.z) || !Number.isFinite(entity.yaw)) continue
      let entry = this.bySeat[entity.seat]
      if (entry === undefined) {
        const instance = this.penguins === null
          ? this.port.createInstance(this.beanAsset!, farTint(entity.seat)) : this.penguins.create(seatTint(entity.seat))
        entry = { seat: entity.seat, instance, visible: true, frame }
        this.bySeat[entity.seat] = entry
        this.created.push(entry)
      }
      entry.frame = frame
      const half = entity.yaw / 2
      const q: QuatT = [0, Math.sin(half), 0, Math.cos(half)]
      const position: Vec3T = [entity.x, entity.y, entity.z]
      this.port.setTransform(entry.instance, position, q, UNIT)
      this.penguins?.move(entry.instance, position, displayTick)
      this.show(entry, true)
    }
    for (let i = 0; i < this.created.length; i++) {
      const entry = this.created[i]
      if (entry.frame !== frame && entry.visible) {
        this.show(entry, false)
        this.penguins?.forget(entry.instance)
      }
    }
  }

  dispose(): void {
    this.penguins?.dispose()
    for (let i = 0; i < this.created.length; i++) this.port.destroyInstance(this.created[i].instance)
    this.created.length = 0
    this.bySeat.length = 0
    this.frame = 0
  }

  private show(entry: FarInstance, visible: boolean): void {
    if (entry.visible === visible) return
    this.port.setVisible(entry.instance, visible)
    entry.visible = visible
  }
}

// Low-poly rigid penguin silhouette, matching penguin.body's body-space dimensions.
// One mesh, no skeleton, animation, costume or fine facial geometry.
export function farFigureMesh() {
  const positions: number[] = []
  const normals: number[] = []
  const indices: number[] = []
  const rings = 6
  const segments = 10
  function oval(cx: number, cy: number, cz: number, rx: number, ry: number, rz: number) {
    const start = positions.length / 3
    for (let row = 0; row <= rings; row++) {
      const latitude = Math.PI * row / rings
      for (let col = 0; col <= segments; col++) {
        const longitude = 2 * Math.PI * col / segments
        const x = Math.sin(latitude) * Math.cos(longitude)
        const y = Math.cos(latitude)
        const z = Math.sin(latitude) * Math.sin(longitude)
        positions.push(cx + rx * x, cy + ry * y, cz + rz * z)
        const length = Math.hypot(x / rx, y / ry, z / rz)
        normals.push(x / rx / length, y / ry / length, z / rz / length)
      }
    }
    for (let row = 0; row < rings; row++) for (let col = 0; col < segments; col++) {
      const a = start + row * (segments + 1) + col
      const b = a + segments + 1
      indices.push(a, a + 1, b, a + 1, b + 1, b)
    }
  }
  oval(0, -0.03, 0, 0.46, 0.79, 0.4)
  oval(0, 0.74, 0.02, 0.38, 0.38, 0.38)
  oval(-0.48, -0.12, 0, 0.16, 0.51, 0.19)
  oval(0.48, -0.12, 0, 0.16, 0.51, 0.19)
  oval(-0.23, -0.8, 0.13, 0.23, 0.13, 0.32)
  oval(0.23, -0.8, 0.13, 0.23, 0.13, 0.32)
  oval(0, 0.69, 0.4, 0.14, 0.09, 0.2)
  return {
    materials: [],
    groups: [{ group: 'far', parts: [{
      name: 'bean', partId: 'bean',
      frame: new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
      meshes: [{ material: null, positions: new Float32Array(positions), normals: new Float32Array(normals),
        uvs: null, indices: new Uint32Array(indices) }],
    }] }],
  }
}
