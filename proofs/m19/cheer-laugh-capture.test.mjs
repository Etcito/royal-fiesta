// Transport parsing only: these fixtures are not GPU evidence and submit no jobs.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { captureResult } from './cheer-laugh-capture.mjs'

test('blank probe requires the operation result, not transport success', () => {
  assert.throws(() => captureResult({ ok: true, result: { json: { error: 'page failed' } } }, 'ok', 'fixture'),
    /no object with "ok"/)
  assert.equal(captureResult({ ok: true, result: { json: { ok: false } } }, 'ok', 'fixture').ok, false)
  assert.equal(captureResult({ result: { json: { ok: true }, files: [] } }, 'ok', 'fixture').ok, true)
})

test('hardware evidence comes from the operation inside the transport', () => {
  const operation = { hardware: false, renderer: 'raa' }
  assert.equal(captureResult({ hardware: true, result: { json: operation } }, 'hardware', 'fixture'), operation)
  assert.throws(() => captureResult({ hardware: true }, 'hardware', 'fixture'), /result envelope missing/)
  assert.throws(() => captureResult({ hardware: true, result: {} }, 'hardware', 'fixture'),
    /no object with "hardware"/)
})
