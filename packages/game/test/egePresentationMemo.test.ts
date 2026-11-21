import assert from 'node:assert/strict'
import test from 'node:test'
import { PresentationMemo } from '../src/ege/showRuntime.ts'

// One entity, one `ege.zone.id` record of 4 bytes: header (entity count at byte 24), entity ids, then the block.
function snapshot(zone: number): Uint8Array {
  const bytes = new Uint8Array(48 + 4 + 8 + 4 + 4)
  const view = new DataView(bytes.buffer)
  view.setUint32(24, 1, true)
  view.setUint32(48, 7, true)
  view.setUint32(52, 1, true)
  view.setUint32(56, 4, true)
  view.setUint32(60, 7, true)
  view.setUint32(64, zone, true)
  return bytes
}

const layout = { components: [{ name: 'ege.zone.id', lane: 'simulation', id: 0 }] } as never

test('the online presentation resolves a world once while its mapping bytes are unchanged', () => {
  let zone = 1
  const engine = { snapshot: () => snapshot(zone) } as never
  const sim = { world: 0 } as never
  const memo = new PresentationMemo()
  let builds = 0
  const resolve = () => memo.resolve(engine, layout, sim, () => ({ ref: 'fresh' }) as never, () => { builds++; return { ref: 'built' } as never })
  resolve()
  const afterFew = builds
  for (let tick = 0; tick < 5000; tick++) resolve()
  assert.equal(builds, afterFew, 'unchanged bytes never resolve again, however many calls')
  assert.equal(memo.kept, true)
  zone = 2
  resolve()
  assert.equal(builds, afterFew + 1, 'changed mapping bytes resolve once more')
  memo.clear()
  assert.equal(memo.kept, false)
})
