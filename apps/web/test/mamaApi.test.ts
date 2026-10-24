// The MAMA facade without MAMA: Node cannot import virtual:rf-mama, so loadMamaFacade must refuse
// with the named absent message, and mamaApi.ts must stay free of MAMA, raa-sdfm and tools imports.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { isRefusal } from '@royal-fiesta/sim/refusal'
import { MAMA_ABSENT_PREFIX } from '../../../tools/bricks.ts'
import { loadMamaFacade } from '../src/sdf/mamaApi.ts'

const SOURCE = readFileSync(new URL('../src/sdf/mamaApi.ts', import.meta.url), 'utf8')

test('loadMamaFacade refuses with [sdf] MAMA: MAMA not available', async () => {
  await assert.rejects(loadMamaFacade(), (e: unknown) => {
    assert.ok(isRefusal(e), String(e))
    assert.equal(e.area, 'sdf')
    assert.equal(e.path, 'MAMA')
    assert.ok(e.message.startsWith(`[sdf] MAMA: ${MAMA_ABSENT_PREFIX}`), e.message)
    return true
  })
})

test('the prefix in mamaApi.ts equals MAMA_ABSENT_PREFIX of tools/bricks.ts', () => {
  const m = /const MAMA_ABSENT_PREFIX = '([^']*)'/.exec(SOURCE)
  assert.ok(m !== null, 'mamaApi.ts declares MAMA_ABSENT_PREFIX')
  assert.equal(m[1], MAMA_ABSENT_PREFIX)
})

test('mamaApi.ts imports no MAMA, raa-sdfm or tools/ module', () => {
  const specifiers = [...SOURCE.matchAll(/\b(?:import|from)\s*\(?\s*'([^']+)'/g)].map((m) => m[1])
  assert.ok(specifiers.length > 0)
  for (const s of specifiers) {
    assert.ok(!s.includes('@etcito/mama'), s)
    assert.ok(!s.includes('raa-sdfm'), s)
    assert.ok(!s.includes('tools/'), s)
  }
})
