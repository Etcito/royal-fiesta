import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { analyse, renderBank } from '@etcito/haa-spatial/bank'
import { loadModule } from '@etcito/haa-spatial/node'
import { SOUNDS } from '../src/audio/catalog.ts'
import { WORLD_FAMILIES } from '../src/audio/sounds/world.ts'

const ROOT = new URL('../../../', import.meta.url)
const world = SOUNDS.filter(sound => sound.group === 'world')
const module = await loadModule()

function readPatch(source: string): any {
  return JSON.parse(readFileSync(new URL(source, ROOT), 'utf8'))
}

function publishes(patch: any, name: string): any {
  return (patch.inputs as any[]).find(input => input.name === name)
}

test('every world catalog id has one family and its matching patch, in catalog order', () => {
  assert.deepEqual(WORLD_FAMILIES.map(family => family.id), world.map(sound => sound.id))
  for (const sound of world) {
    assert.equal(sound.source, `audio/${sound.id}.haa.json`)
    const patch = readPatch(sound.source)
    assert.equal(patch.id, sound.id, sound.source)
  }
})

test('world entries start with every bake variant and append only the prescribed checks', () => {
  for (const [index, sound] of world.entries()) {
    const { entries } = WORLD_FAMILIES[index]!
    const patch = readPatch(sound.source)
    const seconds = sound.mode === 'loop' ? 3 : patch.graph.duration
    const bake = entries.slice(0, sound.variants)
    const checks = entries.slice(sound.variants)
    const loop = sound.mode === 'loop'
    const gain = !loop && publishes(patch, 'gain') !== undefined
    assert.equal(bake.length, sound.variants, sound.id)
    assert.deepEqual(bake.map(entry => entry.variant),
      Array.from({ length: sound.variants }, (_, variant) => variant), sound.id)
    assert.equal(new Set(entries.map(entry => entry.variant)).size, sound.variants, sound.id)
    assert.equal(entries.length, sound.variants + (loop ? 2 : gain ? 1 : 0), sound.id)
    for (const entry of bake) {
      assert.equal(entry.seconds, seconds, sound.id)
      assert.deepEqual(entry.inputs,
        loop ? { rate: 0.6 } : gain ? { gain: 1 } : undefined, sound.id)
      assert.equal(entry.ramps, undefined, sound.id)
      assert.equal(entry.triggers, undefined, sound.id)
    }
    assert.deepEqual(checks, loop ? [
      { variant: 0, seconds, inputs: { rate: 0.1 } },
      { variant: 0, seconds, inputs: { rate: 1 } },
    ] : gain ? [
      { variant: 0, seconds, inputs: { gain: 0.3 } },
    ] : [], sound.id)
  }
})

test('every world loop patch publishes the rate input', () => {
  for (const sound of world.filter(entry => entry.mode === 'loop')) {
    const rate = publishes(readPatch(sound.source), 'rate')
    assert.ok(rate, `${sound.id}: publishes rate`)
    assert.equal(rate.min, 0, sound.id)
    assert.equal(rate.max, 1, sound.id)
    assert.equal(rate.default, 0.6, sound.id)
  }
})

for (const family of WORLD_FAMILIES) {
  test(`${family.id}: every bake and check entry renders functional audio, with distinct one-shot variants`, () => {
    const patch = readFileSync(new URL(`audio/${family.id}.haa.json`, ROOT), 'utf8')
    const renders = renderBank(module, patch, family.entries)
    assert.equal(renders.length, family.entries.length)
    for (const [index, result] of renders.entries()) {
      const label = `${family.id} entry ${index}: ${JSON.stringify(family.entries[index])}`
      const stats = analyse(result.render)
      assert.equal(stats.nonFinite, 0, label)
      assert.equal(stats.silent, false, label)
      assert.equal(stats.clipped, false, label)
    }
    const sound = world.find(entry => entry.id === family.id)!
    if (sound.mode === 'oneshot') {
      const first = renders.find(result => result.variant === 0)!
      const second = renders.find(result => result.variant === 1)!
      assert.notDeepEqual(
        [first.render.left, first.render.right],
        [second.render.left, second.render.right],
        `${family.id}: variants 0 and 1 must differ`,
      )
    }
  })
}
