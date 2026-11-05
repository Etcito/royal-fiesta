import assert from 'node:assert/strict'
import test from 'node:test'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GameAsset } from '../../packages/game/src/gameAsset.ts'
import { parseGameAsset } from '../../packages/game/src/gameAsset.ts'
import type { MeshedAsset } from '../../apps/web/src/sdf/mamaApi.ts'
import { meshRequestOf } from '../../apps/web/src/sdf/mamaApi.ts'
import { decodeMesh, encodeMesh } from '../../apps/web/src/sdf/meshWire.ts'
import { mamaSource } from '../bricks.ts'
import { main, saveMeshes } from '../saveMeshes.ts'

const compatibility = 'test-compatibility'
const ids = ['candy.banner', 'candy.cloud']
function content(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rf-save-meshes-'))
  mkdirSync(join(dir, 'assets/candy'), { recursive: true })
  mkdirSync(join(dir, 'assets/other'), { recursive: true })
  mkdirSync(join(dir, 'courses'))
  for (const [i, id] of ids.entries()) {
    const world = i ? 'other' : 'candy'
    cpSync(new URL(`../../assets/candy/${id}.asset.json`, import.meta.url), join(dir, `assets/${world}/${id}.asset.json`))
    writeFileSync(join(dir, `assets/${world}/${id}.mesh`), 'original')
  }
  return dir
}
function fake(asset: GameAsset): MeshedAsset {
  return { assetId: asset.id, hash: asset.hash, mesher: asset.mesher.output, parts: 2, triangles: 1, transfer: [], data: { groups: [{ parts: [{ fieldProgram: { format: 'test' } }, { fieldRefusal: 'test refusal' }] }] } }
}

test('saves keyed meshes atomically and filters world and id', async () => {
  const dir = content()
  try {
    const path = join(dir, 'assets/candy/candy.banner.mesh')
    const result = await saveMeshes({ dir, worlds: ['candy'], ids: [ids[0]], compatibility, mesh: async asset => {
      assert.equal(readFileSync(path, 'utf8'), 'original')
      return fake(asset)
    } })
    assert.equal(result.length, 1)
    assert.deepEqual([result[0].status, result[0].parts, result[0].field, result[0].refused], ['saved', 2, 1, 1])
    const decoded = decodeMesh(readFileSync(path))
    assert.match(decoded.key!, /^[a-f0-9]{64}$/)
    assert.equal(decoded.assetId, ids[0])
    assert.equal(result[0].bytes, readFileSync(path).length)
    assert.equal(existsSync(path + '.tmp'), false)
    assert.equal(readFileSync(join(dir, 'assets/other/candy.cloud.mesh'), 'utf8'), 'original')
    assert.deepEqual(await saveMeshes({ dir, worlds: ['other'], ids: [ids[0]], compatibility, mesh: async asset => fake(asset) }), [])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('jobs caps concurrent assets and failures do not stop other saves', async () => {
  const dir = content()
  try {
    let active = 0
    let peak = 0
    const mesh = async (asset: GameAsset): Promise<MeshedAsset> => {
      active++
      peak = Math.max(peak, active)
      await new Promise(resolve => setTimeout(resolve, 15))
      active--
      if (asset.id === ids[0]) throw new Error('fake failure')
      return fake(asset)
    }
    const opts = { dir, compatibility, jobs: 1, mesh }
    const results = await saveMeshes(opts)
    assert.equal(peak, 1)
    assert.deepEqual(results.map(r => r.status), ['failed', 'saved'])
    assert.match(results[0].reason!, /fake failure/)
    assert.equal(existsSync(join(dir, 'assets/candy/candy.banner.mesh.tmp')), false)
    assert.equal(existsSync(join(dir, 'assets/other/candy.cloud.mesh.tmp')), false)
    assert.equal(await main([], opts), 1)
    peak = 0
    await saveMeshes({ ...opts, jobs: 2 })
    assert.equal(peak, 2)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// A content dir with one candy mechanism asset and a placeholder saved mesh.
function mechanism(id: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'rf-save-meshes-'))
  mkdirSync(join(dir, 'assets/candy'), { recursive: true })
  mkdirSync(join(dir, 'courses'))
  cpSync(new URL(`../../assets/candy/${id}.asset.json`, import.meta.url), join(dir, `assets/candy/${id}.asset.json`))
  writeFileSync(join(dir, `assets/candy/${id}.mesh`), 'not a mesh')
  return dir
}

test('a mechanism asset keeps its named physics parts with field programs on', async () => {
  if (mamaSource().kind === 'absent') return
  const dir = mechanism('candy.spinner-bar')
  try {
    const results = await saveMeshes({ dir, ids: ['candy.spinner-bar'], jobs: 1 })
    assert.equal(results.length, 1)
    assert.equal(results[0].status, 'saved', results[0].reason)
    const asset = await parseGameAsset(JSON.parse(readFileSync(join(dir, 'assets/candy/candy.spinner-bar.asset.json'), 'utf8')), 'assets/candy/candy.spinner-bar.asset.json')
    const expected = meshRequestOf(asset).parts ?? []
    assert.ok(expected.length > 0)
    const saved = decodeMesh(new Uint8Array(readFileSync(join(dir, 'assets/candy/candy.spinner-bar.mesh'))))
    const parts = (saved.data as { groups: { parts: { name?: string; meshes?: unknown[]; fieldProgram?: unknown; fieldRefusal?: unknown }[] }[] }).groups.flatMap(group => group.parts)
    const names = new Set(parts.map(part => part.name))
    assert.deepEqual(expected.filter(name => !names.has(name)), [])
    const meshed = parts.filter(part => (part.meshes?.length ?? 0) > 0)
    assert.ok(meshed.length > 0)
    assert.ok(meshed.some(part => part.fieldProgram != null), 'a meshed part has its field program')
    assert.ok(meshed.every(part => part.fieldProgram != null || part.fieldRefusal != null), 'every meshed part has a field program or why it has none')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('refuses to write a mesh that drops the named physics parts', async () => {
  const dir = mechanism('candy.spinner-bar')
  try {
    const target = join(dir, 'assets/candy/candy.spinner-bar.mesh')
    const asset = await parseGameAsset(JSON.parse(readFileSync(join(dir, 'assets/candy/candy.spinner-bar.asset.json'), 'utf8')), 'assets/candy/candy.spinner-bar.asset.json')
    const names = meshRequestOf(asset).parts ?? []
    const previous: MeshedAsset = { assetId: asset.id, hash: asset.hash, mesher: asset.mesher.output, parts: names.length, triangles: 0, transfer: [], data: { groups: [{ parts: names.map(name => ({ name, meshes: [] })) }] } }
    writeFileSync(target, encodeMesh(previous))
    const before = readFileSync(target)
    const merged: MeshedAsset = { ...previous, data: { groups: [{ parts: [{ name: 'Spinner Bar', meshes: [] }] }] } }
    const results = await saveMeshes({ dir, ids: ['candy.spinner-bar'], jobs: 1, compatibility: 'test', mesh: async () => merged })
    assert.equal(results[0].status, 'failed')
    assert.match(results[0].reason!, /lacks named physics parts/)
    assert.deepEqual(readFileSync(target), before)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
