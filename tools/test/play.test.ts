import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import type { Server } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test, { afterEach } from 'node:test'
import { fileURLToPath } from 'node:url'
import { play, serveDir } from '../play.ts'

const ENV_KEYS = ['RF_PLAY_SKIP_BUILD', 'RF_PLAY_DIST'] as const
const saved = new Map<string, string | undefined>(ENV_KEYS.map((key) => [key, process.env[key]]))
const temps: string[] = []

afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
})

// A temp dist served through the two test seams, so no build runs.
function fakeDist(files: readonly string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'rf-play-'))
  temps.push(dir)
  mkdirSync(join(dir, 'assets'))
  for (const file of files) writeFileSync(join(dir, file), file.endsWith('.js') ? 'export {}\n' : '<!doctype html>\n')
  process.env.RF_PLAY_SKIP_BUILD = '1'
  process.env.RF_PLAY_DIST = dir
  return dir
}

function listenFree(): Promise<Server> {
  return new Promise((resolveServer, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolveServer(server))
  })
}

function portOf(server: Server): number {
  const address = server.address()
  assert.ok(address !== null && typeof address === 'object')
  return address.port
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolveClose) => server.close(() => resolveClose()))
}

async function freePort(): Promise<number> {
  const server = await listenFree()
  const port = portOf(server)
  await closeServer(server)
  return port
}

async function quiet<T>(fn: () => Promise<T>): Promise<{ value: T; out: string; err: string }> {
  const log = console.log
  const error = console.error
  let out = ''
  let err = ''
  console.log = (...args: unknown[]) => { out += args.join(' ') + '\n' }
  console.error = (...args: unknown[]) => { err += args.join(' ') + '\n' }
  try {
    return { value: await fn(), out, err }
  } finally {
    console.log = log
    console.error = error
  }
}

test('play --check answers 200 for game.html, play.html and a built asset', async () => {
  fakeDist(['game.html', 'play.html', 'assets/a.js'])
  const port = await freePort()
  const { value, out } = await quiet(() => play({ check: true, port }))
  assert.equal(value, 0)
  assert.match(out, new RegExp(`play: http://localhost:${port}/game\\.html`))
  assert.match(out, /GET \/assets\/a\.js 200/)
})

test('play --check fails when game.html is missing', async () => {
  fakeDist(['play.html', 'assets/a.js'])
  const port = await freePort()
  const { value, out } = await quiet(() => play({ check: true, port }))
  assert.equal(value, 1)
  assert.match(out, /GET \/game\.html 404/)
})

test('play refuses a busy port', async () => {
  fakeDist(['game.html', 'play.html', 'assets/a.js'])
  const busy = await listenFree()
  const port = portOf(busy)
  try {
    const { value, err } = await quiet(() => play({ check: true, port }))
    assert.equal(value, 1)
    assert.equal(err.trim(), `[bricks] port ${port}: in use; stop the other server`)
  } finally {
    await closeServer(busy)
  }
})

// Only the argument check runs: the clone itself needs network.
test('cleanClone CLI without --out exits 1 with the usage line', () => {
  const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
  const result = spawnSync(process.execPath, ['--experimental-strip-types', join('tools', 'cleanClone.ts')], {
    cwd: root, encoding: 'utf8', timeout: 30000,
  })
  assert.equal(result.status, 1)
  assert.equal(result.stdout, '')
  assert.ok(result.stderr.split('\n').includes('usage: node --experimental-strip-types tools/cleanClone.ts --out <file>'), result.stderr)
})


test('play serves live content, the index, saved meshes and audio, and no mesh baking', async () => {
  const dist = fakeDist(['game.html'])
  const content = mkdtempSync(join(tmpdir(), 'rf-content-routes-'))
  temps.push(content)
  mkdirSync(join(content, 'assets/candy'), { recursive: true })
  mkdirSync(join(content, 'courses'))
  mkdirSync(join(content, 'audio'))
  writeFileSync(join(content, 'assets/candy/candy.box.asset.json'), '{"hash":"h"}')
  writeFileSync(join(content, 'assets/candy/candy.box.mesh'), new Uint8Array([1, 2, 3]))
  writeFileSync(join(content, 'courses/demo.course.json'), '{}')
  writeFileSync(join(content, 'audio/bell.haa.json'), '{"haa":1,"id":"bell"}')
  writeFileSync(join(content, 'secret.txt'), 'no')
  const before = process.env.RF_CONTENT_DIR
  process.env.RF_CONTENT_DIR = content
  const server = serveDir(dist)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${portOf(server)}`
  try {
    const mesh = await fetch(base + '/content/assets/candy/candy.box.mesh')
    assert.equal(mesh.status, 200)
    assert.equal(mesh.headers.get('content-type'), 'application/octet-stream')
    assert.deepEqual(new Uint8Array(await mesh.arrayBuffer()), new Uint8Array([1, 2, 3]))
    const audio = await fetch(base + '/content/audio/bell.haa.json')
    assert.equal(audio.status, 200)
    assert.deepEqual(await audio.json(), { haa: 1, id: 'bell' })
    assert.equal((await fetch(base + '/content/courses/demo.course.json')).status, 200)
    const index = await (await fetch(base + '/content/index.json')).json()
    assert.equal(index.assets[0].mesh, 'assets/candy/candy.box.mesh')
    assert.deepEqual(index.audio, [{ id: 'bell', path: 'audio/bell.haa.json' }])
    assert.equal((await fetch(base + '/content/secret.txt')).status, 404)
    assert.equal((await fetch(base + '/content/assets/candy/missing.mesh')).status, 404)
    assert.equal((await fetch(base + '/meshes/' + 'a'.repeat(64))).status, 404)
  } finally {
    if (before === undefined) delete process.env.RF_CONTENT_DIR
    else process.env.RF_CONTENT_DIR = before
    server.closeAllConnections()
    await closeServer(server)
  }
})
