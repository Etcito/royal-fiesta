import assert from 'node:assert/strict'
import test from 'node:test'
import { SceneLayer } from '../src/render/sceneLayer.ts'
import { NullRenderPort } from '../src/render/nullPort.ts'
import type { PrimsAsset } from '../src/prims.ts'

test('prepared scenes retain instances and restore visibility and environment independently', async () => {
  const target = new NullRenderPort()
  await target.init({ canvas: null, width: 640, height: 360, viewports: [{ x: 0, y: 0, width: 640, height: 360 }] })
  const hub = new SceneLayer(target)
  const round = new SceneLayer(target)
  const asset = target.registerAsset('bean', {} as PrimsAsset)
  const hubBean = hub.port.createInstance(asset, null)
  round.port.createInstance(asset, null)
  const hiddenBean = round.port.createInstance(asset, null)
  round.port.setVisible(hiddenBean, false)
  const hubEnv = { sky: 'hub' }, roundEnv = { sky: 'round' }
  hub.port.setEnvironment(hubEnv)
  round.port.setEnvironment(roundEnv)
  round.setVisible(false)
  hub.setVisible(false)
  hub.setVisible(true)
  assert.equal(target.lastEnvironment, hubEnv)
  assert.equal(target.render().visible, 1)
  const created = target.calls.createInstance
  hub.setVisible(false)
  round.setVisible(true)
  assert.equal(target.lastEnvironment, roundEnv)
  assert.equal(target.render().visible, 1, 'parked beans stay hidden')
  assert.equal(target.calls.createInstance, created, 'launch does not rebuild instances')
  hub.port.destroyInstance(hubBean)
  hub.setVisible(true)
  assert.equal(target.render().instances, 2, 'destroyed instances are never restored')
})
