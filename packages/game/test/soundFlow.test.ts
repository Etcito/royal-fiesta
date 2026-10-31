import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { analyse, renderBank } from '@etcito/haa-spatial/bank'
import { loadModule } from '@etcito/haa-spatial/node'
import { SOUNDS } from '../src/audio/catalog.ts'
import { FLOW_FAMILIES } from '../src/audio/sounds/flow.ts'

const ROOT = new URL('../../../', import.meta.url)
const flow = SOUNDS.filter(sound => sound.group === 'flow')
const module = await loadModule()

function readPatch(source: string): any {
  return JSON.parse(readFileSync(new URL(source, ROOT), 'utf8'))
}

test('every flow catalog id has one family and its matching patch, in catalog order', () => {
  assert.deepEqual(FLOW_FAMILIES.map(family => family.id), flow.map(sound => sound.id))
  for (const sound of flow) {
    assert.equal(sound.source, `audio/${sound.id}.haa.json`)
    const patch = readPatch(sound.source)
    assert.equal(patch.id, sound.id, sound.source)
  }
})

test('flow families list exactly one bake entry per catalog variant, with the patch length', () => {
  for (const [index, sound] of flow.entries()) {
    const { entries } = FLOW_FAMILIES[index]!
    const patch = readPatch(sound.source)
    assert.equal(entries.length, sound.variants, sound.id)
    assert.deepEqual(entries.map(entry => entry.variant),
      Array.from({ length: sound.variants }, (_, variant) => variant), sound.id)
    for (const entry of entries) {
      assert.equal(entry.seconds, patch.graph.duration, sound.id)
      assert.equal(entry.inputs, undefined, sound.id)
      assert.equal(entry.ramps, undefined, sound.id)
      assert.equal(entry.triggers, undefined, sound.id)
    }
  }
})

for (const family of FLOW_FAMILIES) {
  test(`${family.id}: every variant renders functional audio`, () => {
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
  })
}

test('flow.elim-drop: its 8 variants are pairwise different', () => {
  const family = FLOW_FAMILIES.find(entry => entry.id === 'flow.elim-drop')!
  assert.equal(family.entries.length, 8)
  const patch = readFileSync(new URL('audio/flow.elim-drop.haa.json', ROOT), 'utf8')
  const renders = renderBank(module, patch, family.entries)
  for (let a = 0; a < renders.length; a++) {
    for (let b = a + 1; b < renders.length; b++) {
      assert.notDeepEqual(
        [renders[a]!.render.left, renders[a]!.render.right],
        [renders[b]!.render.left, renders[b]!.render.right],
        `flow.elim-drop: variants ${a} and ${b} must differ`,
      )
    }
  }
})
