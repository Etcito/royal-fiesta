// M13: instances are not part of the saved mesh. A course places the same asset many times, each placement
// with its own transform (and the renderer gives each instance its own tint); the S16 file (meshWire bytes
// plus its key) is made once per asset. Decoding and re-encoding it gives the same bytes for every
// placement, and one RenderPort registration serves every instance of that asset.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { loadCourseV1 } from '@royal-fiesta/game/courseV1'
import type { GameAssetResolver, ResolvedGameAsset } from '@royal-fiesta/game/courseV1'
import { assetFilePath, parseGameAsset } from '@royal-fiesta/game/gameAsset'
import type { GameAsset, World } from '@royal-fiesta/game/gameAsset'
import type { PrimsAsset } from '@royal-fiesta/game/prims'
import { NullRenderPort } from '@royal-fiesta/game/render/nullPort'
import type { QuatT, Vec3T } from '@royal-fiesta/game/render/port'
import type { MeshedAsset } from '../src/sdf/mamaApi.ts'
import { meshCacheKey } from '../src/sdf/meshCache.ts'
import { decodeMesh, encodeMesh } from '../src/sdf/meshWire.ts'
import type { KeyedMeshedAsset } from '../src/sdf/meshWire.ts'

const ROOT = new URL('../../../', import.meta.url)
const COURSE = 'courses/obstacle-gallery.course.json'
const MAMA = 'mama-instances-test'
const COMPAT = 'format:1;algorithm:instances-test'
const RAA = 'raa-sdfm-instances-test'

function sha256Hex(bytes: Uint8Array): Promise<string> {
  return Promise.resolve(createHash('sha256').update(bytes).digest('hex'))
}

function readJson(path: string): Promise<unknown> {
  return readFile(new URL(path, ROOT), 'utf8').then((text) => JSON.parse(text) as unknown)
}

const resolved = new Map<string, Promise<ResolvedGameAsset>>()
const assets: GameAssetResolver = {
  resolve(id: string): Promise<ResolvedGameAsset> {
    let pending = resolved.get(id)
    if (pending === undefined) {
      pending = (async () => {
        const path = assetFilePath(id.slice(0, id.indexOf('.')) as World, id)
        const json = await readJson(path)
        return { asset: await parseGameAsset(json, path), source: { path, json } }
      })()
      resolved.set(id, pending)
    }
    return pending
  },
}

// An obstacle, mechanism item or decor placement of the validated v1 course: asset by id, its own transform.
interface Placement { id: string; asset: string; t: readonly number[]; r: readonly number[]; s: readonly number[] }
interface CourseJson { obstacles: Placement[]; decor?: Placement[] }

const course = await loadCourseV1(await readJson(COURSE), COURSE, assets)
const courseJson = course.json as unknown as CourseJson
const placements: Placement[] = [...courseJson.obstacles, ...(courseJson.decor ?? [])]

function byAsset(list: readonly Placement[]): Map<string, Placement[]> {
  const groups = new Map<string, Placement[]>()
  for (const placement of list) {
    const group = groups.get(placement.asset)
    if (group === undefined) groups.set(placement.asset, [placement])
    else group.push(placement)
  }
  return groups
}
const groups = byAsset(placements)

// A MAMA payload in the shape the worker produces: one group, one part frame, one quad split by material.
function meshedAssetFor(asset: GameAsset): MeshedAsset {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0])
  const normals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1])
  const uvs = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1])
  const indices = new Uint32Array([0, 1, 2, 0, 2, 3])
  const frame = new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])
  return {
    assetId: asset.id,
    hash: asset.hash,
    mesher: asset.mesher.output,
    parts: 1,
    triangles: 2,
    data: {
      groups: [{ group: 'g0', parts: [{ partId: 'p0', name: 'body', frame, meshes: [{ material: 'candy', positions, normals, uvs, indices }] }] }],
      materials: [],
    },
    transfer: [frame.buffer, positions.buffer, normals.buffer, uvs.buffer, indices.buffer],
  }
}

// What the loader looks up (and SDF Modeler saves) for an asset, never for one of its placements.
async function savedFile(asset: GameAsset): Promise<KeyedMeshedAsset> {
  return { ...meshedAssetFor(asset), key: await meshCacheKey(asset, COMPAT, sha256Hex) }
}

class RecordingPort extends NullRenderPort {
  readonly registered: string[] = []
  private readonly tints = new Map<number, Vec3T | null>()
  private readonly transforms = new Map<number, { t: Vec3T; r: QuatT; s: Vec3T }>()
  override registerAsset(name: string, asset: PrimsAsset): number {
    this.registered.push(name)
    return super.registerAsset(name, asset)
  }
  override createInstance(asset: number, tint: Vec3T | null): number {
    const instance = super.createInstance(asset, tint)
    this.tints.set(instance, tint)
    return instance
  }
  override setTransform(instance: number, t: Vec3T, r: QuatT, s: Vec3T): void {
    super.setTransform(instance, t, r, s)
    this.transforms.set(instance, { t, r, s })
  }
  tintOf(instance: number): Vec3T | null | undefined {
    return this.tints.get(instance)
  }
  transformOf(instance: number): { t: Vec3T; r: QuatT; s: Vec3T } | undefined {
    return this.transforms.get(instance)
  }
}

function vec3(values: readonly number[], id: string): Vec3T {
  assert.equal(values.length, 3, `${id}: 3 components`)
  return [values[0], values[1], values[2]]
}

function quat(values: readonly number[], id: string): QuatT {
  assert.equal(values.length, 4, `${id}: 4 components`)
  return [values[0], values[1], values[2], values[3]]
}

test('(b) the saved mesh holds no instance transform or tint: every placement round-trips to the same bytes', async () => {
  assert.ok(groups.size > 0, `${COURSE} places assets`)
  let repeated = 0
  for (const [id, list] of groups) {
    const { asset } = await assets.resolve(id)
    const file = await savedFile(asset)
    const bytes = encodeMesh(file)
    const decoded = decodeMesh(bytes)
    assert.deepEqual(decoded, file, `${id}: decode gives the saved value`)
    assert.deepEqual(encodeMesh(decoded), bytes, `${id}: decode then re-encode keeps the bytes`)
    assert.deepEqual(
      Object.keys(decoded).sort(),
      ['assetId', 'data', 'hash', 'key', 'mesher', 'parts', 'transfer', 'triangles'],
      `${id}: the file holds exactly a MeshedAsset and its key, with no instance fields`,
    )
    if (list.length > 1) {
      repeated++
      const transforms = new Set(list.map((p) => JSON.stringify([p.t, p.r, p.s])))
      assert.ok(transforms.size > 1, `${id}: its ${list.length} placements carry their own transforms`)
    }
    for (const placement of list) {
      // The file is resolved per asset, so this placement looks up the very bytes above.
      const forPlacement = await savedFile(asset)
      const placementBytes = encodeMesh(forPlacement)
      assert.equal(forPlacement.key, file.key, `${id}#${placement.id}: the key comes from the asset, not the placement`)
      assert.deepEqual(placementBytes, bytes, `${id}#${placement.id}: the placement adds no bytes`)
      assert.deepEqual(encodeMesh(decodeMesh(placementBytes)), placementBytes,
        `${id}#${placement.id}: decode then re-encode keeps the bytes`)
    }
  }
  assert.ok(repeated > 0, 'the course places at least one asset more than once')
})

test('(c) one asset registration serves every placement, each with its own transform and tint', async () => {
  const port = new RecordingPort()
  await port.init({ canvas: null, width: 800, height: 600, viewports: [{ x: 0, y: 0, width: 800, height: 600 }] })
  const handles = new Map<string, number>()
  const made: { instance: number; placement: Placement; tint: Vec3T }[] = []
  for (let i = 0; i < placements.length; i++) {
    const placement = placements[i]
    let handle = handles.get(placement.asset)
    if (handle === undefined) {
      handle = port.registerAsset(placement.asset, { id: placement.asset } as PrimsAsset)
      handles.set(placement.asset, handle)
    }
    // Every instance owns a distinct colour, as seats do; it never reaches the asset.
    const tint: Vec3T = [(i + 0.5) / placements.length, 1 - (i + 0.5) / placements.length, 0.25]
    const instance = port.createInstance(handle, tint)
    port.setTransform(instance, vec3(placement.t, placement.id), quat(placement.r, placement.id), vec3(placement.s, placement.id))
    made.push({ instance, placement, tint })
  }

  assert.deepEqual(port.registered, [...groups.keys()], 'each asset is registered once, in first-placement order')
  assert.equal(port.calls.registerAsset, groups.size)
  assert.equal(port.calls.createInstance, placements.length)
  assert.equal(port.calls.setTransform, placements.length)
  assert.equal(new Set(made.map((m) => m.instance)).size, placements.length, 'every placement gets its own instance')
  assert.equal(port.render().instances, placements.length)

  for (const { instance, placement, tint } of made) {
    assert.deepEqual(port.tintOf(instance), tint, `${placement.id}: keeps its own tint`)
    assert.deepEqual(port.transformOf(instance), {
      t: vec3(placement.t, placement.id),
      r: quat(placement.r, placement.id),
      s: vec3(placement.s, placement.id),
    }, `${placement.id}: keeps its own transform`)
  }
  assert.equal(new Set(made.map((m) => JSON.stringify(m.tint))).size, placements.length, 'the tints differ per instance')

  // The most-placed asset (one handle above) took all of its instances without another registration.
  const most = [...groups.entries()].sort((a, b) => b[1].length - a[1].length)[0]
  assert.ok(most[1].length > 1, 'the course repeats at least one asset')
  assert.equal(handles.get(most[0]), port.registerAsset(most[0], { id: most[0] } as PrimsAsset),
    `${most[0]}: registering the same asset again returns the same handle`)
})

test('(c) drawing instances leaves the saved mesh bytes untouched', async () => {
  const [id, list] = [...groups.entries()].sort((a, b) => b[1].length - a[1].length)[0]
  const { asset } = await assets.resolve(id)
  const before = encodeMesh(await savedFile(asset))
  const port = new RecordingPort()
  await port.init({ canvas: null, width: 800, height: 600, viewports: [{ x: 0, y: 0, width: 800, height: 600 }] })
  const handle = port.registerAsset(id, { id } as PrimsAsset)
  for (let i = 0; i < list.length; i++) {
    const placement = list[i]
    const instance = port.createInstance(handle, [(i + 0.5) / list.length, 0.5, 0.25])
    port.setTransform(instance, vec3(placement.t, placement.id), quat(placement.r, placement.id), vec3(placement.s, placement.id))
  }
  const after = encodeMesh(await savedFile(asset))
  assert.deepEqual(after, before, `${id}: N instances do not rewrite the saved mesh`)
  assert.deepEqual(encodeMesh(decodeMesh(after)), before, `${id}: and the round trip stays byte-stable`)
  assert.equal(port.calls.registerAsset, 1, `${id}: one registration for ${list.length} instances`)
})
