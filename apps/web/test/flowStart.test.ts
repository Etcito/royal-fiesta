import assert from 'node:assert/strict'
import test from 'node:test'
import { LOCAL_COSMETICS, startScreen, startStep } from '@royal-fiesta/game/flow/startScreen'
import type { StartScreenModel } from '@royal-fiesta/game/flow/startScreen'
import type { PrimsAsset } from '@royal-fiesta/game/prims'
import { NullRenderPort } from '@royal-fiesta/game/render/nullPort'
import { PALETTE } from '@royal-fiesta/game/render/palette'
import type { QuatT, SkinnedAssetT, Vec3T } from '@royal-fiesta/game/render/port'
import { SceneLayer } from '@royal-fiesta/game/render/sceneLayer'
import type { MenuModel } from '@royal-fiesta/game/screens/menuModel'
import type { Action } from '@royal-fiesta/game/screens/nav'
import { mountStartScreen } from '../src/screens/startScreen.ts'
import type { StartArt } from '../src/screens/startScreen.ts'
import type { WidgetProps } from '../src/ui/screenMap.ts'
import type { UaaHost } from '../src/ui/uaaHost.ts'

class RecordingPort extends NullRenderPort {
  readonly registered: string[] = []
  readonly skins: string[] = []
  readonly created: { instance: number; asset: number; tint: Vec3T | null }[] = []
  readonly destroyed: number[] = []
  readonly transforms = new Map<number, { t: Vec3T; r: QuatT; s: Vec3T }>()

  override registerAsset(id: string, asset: PrimsAsset): number {
    this.registered.push(id)
    return super.registerAsset(id, asset)
  }
  override registerSkinned(id: string, skin: SkinnedAssetT): number {
    this.skins.push(id)
    return super.registerSkinned(id, skin)
  }
  override createInstance(asset: number, tint: Vec3T | null): number {
    const instance = super.createInstance(asset, tint)
    this.created.push({ instance, asset, tint })
    return instance
  }
  override destroyInstance(instance: number): void {
    super.destroyInstance(instance)
    this.destroyed.push(instance)
  }
  override setTransform(instance: number, t: Vec3T, r: QuatT, s: Vec3T): void {
    super.setTransform(instance, t, r, s)
    this.transforms.set(instance, { t, r, s })
  }
}

function asset(id: string): PrimsAsset {
  return {
    format: 'raa.prims', version: 0, id, name: id, nodes: [], materials: {}, anchors: {},
    budget: { triangles: 1500, segments: 16 }, collision: { mode: 'override', colliders: [] },
  }
}

const ids = LOCAL_COSMETICS.map(item => item.id)
const mounts = new Map<string, Vec3T>(ids.map((id, i) => [id, [0.2 + i, 0.8 - i * 0.3, 0.1 + i]]))
const skin: SkinnedAssetT = {
  rig: { name: 'test', bones: [{ name: 'root', parent: null }] },
  parts: [{ name: 'body', skin: { joints: new Uint16Array(4), weights: new Float32Array([1, 0, 0, 0]) } }],
}

async function setup() {
  const port = new RecordingPort()
  await port.init({ canvas: null, width: 800, height: 600, viewports: [{ x: 0, y: 0, width: 800, height: 600 }] })
  let props: Record<string, WidgetProps> = {}
  let menu: MenuModel | null = null
  let presentations = 0
  const noop = () => {}
  const host: UaaHost = {
    present(value) { menu = value; presentations++ },
    setHud(value) { props = value },
    setLoading: noop, input: noop, frame: noop, resize: noop, widgetRect: () => null,
    currentScreen: () => 'start', destroy: noop,
  }
  const cues: string[] = []
  const deps = { cue(id: string) { cues.push(id) } }
  const art: StartArt = {
    port, character: asset('penguin.body'), costume: id => asset(id), mounts,
    environment: { sky: 'candy', fog: { colour: '#ffb6df' } },
  }
  const model = startScreen(ids, LOCAL_COSMETICS, 2, {
    colour: 2, worn: { head: ids[0], body: ids[1], bottom: ids[2] },
  })
  return { port, host, deps, art, model, cues, props: () => props, menu: () => menu, presentations: () => presentations }
}

function near(actual: readonly number[], expected: readonly number[]): void {
  assert.equal(actual.length, expected.length)
  actual.forEach((value, i) => assert.ok(Math.abs(value - expected[i]) < 1e-10, `${actual} ~= ${expected}`))
}

test('start draws one rest penguin and each worn costume, turns their mounts and recreates only the tint', async t => {
  let now = 0
  t.mock.method(performance, 'now', () => now)
  const s = await setup()
  const view = mountStartScreen(s.host, s.model, s.deps, {
    ...s.art, skinned: { assetId: 'penguin.skin', skin, graph: 'unused-at-rest' },
  })
  assert.deepEqual(s.port.skins, ['penguin.skin'])
  assert.deepEqual(s.port.registered, ['penguin.skin', ...ids])
  assert.equal(s.port.render().instances, 4)
  assert.equal(s.port.render().visible, 4)
  assert.deepEqual(s.port.created.map(item => item.tint), [PALETTE[2], null, null, null])
  assert.equal(s.port.lastEnvironment, s.art.environment)
  assert.equal(s.port.poseOf(0), null)
  assert.equal(s.port.calls.setPose, 0, 'the turntable leaves the skin unposed')
  for (let i = 0; i < ids.length; i++) near(s.port.transforms.get(i + 1)!.t, mounts.get(ids[i])!)

  now = 1000
  view.update(s.model, null)
  const rotation = s.port.transforms.get(0)!.r
  assert.notDeepEqual(rotation, [0, 0, 0, 1])
  const yaw = 2 * Math.atan2(rotation[1], rotation[3])
  for (let i = 0; i < ids.length; i++) {
    const [x, y, z] = mounts.get(ids[i])!
    const transform = s.port.transforms.get(i + 1)!
    near(transform.t, [Math.cos(yaw) * x + Math.sin(yaw) * z, y, -Math.sin(yaw) * x + Math.cos(yaw) * z])
    near(transform.r, rotation)
    near(transform.s, [1, 1, 1])
  }
  assert.equal(s.port.created.length, 4, 'ordinary frames retain instances')
  s.model.colour = 4
  view.update(s.model, { action: 'right', effect: 'wear' })
  assert.deepEqual(s.port.destroyed, [0])
  assert.equal(s.port.created.length, 5)
  assert.deepEqual(s.port.created[4].tint, PALETTE[4])
  assert.equal(s.port.render().instances, 4)
  near(s.port.transforms.get(4)!.r, rotation)
  assert.equal(s.port.poseOf(4), null)

  s.model.bins[0].selected = -1
  view.update(s.model, { action: 'left', effect: 'wear' })
  assert.equal(s.port.render().instances, 3)
  assert.ok(s.port.destroyed.includes(1))
  assert.match(String(s.props()['bin-head'].text), /< None >/)
  s.model.bins[0].selected = 0
  view.update(s.model, { action: 'right', effect: 'wear' })
  assert.equal(s.port.render().instances, 4)
  assert.equal(s.port.registered.length, 4, 're-wearing reuses the registered asset')

  view.unmount()
  view.unmount()
  assert.equal(s.port.render().instances, 0)
  const presentations = s.presentations(), cues = s.cues.length
  view.update(s.model, { action: 'confirm', effect: 'play' })
  view.setVisible(true)
  assert.equal(s.presentations(), presentations)
  assert.equal(s.cues.length, cues)
  assert.equal(s.port.render().instances, 0)
})

test('missing assets or mounts are skipped; rigid ports and absent skins use the character', async () => {
  for (const rigidOnly of [false, true]) {
    const s = await setup()
    if (rigidOnly) Object.defineProperty(s.port, 'registerSkinned', { value: undefined })
    const lookedUp: string[] = []
    const view = mountStartScreen(s.host, s.model, s.deps, {
      ...s.art,
      ...(rigidOnly ? { skinned: { assetId: 'unavailable-skin', skin, graph: 'unused' } } : {}),
      mounts: new Map([...mounts].filter(([id]) => id !== ids[1])),
      costume(id) { lookedUp.push(id); return id === ids[0] ? null : asset(id) },
      environment: null,
    })
    assert.deepEqual(s.port.skins, [])
    assert.deepEqual(s.port.registered, ['penguin.body', ids[2]])
    assert.deepEqual(lookedUp, [ids[0], ids[2]])
    assert.equal(s.port.render().instances, 2)
    assert.equal(s.port.lastEnvironment, null)
    s.model.bins.forEach(bin => { bin.selected = -1 })
    view.update(s.model, null)
    assert.equal(s.port.render().instances, 1)
    view.unmount()
  }
})

test('step notifications drive move/confirm cues and HUD selection uses swatch stars', async () => {
  const s = await setup()
  let model: StartScreenModel = s.model
  const view = mountStartScreen(s.host, model, s.deps, s.art)
  assert.equal(s.menu()?.screen, 'start')
  assert.deepEqual(s.props()['palette-mark'], { visible: false })
  assert.deepEqual(s.props()['inbox-badge'], { text: { count: '2' }, visible: true })
  assert.match(String(s.props()['bin-head'].text), /< Propeller hat >/)
  assert.match(String(s.props()['bin-body'].text), /< Pineapple suit >/)
  assert.match(String(s.props()['bin-bottom'].text), /< Fish scarf >/)
  view.update(model, null)
  assert.deepEqual(s.cues, [])

  function act(action: Action, cue: string | null): void {
    const step = startStep(model, action)
    model = step.model
    const before = s.cues.length
    view.update(model, { ...step, action })
    assert.deepEqual(s.cues.slice(before), cue === null ? [] : [cue], `${action} / ${step.effect}`)
  }
  act('confirm', null)
  act('right', 'ui.hover')
  act('left', 'ui.hover')
  act('up', 'ui.hover') // shop
  act('left', null) // play
  act('confirm', 'ui.click')
  act('right', null) // shop
  act('confirm', 'ui.click')
  act('down', 'ui.hover') // head
  act('down', 'ui.hover') // body
  act('down', 'ui.hover') // bottom
  act('down', 'ui.hover') // palette
  act('confirm', null)
  act('right', 'ui.hover')
  PALETTE.forEach((_, i) => {
    assert.deepEqual(s.props()[`palette-${i}`], { visible: true, text: { count: i === model.colour ? '*' : '' } })
  })
  act('left', 'ui.hover')
  assert.deepEqual(s.props()[`palette-${model.colour}`], { visible: true, text: { count: '*' } })
  assert.deepEqual(s.props()[`palette-${model.colour + 1}`], { visible: true, text: { count: '' } })
  model.badge = 0
  view.update(model, null)
  assert.deepEqual(s.props()['inbox-badge'], { text: { count: '0' }, visible: false })
  view.unmount()
})

test('the start layer hides its instances and restores its environment independently of another scene', async () => {
  const s = await setup()
  const other = new SceneLayer(s.port)
  const otherInstance = other.port.createInstance(other.port.registerAsset('other', asset('other')), null)
  const otherEnvironment = { sky: 'hub' }
  other.port.setEnvironment(otherEnvironment)
  other.setVisible(false)
  const view = mountStartScreen(s.host, s.model, s.deps, s.art)
  assert.equal(s.port.render().visible, 4)
  view.setVisible(false)
  other.setVisible(true)
  assert.equal(s.port.render().visible, 1)
  assert.equal(s.port.lastEnvironment, otherEnvironment)
  const presentations = s.presentations()
  s.model.colour = 6
  view.update(s.model, null)
  assert.equal(s.presentations(), presentations, 'hidden updates do not replace the active UI screen')
  assert.equal(s.port.render().visible, 1, 'instances recreated while hidden remain hidden')
  assert.equal(s.port.lastEnvironment, otherEnvironment)
  other.setVisible(false)
  view.setVisible(true)
  assert.equal(s.port.render().visible, 4)
  assert.equal(s.port.lastEnvironment, s.art.environment)
  view.unmount()
  other.setVisible(true)
  assert.equal(s.port.render().instances, 1, 'unmount destroys only the start screen instances')
  assert.equal(s.port.render().visible, 1)
  assert.equal(s.port.lastEnvironment, otherEnvironment)
  other.port.destroyInstance(otherInstance)
})
