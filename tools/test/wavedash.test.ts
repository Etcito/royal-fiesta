import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { leakScan } from '../guard.ts'
import { etcitoBuild } from '../etcitoBuild.ts'
import { packWavedash, wavedashToml } from '../wavedash.ts'
import { RefusalError } from '../../packages/sim/src/refusal.ts'

function tree(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'rf-wavedash-'))
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true })
    writeFileSync(join(dir, name), text)
  }
  return dir
}

async function withDist<T>(dist: string, run: () => Promise<T>): Promise<T> {
  const before = process.env.RF_WAVEDASH_DIST
  process.env.RF_WAVEDASH_DIST = dist
  try {
    return await run()
  } finally {
    if (before === undefined) delete process.env.RF_WAVEDASH_DIST
    else process.env.RF_WAVEDASH_DIST = before
  }
}

const GAME = '<!doctype html><script type="module" src="./assets/game.js"></script>\n'

test('packWavedash writes the documented layout and manifest, entry game.html', async () => {
  const dir = tree({
    'dist/index.html': '<pre id="boot">booting</pre>\n',
    'dist/game.html': GAME,
    'dist/play.html': '<canvas></canvas>\n',
    'dist/assets/game.js': 'export {}\n',
    'dist/nmc.gpu.json': '{}\n',
    'dist/store/objects/aa/aa': '{}\n',
  })
  try {
    const out = join(dir, 'out')
    const result = await withDist(join(dir, 'dist'), () => packWavedash({ outDir: out }))
    assert.equal(result.entry, 'game.html')
    assert.deepEqual(result.files.filter(f => !f.startsWith('content/')), ['assets/game.js', 'game.html', 'index.html', 'play.html', 'rf-build.json'])
    assert.ok(result.files.includes('content/index.json'))
    assert.ok(result.files.includes('content/assets/candy/candy.banner.asset.json'))
    assert.equal(readFileSync(join(out, 'upload', 'game.html'), 'utf8'), GAME)
    assert.equal(existsSync(join(out, 'upload', 'nmc.gpu.json')), false)
    assert.equal(existsSync(join(out, 'upload', 'store')), false)

    const toml = readFileSync(join(out, 'wavedash.toml'), 'utf8')
    assert.equal(toml, wavedashToml())
    assert.match(toml, /^upload_dir = "\.\/upload"$/m)
    assert.match(toml, /^entrypoint = "game\.html"$/m)
    assert.doesNotMatch(toml, /^game_id/m)

    const stampText = readFileSync(join(out, 'upload', 'rf-build.json'), 'utf8')
    const stamp = JSON.parse(stampText) as Record<string, unknown>
    assert.deepEqual(Object.keys(stamp), ['format', 'version', 'commit', 'builtAt', 'entry', 'raa', 'mama', 'defaultServer'])
    assert.equal(stamp.format, 'royal-fiesta.build')
    assert.equal(stamp.version, 1)
    assert.equal(stamp.entry, 'game.html')
    assert.ok(stamp.commit === null || /^[0-9a-f]{40}$/.test(String(stamp.commit)))
    assert.ok(['sibling', 'cloned', 'absent'].includes((stamp.mama as { source: string }).source))
    assert.equal(typeof stamp.defaultServer, 'boolean')
    assert.ok(stampText.endsWith('\n'))
    assert.deepEqual(leakScan(stampText + toml), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('rf-build.json records only that a default relay was set, never its URL', async () => {
  const dir = tree({ 'dist/game.html': GAME })
  const before = process.env.VITE_RF_SERVER
  const stampOf = () => readFileSync(join(dir, 'out', 'upload', 'rf-build.json'), 'utf8')
  try {
    process.env.VITE_RF_SERVER = 'wss://relay.example.invalid/ws'
    await withDist(join(dir, 'dist'), () => packWavedash({ outDir: join(dir, 'out') }))
    assert.equal((JSON.parse(stampOf()) as { defaultServer: unknown }).defaultServer, true)
    assert.doesNotMatch(stampOf(), /relay\.example|wss:/)
    delete process.env.VITE_RF_SERVER
    await withDist(join(dir, 'dist'), () => packWavedash({ outDir: join(dir, 'out') }))
    assert.equal((JSON.parse(stampOf()) as { defaultServer: unknown }).defaultServer, false)
  } finally {
    if (before === undefined) delete process.env.VITE_RF_SERVER
    else process.env.VITE_RF_SERVER = before
    rmSync(dir, { recursive: true, force: true })
  }
})

test('packing again replaces the previous upload', async () => {
  const dir = tree({ 'dist/game.html': GAME, 'out/upload/stale.js': 'old\n' })
  try {
    const result = await withDist(join(dir, 'dist'), () => packWavedash({ outDir: join(dir, 'out') }))
    assert.deepEqual(result.files.filter(f => !f.startsWith('content/')), ['game.html', 'rf-build.json'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a dist without game.html is refused', async () => {
  const dir = tree({ 'dist/index.html': '<pre></pre>\n' })
  try {
    await assert.rejects(withDist(join(dir, 'dist'), () => packWavedash({ outDir: join(dir, 'out') })), (e: unknown) =>
      e instanceof RefusalError && e.message.includes('game.html') && e.message.includes('the built game page is missing'))
    assert.equal(existsSync(join(dir, 'out')), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('etcitoBuild with a missing from path returns 1 with a [bricks] message, and does no network', async (t) => {
  const dir = tree({})
  const errors: string[] = []
  t.mock.method(console, 'error', (...args: unknown[]) => { errors.push(args.join(' ')) })
  t.mock.method(console, 'log', () => {})
  // With an empty PATH no git or npm can start, so nothing could reach the network.
  const path = process.env.PATH
  process.env.PATH = join(dir, 'empty-bin')
  try {
    const from = join(dir, 'missing-checkout')
    const out = join(dir, 'out')
    const code = await etcitoBuild({ from, out, record: join(dir, 'etcito-build.json') })
    assert.equal(code, 1)
    assert.equal(errors.length, 1)
    assert.match(errors[0], /^\[bricks\] \S*missing-checkout: not found; pass --from a git URL/)
    assert.equal(existsSync(out), false)
    assert.equal(existsSync(join(dir, 'etcito-build.json')), false)
  } finally {
    process.env.PATH = path
    rmSync(dir, { recursive: true, force: true })
  }
})

