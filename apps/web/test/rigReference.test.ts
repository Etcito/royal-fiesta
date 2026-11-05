import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync, readdirSync } from 'node:fs'
import { loadRaaAnim } from '@etcito/raa-anim'
import { resolveGameRigs } from '@royal-fiesta/game/rigReference'
import { assetDocumentText, parseGameAsset } from '@royal-fiesta/game/gameAsset'
import { assetSkin } from '../src/content/cosmeticSkin.ts'
import { decodeMesh } from '../src/sdf/meshWire.ts'
import { meshCacheKey } from '../src/sdf/meshCache.ts'
import { wornPalette } from '@royal-fiesta/game/anim/jiggle'
const root = new URL('../../../', import.meta.url)
const read = (path: string): any => JSON.parse(readFileSync(new URL(path, root), 'utf8'))
const body = read('assets/common/penguin.body.asset.json')
const penguin = body.document.nodes.penguin

test('migrated jester bones retain legacy animated world transforms at four frames (raa-anim WASM)', async () => {
  const file = read('assets/common/costume.jester-hat.asset.json')
  const before = read('apps/web/test/legacyJesterFrames.json')
  const document = await resolveGameRigs(file.document, async (game, id) => game === body.game && id === body.id ? body.document : null)
  const owner = Object.values(document.nodes as Record<string, any>).find(n => n.rigRef)!
  assert.deepEqual(owner.clips.map((c: any) => c.name), penguin.clips.map((c: any) => c.name))
  const api = await loadRaaAnim()
  const { bindings, smooth, ...preset } = owner.rig
  const rig = api.loadRig(JSON.stringify(preset)), clip = api.loadClip(rig, JSON.stringify(owner.clips.find((c: any) => c.name === before.clip)))
  const mesh = decodeMesh(new Uint8Array(readFileSync(new URL('assets/common/costume.jester-hat.mesh', root))))
  const skin = assetSkin(mesh.data, document, penguin.rig)!
  const base = api.loadRig(JSON.stringify((({ bindings, smooth, ...r }) => r)(penguin.rig)))
  const baseClip = api.loadClip(base, JSON.stringify(penguin.clips.find((c: any) => c.name === before.clip)))
  try {
    for (const frame of before.frames) {
      const sample = api.sampleClip(clip, frame.tick)
      for (const [name, expected] of Object.entries(frame.models)) {
        const at = owner.rig.bones.findIndex((b: any) => b.name === name)
        const actual = sample.model.subarray(at * 16, at * 16 + 16)
        ;(expected as number[]).forEach((v, i) => assert.ok(Math.abs(actual[i] - v) < 2e-6, `${name} tick ${frame.tick}, matrix ${i}: ${actual[i]} != ${v}`))
      }
      const palette = wornPalette(skin, api.sampleClip(baseClip, frame.tick).skin)
      sample.skin.forEach((v: number, i: number) => assert.ok(Math.abs(v - palette[i]) < 2e-6, `game palette ${i} tick ${frame.tick}`))
    }
  } finally { baseClip.free(); base.free(); clip.free(); rig.free() }
})

test('all 12 costumes save a reference and local bones only, remain valid, and refuse missing source assets/nodes', async () => {
  const paths = readdirSync(new URL('assets/common/', root)).filter(p => /^costume\..*\.asset\.json$/.test(p))
  assert.equal(paths.length, 12)
  for (const path of paths) {
    const raw = read(`assets/common/${path}`)
    await parseGameAsset(raw, path)
    const owner: any = Object.values(raw.document.nodes).find((n: any) => n.rigRef)
    assert.ok(owner)
    assert.ok(!('rig' in owner) && !('clips' in owner))
    assert.deepEqual([owner.rigRef.game, owner.rigRef.id, owner.rigRef.node], ['royal-fiesta', 'penguin.body', 'penguin'])
    assert.equal(owner.rigRef.extraBones.length, path.includes('jester-hat') ? 5 : 0)
    await assert.rejects(resolveGameRigs(raw.document, async () => null), /rig reference.*asset not found/)
    await assert.rejects(resolveGameRigs(raw.document, async () => ({ nodes: {} })), /rig node not found/)
  }
})

test('source rig and animation edits propagate without changing the saved cosmetic; mesh key tracks the current rig', async () => {
  const file = read('assets/common/costume.cloud-skirt.asset.json'), saved = assetDocumentText(file.document)
  const current = structuredClone(body.document)
  const doc = await resolveGameRigs(file.document, async () => current)
  const key = (document: Record<string, unknown>) => meshCacheKey({ ...file, document }, 'test', async b => new TextDecoder().decode(b))
  const before = await key(doc)
  current.nodes.penguin.rig.bones[1].rest.t[1] += 0.1
  current.nodes.penguin.clips.push({ ...current.nodes.penguin.clips[0], name: 'future-animation' })
  const next = await resolveGameRigs(file.document, async () => current)
  const owner: any = Object.values(next.nodes as object).find((n: any) => n.rigRef)
  assert.equal(owner.clips.at(-1).name, 'future-animation')
  assert.notEqual(await key(next), before)
  assert.equal(assetDocumentText(file.document), saved)
  assert.equal(assetDocumentText(next), saved)
})
