// The lobby's root leak: a RenderPort has no way to free a registered asset, so leaving the lobby for a
// level left its hub meshes and textures registered. releaseAsset(handle) frees them and forgets the
// handle, so the same id registers again when the hub comes back.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { PrimsAsset } from '@royal-fiesta/game/prims'
import { NullRenderPort } from '@royal-fiesta/game/render/nullPort'

function asset(id: string): PrimsAsset {
  return {
    format: 'raa.prims', version: 0, id, name: id, nodes: [], materials: {}, anchors: {},
    collision: { mode: 'derived', colliders: [] }, budget: { triangles: 1500, segments: 16 },
  }
}

const target = { canvas: null, width: 1920, height: 1080, viewports: [{ x: 0, y: 0, width: 960, height: 540 }] }

async function ready(): Promise<NullRenderPort> {
  const port = new NullRenderPort()
  await port.init(target)
  return port
}

test('releaseAsset frees the lobby assets and instances, and a re-register works', async () => {
  const port = await ready()
  const names = ['plaza-fountain', 'queue-pad', 'bean']
  const handles = names.map(name => port.registerAsset(name, asset(name)))
  const instances = handles.map(handle => port.createInstance(handle, null))
  const lobby = port.inventory()
  assert.deepEqual(lobby.assets, [...names].sort())
  assert.equal(lobby.instances, 3)

  // Leaving the lobby: instances go first, then the port frees the assets themselves.
  for (const instance of instances) port.destroyInstance(instance)
  for (const handle of handles) port.releaseAsset(handle)
  const empty = port.inventory()
  assert.deepEqual(empty.assets, [])
  assert.equal(empty.instances, 0)
  assert.equal(port.render().instances, 0)

  // Coming back: the same ids register again, with fresh handles and live instances.
  const again = port.registerAsset('plaza-fountain', asset('plaza-fountain'))
  assert.notEqual(again, handles[0])
  const live = port.createInstance(again, null)
  port.setTransform(live, [0, 0, 0], [0, 0, 0, 1], [1, 1, 1])
  const back = port.inventory()
  assert.deepEqual(back.assets, ['plaza-fountain'])
  assert.equal(back.instances, 1)
  assert.equal(port.render().instances, 1)
  port.dispose()
})

test('releaseAsset frees the instances it still holds and refuses an unknown handle', async () => {
  const port = await ready()
  const handle = port.registerAsset('hub', asset('hub'))
  port.createInstance(handle, null)
  port.releaseAsset(handle)
  const empty = port.inventory()
  assert.deepEqual(empty.assets, [])
  assert.equal(empty.instances, 0)
  assert.throws(() => port.releaseAsset(999), /unknown asset handle/)
  port.dispose()
})
