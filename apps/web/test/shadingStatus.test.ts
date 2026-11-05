import assert from 'node:assert/strict'
import test from 'node:test'
import { hardShadingFailures, shadingStatusText } from '../src/content/shadingStatus.ts'
import type { ShadingStatusReport } from '../src/content/shadingStatus.ts'

function report(overrides: Partial<ShadingStatusReport> = {}): ShadingStatusReport {
  return { pending: 0, failed: 0, vertex: 0, errors: [], ...overrides }
}

test('preparing is named while field pipelines are pending', () => {
  assert.equal(shadingStatusText(report({ pending: 3 }), 0), 'SDF shading: preparing 3 parts')
})

test('the preparing text disappears once pending is 0', () => {
  assert.equal(shadingStatusText(report({ pending: 1 }), 0), 'SDF shading: preparing 1 parts')
  assert.equal(shadingStatusText(report({ pending: 0 }), 0), null)
})

test('preparing outranks a texture bake that is also running', () => {
  assert.equal(shadingStatusText(report({ pending: 2 }), 4), 'SDF shading: preparing 2 parts')
})

test('baking textures is named with the bakes left', () => {
  assert.equal(shadingStatusText(report(), 3), 'Baking textures (3 left)')
  assert.equal(shadingStatusText(report(), 1), 'Baking textures (1 left)')
})

test('failed parts are named with the first error', () => {
  const text = shadingStatusText(report({ failed: 2, errors: ['a#g/body: shader failed', 'b#g/arm: shader failed'] }), 0)
  assert.equal(text, 'SDF shading: 2 parts on vertex colours - a#g/body: shader failed')
})

test('field-mode errors other than atlas-budget demotions are named', () => {
  const text = shadingStatusText(report({ vertex: 1, errors: ['a#g/body: field frame has scale; mesh normals'] }), 0, 'field')
  assert.equal(text, 'SDF shading: 1 parts on vertex colours - a#g/body: field frame has scale; mesh normals')
})

test('atlas-budget demotions alone keep the status hidden', () => {
  const demotions = ['a#g/body: atlas budget: smaller parts first', 'b#g/arm: texture.atlas_full']
  assert.equal(shadingStatusText(report({ vertex: 2, errors: demotions }), 0, 'field'), null)
  assert.equal(shadingStatusText(report({ vertex: 2, errors: demotions }), 0, 'baked'), null)
})

test('errors in vertex and baked modes do not show the field-mode line', () => {
  assert.equal(shadingStatusText(report({ errors: ['a#g/body: vertex mode'] }), 0, 'vertex'), null)
  assert.equal(shadingStatusText(report({ errors: ['a#g/body: bakeRefusal'] }), 0, 'baked'), null)
})

test('a failed part is named in every mode', () => {
  assert.equal(shadingStatusText(report({ failed: 1, errors: ['a#g/body: shader failed'] }), 0, 'vertex'),
    'SDF shading: 1 parts on vertex colours - a#g/body: shader failed')
  assert.equal(shadingStatusText(report({ failed: 1, errors: ['a#g/body: shader failed'] }), 0, 'baked'),
    'SDF shading: 1 parts on vertex colours - a#g/body: shader failed')
})

test('a clean report has no status line', () => {
  assert.equal(shadingStatusText(report(), 0), null)
})

test('saved field refusals and atlas demotions are named fallbacks; any other reason is a hard failure', () => {
  const errors = [
    'candy.spinner-bar#spinner_bar/bar: operand with a lattice, deformer or non-uniform scale',
    'a#g/body: atlas budget: smaller parts first',
    'b#g/arm: vertex mode',
    'c#g/top: shader failed',
    'd#g/leg: bad functionName',
  ]
  assert.deepEqual(hardShadingFailures({ errors, refused: ['candy.spinner-bar#spinner_bar/bar'] }), ['c#g/top: shader failed', 'd#g/leg: bad functionName'])
  // Without the port naming it refused, the same reason is a failure: only a saved refusal is accepted.
  assert.ok(hardShadingFailures({ errors }).includes(errors[0]))
})
