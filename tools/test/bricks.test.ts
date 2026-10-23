import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { afterEach } from 'node:test'
import {
  brickDir, checkBricks, githubToken, mamaSource, raaLocal, readPins, repoRoot,
} from '../bricks.ts'
import type { BrickName } from '../bricks.ts'
import { RefusalError } from '../../packages/sim/src/refusal.ts'

const ENV_KEYS = ['RF_BRICKS_DIR', 'GAMESALOON_DIR', 'RF_RAA_LOCAL', 'MAMA_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'] as const
const saved = new Map<string, string | undefined>(ENV_KEYS.map((key) => [key, process.env[key]]))
const temps: string[] = []

function temp(prefix = 'rf-bricks-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  temps.push(dir)
  return dir
}

// Every test starts from the env it found, so an override never leaks into the next one.
afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = saved.get(key)
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  while (temps.length > 0) rmSync(temps.pop() as string, { recursive: true, force: true })
})

test('repoRoot is the royal-fiesta package root', () => {
  const root = repoRoot()
  assert.equal(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).name, 'royal-fiesta')
})

test('brick overrides take precedence in the documented order', () => {
  const tempDir = temp()
  const envDir = join(tempDir, 'override')
  const rfDir = join(tempDir, 'rf', 'gamesaloon-public')
  mkdirSync(envDir, { recursive: true })
  mkdirSync(rfDir, { recursive: true })
  process.env.GAMESALOON_DIR = envDir
  process.env.RF_BRICKS_DIR = join(tempDir, 'rf')
  assert.equal(brickDir('gamesaloon-public'), realpathSync(envDir))
  delete process.env.GAMESALOON_DIR
  assert.equal(brickDir('gamesaloon-public'), realpathSync(rfDir))
})

test('brickDir returns null for a missing brick', () => {
  const empty = temp()
  process.env.RF_BRICKS_DIR = empty
  assert.equal(brickDir('missing-brick' as BrickName), null)
})

test('readPins accepts the committed file and refuses a bad commit with its pointer', () => {
  const pins = readPins()
  assert.equal(pins.MAMA.repo, 'Etcito/MAMA')
  assert.match(pins.MAMA.commit, /^[0-9a-f]{40}$/)
  const dir = temp()
  const file = join(dir, 'bricks.pins.json')
  writeFileSync(file, JSON.stringify({ MAMA: { repo: 'Etcito/MAMA', commit: 'ABC' } }))
  assert.throws(() => readPins(file), (error: unknown) =>
    error instanceof RefusalError
    && error.message.startsWith('[bricks] bricks.pins.json#/MAMA/commit:')
    && error.message.includes('40 lowercase hex'),
  )
})

test('readPins refuses an unknown brick key', () => {
  const dir = temp()
  const file = join(dir, 'bricks.pins.json')
  writeFileSync(file, JSON.stringify({ MAMA: { repo: 'Etcito/MAMA', commit: readPins().MAMA.commit }, RAA: {} }))
  assert.throws(() => readPins(file), (error: unknown) =>
    error instanceof RefusalError && error.message.includes('bricks.pins.json#/RAA'),
  )
})

test('mamaSource finds a sibling through RF_BRICKS_DIR and is absent without one', () => {
  const base = temp()
  const root = join(base, 'repo')
  const bricks = join(base, 'bricks')
  mkdirSync(root, { recursive: true })
  mkdirSync(join(bricks, 'MAMA'), { recursive: true })
  process.env.RF_BRICKS_DIR = bricks
  const found = mamaSource(root)
  assert.equal(found.kind, 'sibling')
  if (found.kind === 'sibling') {
    assert.equal(found.dir, realpathSync(join(bricks, 'MAMA')))
    assert.equal(found.commit, null)
    assert.equal(found.matchesPin, false)
  }
  const empty = join(base, 'empty')
  process.env.RF_BRICKS_DIR = empty
  mkdirSync(empty)
  const absent = mamaSource(root)
  assert.equal(absent.kind, 'absent')
  if (absent.kind === 'absent') assert.match(absent.reason, /MAMA/)
})

test('mamaSource reads .bricks/MAMA as a symlink and as a clone from its git files', () => {
  const pin = readPins().MAMA.commit
  const base = temp()
  const checkout = join(base, 'MAMA')
  mkdirSync(join(checkout, '.git'), { recursive: true })
  writeFileSync(join(checkout, '.git', 'HEAD'), `${pin}\n`)
  const linkedRoot = join(base, 'linked')
  mkdirSync(join(linkedRoot, '.bricks'), { recursive: true })
  symlinkSync(checkout, join(linkedRoot, '.bricks', 'MAMA'), 'dir')
  const linked = mamaSource(linkedRoot)
  assert.equal(linked.kind, 'sibling')
  if (linked.kind === 'sibling') {
    assert.equal(linked.commit, pin)
    assert.equal(linked.matchesPin, true)
  }
  unlinkSync(join(linkedRoot, '.bricks', 'MAMA'))
  const clonedRoot = join(base, 'cloned')
  mkdirSync(join(clonedRoot, '.bricks', 'MAMA', '.git'), { recursive: true })
  writeFileSync(join(clonedRoot, '.bricks', 'MAMA', '.git', 'HEAD'), `${pin}\n`)
  const cloned = mamaSource(clonedRoot)
  assert.equal(cloned.kind, 'cloned')
  if (cloned.kind === 'cloned') assert.equal(cloned.commit, pin)
})

test('githubToken prefers MAMA_TOKEN, then GH_TOKEN, then GITHUB_TOKEN', () => {
  delete process.env.MAMA_TOKEN
  delete process.env.GH_TOKEN
  delete process.env.GITHUB_TOKEN
  assert.equal(githubToken(), null)
  process.env.GITHUB_TOKEN = 'github'
  assert.equal(githubToken(), 'github')
  process.env.GH_TOKEN = 'gh'
  assert.equal(githubToken(), 'gh')
  process.env.MAMA_TOKEN = 'mama'
  assert.equal(githubToken(), 'mama')
})

test('raaLocal is off by default and on with RF_RAA_LOCAL=1 and a raa brick', () => {
  const bricks = temp()
  mkdirSync(join(bricks, 'raa'), { recursive: true })
  process.env.RF_BRICKS_DIR = bricks
  delete process.env.RF_RAA_LOCAL
  assert.deepEqual(raaLocal(), { active: false, dir: null })
  process.env.RF_RAA_LOCAL = '1'
  assert.deepEqual(raaLocal(), { active: true, dir: realpathSync(join(bricks, 'raa')) })
})

test('checkBricks stays ok without MAMA', async () => {
  const result = await checkBricks()
  assert.equal(result.ok, true, result.lines.join('\n'))
  assert.ok(result.lines.some((line) => line.includes('MAMA')), result.lines.join('\n'))
  assert.ok(result.lines.some((line) => line.includes('RF_RAA_LOCAL')), result.lines.join('\n'))
  assert.ok(!result.lines.some((line) => line.startsWith('FAIL ')), result.lines.join('\n'))
})
