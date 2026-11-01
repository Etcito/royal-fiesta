import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { audioCacheDir } from '../bake-audio.ts'
import { meshCacheDir, rfCacheRoot } from '../content.ts'

const vars = ['RF_CACHE_DIR', 'RF_AUDIO_CACHE_DIR', 'RF_MESH_CACHE_DIR', 'TMPDIR'] as const
const saved = Object.fromEntries(vars.map((name) => [name, process.env[name]]))
const base = mkdtempSync(join(tmpdir(), 'rf-cache-dir-'))
test.afterEach(() => {
  for (const name of vars) {
    if (saved[name] === undefined) delete process.env[name]
    else process.env[name] = saved[name]
  }
})
test.after(() => rmSync(base, { recursive: true, force: true }))

/** A linked worktree whose git common dir lies under a regular file, so rf-cache can never be created there
 * (like a sandboxed card worktree whose main .git is read-only, and independent of the user running it). */
function sandboxedWorktree(name: string): string {
  const root = join(base, name, 'worktree')
  const gitDir = join(base, name, 'gitdir')
  mkdirSync(root, { recursive: true })
  mkdirSync(gitDir, { recursive: true })
  writeFileSync(join(base, name, 'blocked'), '')
  writeFileSync(join(root, '.git'), `gitdir: ${gitDir}\n`)
  writeFileSync(join(gitDir, 'commondir'), join(base, name, 'blocked', 'main.git'))
  return root
}

test('a non-writable git common dir falls back to <tmpdir>/rf-cache for audio and meshes', () => {
  const root = sandboxedWorktree('tmp-fallback')
  const tmp = join(base, 'tmp-fallback', 'tmp')
  process.env.TMPDIR = tmp
  delete process.env.RF_CACHE_DIR
  delete process.env.RF_AUDIO_CACHE_DIR
  delete process.env.RF_MESH_CACHE_DIR
  assert.equal(rfCacheRoot(root), join(tmp, 'rf-cache'))
  assert.equal(audioCacheDir(root), join(tmp, 'rf-cache', 'audio'))
  assert.equal(meshCacheDir(root), join(tmp, 'rf-cache', 'meshes'))
})

test('RF_CACHE_DIR wins over the git common dir', () => {
  const root = sandboxedWorktree('env')
  process.env.RF_CACHE_DIR = join(base, 'env', 'cache')
  delete process.env.RF_AUDIO_CACHE_DIR
  assert.equal(audioCacheDir(root), join(base, 'env', 'cache', 'audio'))
})

test('a writable git common dir keeps <git common dir>/rf-cache, so host cache hits are unchanged', () => {
  const root = join(base, 'host', 'repo')
  mkdirSync(join(root, '.git'), { recursive: true })
  delete process.env.RF_CACHE_DIR
  delete process.env.RF_AUDIO_CACHE_DIR
  assert.equal(audioCacheDir(root), join(root, '.git', 'rf-cache', 'audio'))
})

test('no writable cache directory at all disables the audio cache instead of failing', () => {
  const root = sandboxedWorktree('none')
  process.env.TMPDIR = join(base, 'none', 'blocked', 'tmp')
  process.env.RF_CACHE_DIR = join(base, 'none', 'blocked', 'cache')
  delete process.env.RF_AUDIO_CACHE_DIR
  assert.equal(rfCacheRoot(root), null)
  assert.equal(audioCacheDir(root), null)
  process.env.RF_AUDIO_CACHE_DIR = join(base, 'none', 'blocked', 'audio')
  assert.equal(audioCacheDir(root), null)
})
