import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import type { Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { afterEach } from 'node:test'
import { play } from '../play.ts'

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
