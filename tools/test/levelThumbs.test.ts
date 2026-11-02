import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { measuredWaitMs, persistentThumbDir } from '../levelThumbs.ts'

test('wait uses measured course_save time and never exceeds the GPU ceiling', () => {
  assert.equal(measuredWaitMs(160_000), 255_000)
  assert.equal(measuredWaitMs(220_000), 300_000)
  assert.throws(() => measuredWaitMs(NaN))
  assert.throws(() => measuredWaitMs(0))
})

test('persistent cache requires a location outside the checkout', () => {
  const previous = process.env.NMC_CACHE_DIR
  const root = mkdtempSync(join(tmpdir(), 'thumb-cache-test-'))
  try {
    delete process.env.NMC_CACHE_DIR
    assert.throws(() => persistentThumbDir(root), /NMC_CACHE_DIR is required/)
    process.env.NMC_CACHE_DIR = join(root, 'cache')
    assert.throws(() => persistentThumbDir(root), /outside the checkout/)
    process.env.NMC_CACHE_DIR = join(root, 'external')
    assert.equal(persistentThumbDir(join(root, 'checkout')), join(root, 'external/level-thumbs/v1'))
  } finally {
    if (previous === undefined) delete process.env.NMC_CACHE_DIR
    else process.env.NMC_CACHE_DIR = previous
    rmSync(root, { recursive: true, force: true })
  }
})
