import { test } from 'node:test'
import assert from 'node:assert/strict'
import { forgetWorldReads, readShowViewState } from '../src/ege/worldRead.ts'

const decl = (id: number, name: string) => ({ id, name, lane: 'simulation', size: 4, fields: [{ name: 'v', type: 'u32', offset: 0, count: 1 }] })
const layout = { components: [decl(1, 'character'), decl(2, 'other'), decl(3, 'surface')], resources: [], events: [] } as never

// EGW1: 48-byte header (tick at 12, entity count at 24), the entity ids, then one block per component:
// count, record size, the ids, the records.
function snapshot(tick: number): Uint8Array {
  const words = [7, 9]
  const bytes = new Uint8Array(48 + 4 + 3 * 16)
  const view = new DataView(bytes.buffer)
  bytes.set([0x45, 0x47, 0x57, 0x31])
  view.setUint32(12, tick, true)
  view.setUint32(24, 1, true)
  view.setUint32(48, 5, true)
  let at = 52
  for (const word of [words[0], words[1], 11]) {
    view.setUint32(at, 1, true)
    view.setUint32(at + 4, 4, true)
    view.setUint32(at + 8, 5, true)
    view.setUint32(at + 12, word, true)
    at += 16
  }
  return bytes.subarray(0, at)
}

test('only the components the views read are decoded, and the blocks after a skipped one stay aligned', () => {
  const engine = { tick: () => 3, snapshot: () => snapshot(3) } as never
  const state = readShowViewState(engine, 1, layout)
  assert.deepEqual(Object.keys(state.components).sort(), ['character', 'surface'])
  assert.equal(state.components.character['5'].v, 7)
  assert.equal(state.components.surface['5'].v, 11)
  assert.deepEqual(state.entities, [5])
})

test('a second read in the same engine tick takes no new snapshot; a new tick or a forgotten world does', () => {
  let tick = 1
  let taken = 0
  const engine = { tick: () => tick, snapshot: () => { taken++; return snapshot(tick) } } as never
  const first = readShowViewState(engine, 2, layout)
  assert.equal(readShowViewState(engine, 2, layout), first)
  assert.equal(taken, 1)
  tick = 2
  assert.notEqual(readShowViewState(engine, 2, layout), first)
  forgetWorldReads(engine, 2)
  readShowViewState(engine, 2, layout)
  assert.equal(taken, 3)
})
