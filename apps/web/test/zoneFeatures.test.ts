import assert from 'node:assert/strict'
import test from 'node:test'
import { SnapReader, SnapWriter } from '@gamesaloon/rollback'
import type { EmitterCommand } from '@royal-fiesta/game/audio/emitters'
import type { PrimsAsset } from '@royal-fiesta/game/prims'
import { NullRenderPort } from '@royal-fiesta/game/render/nullPort'
import { PALETTE } from '@royal-fiesta/game/render/palette'
import type { Vec3T } from '@royal-fiesta/game/render/port'
import type { FeatureDraw, FeatureSound } from '@royal-fiesta/sim/features/feature'
import type { FiestaDomain } from '@royal-fiesta/sim/zones/fiestaDomain'
import { MatchLedger } from '@royal-fiesta/sim/zones/ledger'
import { discloseSeed, ZoneFeatures, ZoneFeatureAudio, zoneSlot } from '../src/zone/zoneLobbyPlay.ts'

class RecordingPort extends NullRenderPort {
  readonly made: { asset: number; tint: Vec3T | null; instance: number }[] = []
  readonly destroyed: number[] = []
  readonly visibility = new Map<number, boolean>()
  override createInstance(asset: number, tint: Vec3T | null): number {
    const instance = super.createInstance(asset, tint)
    this.made.push({ asset, tint, instance })
    return instance
  }
  override destroyInstance(instance: number): void {
    super.destroyInstance(instance)
    this.destroyed.push(instance)
  }
  override setVisible(instance: number, visible: boolean): void {
    super.setVisible(instance, visible)
    this.visibility.set(instance, visible)
  }
}

function draw(): FeatureDraw {
  return { asset: 'marker', tint: 0, visible: true,
    t: { x: 1, y: 2, z: 3 }, r: { x: 0, y: 0, z: 0, w: 1 }, s: { x: 1, y: 1, z: 1 } }
}

function fixture() {
  const order: string[] = []
  const scratches: FeatureDraw[][] = []
  const parts = [[draw(), draw()], [draw(), draw()]]
  const domain = { features: ['alpha', 'beta'].map((id, i) => ({ id, draw(out: FeatureDraw[]) {
    order.push(id)
    scratches.push(out)
    assert.equal(out.length, 0, 'scratch is cleared for each feature')
    out.push(...parts[i])
  } })) } as unknown as FiestaDomain
  return { domain, parts, order, scratches }
}

const asset = { id: 'marker' } as PrimsAsset

test('feature pools use feature id and local part index, tint recreation, hiding and teardown', () => {
  const port = new RecordingPort()
  const view = new ZoneFeatures(port, () => asset)
  const f = fixture()
  view.update(f.domain)
  assert.deepEqual(f.order, ['alpha', 'beta'])
  assert.equal(port.made.length, 4, 'alpha#0, alpha#1, beta#0 and beta#1 are distinct')
  assert.equal(port.render().instances, 4)
  assert.ok(port.made.every(entry => entry.tint === null))
  f.parts[0][1].tint = 2
  view.update(f.domain)
  assert.deepEqual(port.destroyed, [1])
  assert.equal(port.made.length, 5, 'only alpha#1 was recreated')
  assert.deepEqual(port.made[4].tint, PALETTE[1])
  assert.equal(port.calls.setTransform, 8)
  assert.deepEqual(f.order, ['alpha', 'beta', 'alpha', 'beta'])
  assert.ok(f.scratches.every(scratch => scratch === f.scratches[0]), 'one scratch array across frames and features')
  const hiddenPart = f.parts[0].pop()!
  view.update(f.domain)
  assert.equal(port.visibility.get(4), false, 'alpha#1 is hidden')
  assert.equal(port.visibility.get(2), true, 'beta#0 keeps its instance despite the shorter alpha output')
  assert.equal(port.visibility.get(3), true, 'beta#1 keeps its instance')
  assert.deepEqual(port.destroyed, [1], 'an undrawn part is retained')
  f.parts[0].push(hiddenPart)
  view.update(f.domain)
  assert.equal(port.made.length, 5)
  assert.equal(port.visibility.get(4), true)
  f.parts[1][0].asset = 'replacement'
  view.update(f.domain)
  assert.deepEqual(port.destroyed, [1, 2], 'asset changes also recreate only that part')
  f.parts[1][1].visible = false
  view.update(f.domain)
  assert.equal(port.visibility.get(3), false)
  view.update(undefined)
  assert.equal(port.render().instances, 0, 'a domain handoff destroys its whole pool')
  view.update(f.domain)
  assert.equal(port.render().instances, 4)
  view.dispose()
  view.dispose()
  assert.equal(port.render().instances, 0)
})

test('feature sounds retain position and strength and shared split domains drain once', () => {
  const batches: EmitterCommand[][] = []
  const audio = new ZoneFeatureAudio({
    apply(commands, n) { batches.push(commands.slice(0, n).map(command => ({ ...command }))) },
    setListeners() {}, dispose() {},
  })
  let drains = 0
  let sounds: FeatureSound[] = [
    { key: '', rate: 1, id: 'obj.goal', pos: { x: 1, y: 2, z: 3 }, strength: 0.4, loop: false },
    { key: 'motor', rate: 1, id: 'mech.motor', pos: { x: 4, y: 5, z: 6 }, strength: 0.7, loop: true },
  ]
  const domain = { drainFeatureSounds(out: FeatureSound[]) {
    drains++
    out.push(...sounds)
    sounds = sounds.filter(sound => sound.loop)
    return out.length
  } } as FiestaDomain
  audio.frame([domain, domain, undefined])
  assert.equal(drains, 1)
  assert.deepEqual(batches[0].map(({ patch, kind, x, y, z, strength, loop }) =>
    ({ patch, kind, x, y, z, strength, loop })), [
    { patch: 'obj.goal', kind: 'trigger', x: 1, y: 2, z: 3, strength: 0.4, loop: false },
    { patch: 'mech.motor', kind: 'start', x: 4, y: 5, z: 6, strength: 0.7, loop: true },
  ])
  audio.frame([domain])
  assert.equal(batches[1][0].kind, 'move')
  audio.dispose()
  assert.equal(batches[2][0].kind, 'stop')
  new ZoneFeatureAudio().frame([domain])
  assert.equal(drains, 3, 'sounds are drained even when audio is unavailable')
})

test('the disclosed seed is the seed stored in the ledger snapshot', () => {
  const seed = 0xfedcba98
  const slot = zoneSlot('race', 8, seed)
  const spec = { id: 0, kind: 'global' as const, cells: [], seats: [], replicas: [0] }
  const ledger = new MatchLedger(spec, 0, {
    ...slot, seatCount: 8, introTicks: 60, roundTicks: 600, openingRanks: null,
  })
  const writer = new SnapWriter()
  ledger.snapshot(writer)
  const reader = new SnapReader(writer.bytes())
  reader.u16(); reader.u8(); reader.bool(); reader.u8(); reader.u16(); reader.bool()
  reader.i32(); reader.i32(); reader.i32()
  assert.equal(reader.u32(), seed)

  let removed = false
  let appended: unknown
  const label = { textContent: '', style: { cssText: '' }, remove() { removed = true } }
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document')
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {
    createElement(tag: string) { assert.equal(tag, 'output'); return label },
  } })
  try {
    const remove = discloseSeed({ appendChild(child: unknown) { appended = child } } as HTMLElement, seed)
    assert.equal(appended, label)
    assert.equal(label.textContent, `Match seed: ${seed}`)
    remove()
    assert.equal(removed, true)
  } finally {
    if (previous) Object.defineProperty(globalThis, 'document', previous)
    else Reflect.deleteProperty(globalThis, 'document')
  }
})

test('a moving laser key starts, forwards rate, moves without restarting and stops', () => {
  const batches: EmitterCommand[][] = []
  const audio = new ZoneFeatureAudio({
    apply(commands, n) { batches.push(commands.slice(0, n).map(c => ({ ...c }))) },
    setListeners() {}, dispose() {},
  })
  let sounds: FeatureSound[] = [{ key: 'sweep:laser', id: 'mech.laser', pos: { x: 1, y: 0, z: 0 }, strength: 1, rate: 1, loop: true }]
  const domain = { drainFeatureSounds(out: FeatureSound[]) { out.push(...sounds); return out.length } } as FiestaDomain
  audio.frame([domain])
  sounds = [{ ...sounds[0], pos: { x: 2, y: 0, z: 1 }, rate: 1.5 }]
  audio.frame([domain])
  sounds = []
  audio.frame([domain])
  assert.deepEqual(batches.map(b => b.map(c => [c.id, c.kind, c.rate])), [
    [['feature:sweep:laser', 'start', 1]], [['feature:sweep:laser', 'move', 1.5]], [['feature:sweep:laser', 'stop', 1.5]],
  ])
  audio.dispose()
})
