import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { audioCacheDir } from '../bake-audio.ts'

test('the sound cache lives under RF_CACHE_DIR, outside the checkout', () => {
  const was = process.env.RF_CACHE_DIR
  process.env.RF_CACHE_DIR = '/tmp/rf-root'
  try {
    assert.equal(audioCacheDir(), join('/tmp/rf-root', 'audio'))
  } finally {
    if (was === undefined) delete process.env.RF_CACHE_DIR
    else process.env.RF_CACHE_DIR = was
  }
})

test('one key per sound: a second bake renders nothing, a missing sound alone is rendered again', { timeout: 900_000 }, () => {
  const root = mkdtempSync(join(tmpdir(), 'rf-cache-'))
  const env = { ...process.env, RF_CACHE_DIR: root }
  const run = (out: string) => execFileSync(process.execPath, ['--experimental-strip-types', 'tools/bake-audio.ts', '--out', out], { env, encoding: 'utf8' })
  const rendered = (log: string) => Number(/\((\d+) rendered, (\d+) from the cache\)/.exec(log)?.[1])
  try {
    const first = rendered(run(join(root, 'out1')))
    assert.ok(first > 50, `the first bake renders every sound (${first})`)
    assert.equal(rendered(run(join(root, 'out2'))), 0)
    const sounds = join(root, 'audio', 'sounds')
    const [one] = readdirSync(sounds)
    rmSync(join(sounds, one), { recursive: true, force: true })
    assert.equal(rendered(run(join(root, 'out3'))), 1)
    assert.ok(existsSync(join(root, 'out3', 'manifest.json')))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
