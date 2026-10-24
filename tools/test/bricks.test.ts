import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import test, { afterEach } from 'node:test'
import {
  brickDir, checkBricks, fetchMama, fetchUaa, githubToken, mamaSource, raaLocal, readPins, repoRoot,
  uaaSource,
} from '../bricks.ts'
import type { BrickName } from '../bricks.ts'
import { RefusalError } from '../../packages/sim/src/refusal.ts'

const ENV_KEYS = [
  'RF_BRICKS_DIR', 'GAMESALOON_DIR', 'RF_RAA_LOCAL', 'MAMA_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN',
  'PATH', 'RF_STUB_RECORD', 'RF_STUB_FAIL',
] as const
const saved = new Map<string, string | undefined>(ENV_KEYS.map((key) => [key, process.env[key]]))
const temps: string[] = []

function temp(prefix = 'rf-bricks-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  temps.push(dir)
  return dir
}

// Every test starts from the env it found, so an override never leaks into the next one. The
// fetchMama tests clone into a temp root, so removing the temps removes their .bricks/MAMA too.
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
  writeFileSync(file, JSON.stringify({
    MAMA: { repo: 'Etcito/MAMA', commit: 'ABC' },
    UAA: { repo: 'Etcito/uaa', commit: 'ABC' },
  }))
  assert.throws(() => readPins(file), (error: unknown) =>
    error instanceof RefusalError
    && error.message.startsWith('[bricks] bricks.pins.json#/MAMA/commit:')
    && error.message.includes('40 lowercase hex'),
  )
})

test('readPins parses the UAA pin next to MAMA', () => {
  const pins = readPins()
  assert.equal(pins.UAA.repo, 'Etcito/uaa')
  assert.match(pins.UAA.commit, /^[0-9a-f]{40}$/)
  const dir = temp()
  const file = join(dir, 'bricks.pins.json')
  writeFileSync(file, JSON.stringify({
    MAMA: pins.MAMA,
    UAA: { repo: 'Etcito/uaa', commit: 'abc' },
  }))
  assert.throws(() => readPins(file), (error: unknown) =>
    error instanceof RefusalError
    && error.message.startsWith('[bricks] bricks.pins.json#/UAA/commit:')
    && error.message.includes('40 lowercase hex'),
  )
})

test('readPins refuses an unknown brick key', () => {
  const dir = temp()
  const file = join(dir, 'bricks.pins.json')
  const { MAMA, UAA } = readPins()
  writeFileSync(file, JSON.stringify({ MAMA, UAA, RAA: {} }))
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

// A stub git and npm, first on PATH: each call appends its tool, argv, cwd and env (names and
// values) to $RF_STUB_RECORD, then plays its part of the clone. `fetch` echoes the auth header and
// the decoded credentials, as a verbose git could, so the redaction is exercised.
const STUB = `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const tool = path.basename(process.argv[1])
const argv = process.argv.slice(2)
fs.appendFileSync(process.env.RF_STUB_RECORD, JSON.stringify({ tool, argv, cwd: process.cwd(), env: process.env }) + '\\n')
if (tool === 'git' && argv[0] === 'init') fs.mkdirSync('.git', { recursive: true })
if (tool === 'git' && argv[0] === 'fetch') {
  const header = process.env.GIT_CONFIG_VALUE_0 || ''
  console.log('stub: header ' + header)
  console.error('stub: user ' + Buffer.from(header.slice(header.lastIndexOf(' ') + 1), 'base64').toString('utf8'))
  if (process.env.RF_STUB_FAIL === '1') process.exit(128)
  fs.writeFileSync('.git/FETCH_HEAD', argv[argv.length - 1] + '\\n')
}
if (tool === 'git' && argv[0] === 'checkout') fs.copyFileSync('.git/FETCH_HEAD', '.git/HEAD')
if (tool === 'npm' && argv[0] === 'run') fs.mkdirSync('dist', { recursive: true })
`

interface StubCall { tool: string; argv: string[]; cwd: string; env: Record<string, string> }

// A temp repository root whose parent has no MAMA, an empty RF_BRICKS_DIR and no token variables,
// so neither a real sibling nor a real token is picked up.
function stubWorld(): { root: string; bricks: string; record: string } {
  const base = temp()
  const root = join(base, 'repo')
  const bricks = join(base, 'bricks')
  const bin = join(base, 'bin')
  for (const dir of [root, bricks, bin]) mkdirSync(dir)
  for (const tool of ['git', 'npm']) {
    writeFileSync(join(bin, tool), STUB)
    chmodSync(join(bin, tool), 0o755)
  }
  const record = join(base, 'record.jsonl')
  process.env.PATH = `${bin}${delimiter}${process.env.PATH ?? ''}`
  process.env.RF_BRICKS_DIR = bricks
  process.env.RF_STUB_RECORD = record
  delete process.env.RF_STUB_FAIL
  for (const key of ['MAMA_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN']) delete process.env[key]
  return { root, bricks, record }
}

function readRecord(record: string): StubCall[] {
  if (!existsSync(record)) return []
  return readFileSync(record, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as StubCall)
}

// Not a real token shape; built at run time so no secret-like literal is committed.
function fakeToken(): { token: string; basic: string } {
  const token = ['rf', 'fake', randomBytes(16).toString('hex')].join('-')
  return { token, basic: Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64') }
}

test('fetchMama passes the token only as the base64 auth header in GIT_CONFIG_VALUE_0', async () => {
  const world = stubWorld()
  const { token, basic } = fakeToken()
  process.env.MAMA_TOKEN = token
  const pin = readPins().MAMA
  const source = await fetchMama(world.root, () => {})
  assert.equal(source.kind, 'cloned')
  if (source.kind === 'cloned') {
    assert.equal(source.commit, pin.commit)
    assert.equal(source.dir, realpathSync(join(world.root, '.bricks', 'MAMA')))
  }
  const calls = readRecord(world.record)
  assert.deepEqual(calls.map((call) => [call.tool, ...call.argv].join(' ')), [
    'git init --quiet',
    `git fetch --depth 1 https://github.com/${pin.repo}.git ${pin.commit}`,
    'git checkout --quiet --detach FETCH_HEAD',
    'npm ci --no-audit --no-fund',
  ])
  assert.ok(!readFileSync(world.record, 'utf8').includes(token), 'the raw token reached a child argv or env')
  assert.ok(calls.every((call) => call.argv.every((arg) => !arg.includes(basic))), 'the encoded token reached an argv')
  const holders = calls.flatMap((call) => Object.entries(call.env)
    .filter(([, value]) => value.includes(basic))
    .map(([name]) => `${call.tool} ${call.argv[0]}: ${name}`))
  assert.deepEqual(holders, ['git fetch: GIT_CONFIG_VALUE_0'])
  const fetchEnv = calls[1].env
  assert.equal(fetchEnv.GIT_CONFIG_COUNT, '1')
  assert.equal(fetchEnv.GIT_CONFIG_KEY_0, 'http.https://github.com/.extraheader')
  assert.ok(fetchEnv.GIT_CONFIG_VALUE_0 === `AUTHORIZATION: basic ${basic}`, 'GIT_CONFIG_VALUE_0 is not the basic auth header')
})

test('fetchMama prints child output redacted', async () => {
  const world = stubWorld()
  const { token, basic } = fakeToken()
  process.env.MAMA_TOKEN = token
  const printed: string[] = []
  await fetchMama(world.root, (line) => printed.push(line))
  const text = printed.join('\n')
  assert.ok(text.includes('stub: header AUTHORIZATION: basic <redacted>'), 'the child stdout was not printed redacted')
  assert.ok(text.includes('stub: user x-access-token:<redacted>'), 'the child stderr was not printed redacted')
  assert.ok(!text.includes(token) && !text.includes(basic), 'printed output carries the token')
})

test('fetchMama removes .bricks/MAMA when a step fails', async () => {
  const world = stubWorld()
  const { token, basic } = fakeToken()
  process.env.MAMA_TOKEN = token
  process.env.RF_STUB_FAIL = '1'
  const printed: string[] = []
  await assert.rejects(fetchMama(world.root, (line) => printed.push(line)), (error: unknown) =>
    error instanceof RefusalError && error.message.startsWith('[bricks] MAMA: git fetch exited 128;'),
  )
  assert.equal(existsSync(join(world.root, '.bricks', 'MAMA')), false)
  const text = printed.join('\n')
  assert.ok(!text.includes(token) && !text.includes(basic), 'printed output carries the token')
})

test('fetchMama links a sibling and runs npm ci there when node_modules is missing', async () => {
  const world = stubWorld()
  const pin = readPins().MAMA.commit
  const sibling = join(world.bricks, 'MAMA')
  mkdirSync(join(sibling, '.git'), { recursive: true })
  writeFileSync(join(sibling, '.git', 'HEAD'), `${pin}\n`)
  process.env.MAMA_TOKEN = fakeToken().token
  const source = await fetchMama(world.root, () => {})
  assert.deepEqual(source, { kind: 'sibling', dir: realpathSync(sibling), commit: pin, matchesPin: true })
  assert.ok(lstatSync(join(world.root, '.bricks', 'MAMA')).isSymbolicLink())
  const calls = readRecord(world.record)
  assert.deepEqual(calls.map((call) => [call.tool, ...call.argv].join(' ')), ['npm ci --no-audit --no-fund'])
  assert.equal(realpathSync(calls[0].cwd), realpathSync(sibling))
})

test('fetchMama refuses without a sibling and without a token', async () => {
  const world = stubWorld()
  await assert.rejects(fetchMama(world.root, () => {}), (error: unknown) =>
    error instanceof RefusalError
    && error.message === '[bricks] MAMA: not found; clone Etcito/MAMA next to this repository or set MAMA_TOKEN on the build machine',
  )
  assert.equal(existsSync(join(world.root, '.bricks')), false)
  assert.deepEqual(readRecord(world.record), [])
})

// ../uaa relative to a temp repository root: the directory the game imports as file:../uaa.
function uaaSibling(root: string): string {
  return join(root, '..', 'uaa')
}

function pinUaaSibling(root: string, commit: string): string {
  const sibling = uaaSibling(root)
  mkdirSync(join(sibling, '.git'), { recursive: true })
  writeFileSync(join(sibling, '.git', 'HEAD'), `${commit}\n`)
  return sibling
}

test('uaaSource finds the ../uaa sibling and is absent without one', () => {
  const base = temp()
  const root = join(base, 'repo')
  mkdirSync(root, { recursive: true })
  const pinned = readPins().UAA.commit
  const sibling = pinUaaSibling(root, pinned)
  const found = uaaSource(root)
  assert.equal(found.kind, 'sibling')
  if (found.kind === 'sibling') {
    assert.equal(found.dir, realpathSync(sibling))
    assert.equal(found.commit, pinned)
    assert.equal(found.matchesPin, true)
  }
  const other = temp()
  const emptyRoot = join(other, 'repo')
  mkdirSync(emptyRoot, { recursive: true })
  const absent = uaaSource(emptyRoot)
  assert.equal(absent.kind, 'absent')
  if (absent.kind === 'absent') assert.match(absent.reason, /fetch uaa/)
})

test('fetchUaa links a sibling at the pin and skips the build when dist exists', async () => {
  const world = stubWorld()
  const pin = readPins().UAA.commit
  const sibling = pinUaaSibling(world.root, pin)
  mkdirSync(join(sibling, 'dist'))
  const source = await fetchUaa(world.root, () => {})
  assert.equal(source.kind, 'sibling')
  if (source.kind === 'sibling') {
    assert.equal(source.dir, realpathSync(sibling))
    assert.equal(source.commit, pin)
    assert.equal(source.matchesPin, true)
  }
  assert.ok(lstatSync(join(world.root, '.bricks', 'UAA')).isSymbolicLink())
  assert.deepEqual(readRecord(world.record), [])
})

test('fetchUaa runs npm ci and npm run build in ../uaa when dist is missing', async () => {
  const world = stubWorld()
  const sibling = pinUaaSibling(world.root, readPins().UAA.commit)
  const source = await fetchUaa(world.root, () => {})
  assert.equal(source.kind, 'sibling')
  const calls = readRecord(world.record)
  assert.deepEqual(calls.map((call) => [call.tool, ...call.argv].join(' ')), [
    'npm ci --no-audit --no-fund',
    'npm run build',
  ])
  assert.ok(calls.every((call) => realpathSync(call.cwd) === realpathSync(sibling)))
  assert.ok(existsSync(join(sibling, 'dist')))
})

test('fetchUaa clones the pin into ../uaa, builds it and never prints the token', async () => {
  const world = stubWorld()
  const { token, basic } = fakeToken()
  process.env.MAMA_TOKEN = token
  const pin = readPins().UAA
  const printed: string[] = []
  const source = await fetchUaa(world.root, (line) => printed.push(line))
  assert.equal(source.kind, 'cloned')
  const target = uaaSibling(world.root)
  if (source.kind === 'cloned') {
    assert.equal(source.commit, pin.commit)
    assert.equal(source.dir, realpathSync(target))
  }
  assert.ok(lstatSync(join(world.root, '.bricks', 'UAA')).isSymbolicLink())
  const calls = readRecord(world.record)
  assert.deepEqual(calls.map((call) => [call.tool, ...call.argv].join(' ')), [
    'git init --quiet',
    `git fetch --depth 1 https://github.com/${pin.repo}.git ${pin.commit}`,
    'git checkout --quiet --detach FETCH_HEAD',
    'npm ci --no-audit --no-fund',
    'npm run build',
  ])
  assert.ok(existsSync(join(target, 'dist')))
  assert.ok(!readFileSync(world.record, 'utf8').includes(token), 'the raw token reached a child argv or env')
  assert.ok(calls.every((call) => call.argv.every((arg) => !arg.includes(basic))), 'the encoded token reached an argv')
  const holders = calls.flatMap((call) => Object.entries(call.env)
    .filter(([, value]) => value.includes(basic))
    .map(([name]) => `${call.tool} ${call.argv[0]}: ${name}`))
  assert.deepEqual(holders, ['git fetch: GIT_CONFIG_VALUE_0'])
  const text = printed.join('\n')
  assert.ok(!text.includes(token) && !text.includes(basic), 'printed output carries the token')
})

test('fetchUaa refuses a sibling at another commit and names the fix', async () => {
  const world = stubWorld()
  pinUaaSibling(world.root, '0'.repeat(40))
  await assert.rejects(fetchUaa(world.root, () => {}), (error: unknown) =>
    error instanceof RefusalError
    && error.message.startsWith('[bricks] UAA:')
    && error.message.includes('expected the pin')
    && error.message.includes('bricks.pins.json'),
  )
  assert.equal(existsSync(join(world.root, '.bricks', 'UAA')), false)
  assert.deepEqual(readRecord(world.record), [])
})

test('fetchUaa refuses without a sibling and without a token', async () => {
  const world = stubWorld()
  await assert.rejects(fetchUaa(world.root, () => {}), (error: unknown) =>
    error instanceof RefusalError
    && error.message === '[bricks] UAA: not found; clone Etcito/uaa next to this repository or set MAMA_TOKEN, GH_TOKEN or GITHUB_TOKEN on the build machine',
  )
  assert.equal(existsSync(join(world.root, '.bricks')), false)
  assert.deepEqual(readRecord(world.record), [])
})

test('fetchUaa removes ../uaa when a clone step fails', async () => {
  const world = stubWorld()
  process.env.MAMA_TOKEN = fakeToken().token
  process.env.RF_STUB_FAIL = '1'
  await assert.rejects(fetchUaa(world.root, () => {}), (error: unknown) =>
    error instanceof RefusalError && error.message.startsWith('[bricks] UAA: git fetch exited 128;'),
  )
  assert.equal(existsSync(uaaSibling(world.root)), false)
  assert.equal(existsSync(join(world.root, '.bricks', 'UAA')), false)
})
