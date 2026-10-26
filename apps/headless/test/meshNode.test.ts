import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import test from 'node:test'
import { RefusalError } from '@royal-fiesta/sim/refusal'
import { nodeGameAssets } from '../src/contentFiles.ts'

const present = existsSync(new URL('../../../.bricks/MAMA', import.meta.url))
if (!present) console.info('INFO meshNode tests skipped: .bricks/MAMA is absent')
const moduleUrl = new URL('../src/mama/meshNode.ts', import.meta.url).href
const passing = [
  'candy.podium-block', 'candy.seesaw-plank', 'penguin.body', 'candy.slime-pool',
  'candy.banner', 'candy.hot-air-balloon', 'candy.tower', 'candy.cloud',
]
for (const id of passing) {
  test(`meshNode passes through ${id}`, { skip: !present }, async () => {
    const { meshGameAsset } = await import(moduleUrl)
    const { asset } = await nodeGameAssets().resolve(id)
    const before = JSON.stringify(asset)
    const result = await meshGameAsset(asset)
    assert.ok(result.parts >= 1)
    assert.ok(result.triangles > 0)
    assert.equal(result.assetId, id)
    assert.equal(result.hash, asset.hash)
    assert.equal(JSON.stringify(asset), before)
  })
}

test('meshNode names the asset and group on a quad refusal', { skip: !present }, async () => {
  const { meshGameAsset } = await import(moduleUrl)
  const { asset } = await nodeGameAssets().resolve('candy.checkpoint-gate')
  // Quad still refuses the saved gate geometry.
  const forced = structuredClone(asset)
  const nodes = forced.document.nodes as Record<string, { mesher: { output: string } }>
  nodes.candy_checkpoint_gate.mesher = { output: 'quad' }
  await assert.rejects(meshGameAsset(forced), (error: unknown) => {
    assert.ok(error instanceof RefusalError)
    assert.equal(error.area, 'mesh')
    assert.equal(error.path, 'candy.checkpoint-gate#candy_checkpoint_gate')
    assert.match(error.reason, /not 2-manifold|does not project onto the surface/)
    return true
  })
})

test('meshNode terminates a group at its timeout', { skip: !present }, async () => {
  const { meshGameAsset } = await import(moduleUrl)
  const { asset } = await nodeGameAssets().resolve('candy.cloud')
  await assert.rejects(meshGameAsset(asset, { timeoutMs: 1 }), (error: unknown) => {
    assert.ok(error instanceof RefusalError)
    assert.equal(error.area, 'mesh')
    assert.equal(error.path, 'candy.cloud#candy_cloud')
    assert.match(error.reason, /timed out after 0.001 s;/)
    return true
  })
})

test('meshNode meshes every group and preserves its declared mesher', { skip: !present }, async () => {
  const { meshGameAsset } = await import(moduleUrl)
  const { asset: source } = await nodeGameAssets().resolve('candy.cloud')
  const asset = structuredClone(source)
  const nodes = asset.document.nodes as Record<string, { id: string; children?: string[] }>
  for (const [id, node] of Object.entries(nodes)) {
    nodes[`${id}_second`] = {
      ...structuredClone(node),
      id: `${id}_second`,
      ...(node.children ? { children: node.children.map(child => `${child}_second`) } : {}),
    }
  }
  const roots = asset.document.root as string[]
  roots.push('candy_cloud_second')
  // Both groups retain the saved cloud's mesher, which must win over the asset-level default.
  asset.mesher = { output: 'quad' }
  const before = JSON.stringify(asset)
  const result = await meshGameAsset(asset)
  assert.equal(result.parts, 2)
  assert.ok(result.triangles > 0)
  assert.deepEqual((result.data as { groups: { group: string }[] }).groups.map(group => group.group), ['candy_cloud', 'candy_cloud_second'])
  assert.equal(JSON.stringify(asset), before)
})
