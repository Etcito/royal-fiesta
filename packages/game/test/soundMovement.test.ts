import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { analyse, renderBank } from '@etcito/haa-spatial/bank'
import { loadModule } from '@etcito/haa-spatial/node'
import { SOUNDS } from '../src/audio/catalog.ts'
import { MOVEMENT_FAMILIES } from '../src/audio/sounds/movement.ts'

const ROOT = new URL('../../../', import.meta.url)
const movement = SOUNDS.filter(sound => sound.group === 'movement')
const module = await loadModule()

test('every movement catalog id has one family and its matching patch, in catalog order', () => {
  assert.deepEqual(MOVEMENT_FAMILIES.map(family => family.id), movement.map(sound => sound.id))
  for (const sound of movement) {
    assert.equal(sound.source, `audio/${sound.id}.haa.json`)
    const patch = JSON.parse(readFileSync(new URL(sound.source, ROOT), 'utf8'))
    assert.equal(patch.id, sound.id, sound.source)
  }
})

test('movement entries start with every bake variant and append only the prescribed checks', () => {
  for (const [index, sound] of movement.entries()) {
    const { entries } = MOVEMENT_FAMILIES[index]!
    const patch = JSON.parse(readFileSync(new URL(sound.source, ROOT), 'utf8'))
    const seconds = sound.mode === 'loop' ? 3 : patch.graph.duration
    const bake = entries.slice(0, sound.variants)
    const checks = entries.slice(sound.variants)
    const step = sound.id.startsWith('move.step.')
    const slide = sound.id === 'move.slide'
    assert.equal(bake.length, sound.variants, sound.id)
    assert.deepEqual(bake.map(entry => entry.variant),
      Array.from({ length: sound.variants }, (_, variant) => variant), sound.id)
    assert.equal(new Set(entries.map(entry => entry.variant)).size, sound.variants, sound.id)
    assert.equal(entries.length, sound.variants + (step ? 2 : slide ? 1 : 0), sound.id)
    for (const entry of bake) {
      assert.equal(entry.seconds, seconds, sound.id)
      assert.deepEqual(entry.inputs, step ? { speed: 5 } : slide ? { speed: 6 } : undefined, sound.id)
      assert.equal(entry.ramps, undefined, sound.id)
      assert.equal(entry.triggers, undefined, sound.id)
    }
    assert.deepEqual(checks, step ? [
      { variant: 0, seconds, inputs: { speed: 1 } },
      { variant: 0, seconds, inputs: { speed: 8 } },
    ] : slide ? [
      { variant: 0, seconds, ramps: { speed: [0, 12] } },
    ] : [], sound.id)
  }
})

for (const family of MOVEMENT_FAMILIES) {
  test(`${family.id}: every bake and check entry renders functional audio, with distinct variants`, () => {
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
    const first = renders.find(result => result.variant === 0)!
    const second = renders.find(result => result.variant === 1)
    if (second) {
      assert.notDeepEqual(
        [first.render.left, first.render.right],
        [second.render.left, second.render.right],
        `${family.id}: variants 0 and 1 must differ`,
      )
    }
  })
}
