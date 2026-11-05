import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { gunzipSync } from 'node:zlib'
import { leakScan } from '../guard.ts'
import { etcitoBuild } from '../etcitoBuild.ts'
import { checkUpload, hasStringLiteral, packWavedash, wavedashToml } from '../wavedash.ts'
import { RefusalError } from '../../packages/sim/src/refusal.ts'
import { decodeMesh, decodeMeshBytes } from '../../apps/web/src/sdf/meshWire.ts'

function tree(files: Record<string, string | Buffer>): string {
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

process.env.VITE_RF_AUDIO_URL = 'https://audio.example.invalid/sounds'
const EMPTY_AUDIO = '{}'

const GAME = '<!doctype html><script type="module" src="./assets/game.js"></script>\n'

// A Wavedash build plays online: every pack below has the placeholder relay in its environment and its built JS.
const RELAY = 'wss://relay.example.invalid/ws'
process.env.VITE_RF_SERVER = RELAY
const RELAY_JS = `const relay = ${JSON.stringify(RELAY)}\n`

// A small game content (RF_CONTENT_DIR): the real courses and asset files, a stand-in .mesh per asset (the real one for
// REAL_MESH, to decode it after the pack) and a build list that ticks the hub, the podium, the start scene and one
// survival level; two levels stay unticked, so the assets only they place are not packed.
const TICKED = ['hub-plaza', 'podium', 'start-season1', 'survival-spin-zone']
const UNTICKED = ['s1-i-honeycomb-heights', 'survival-sprint']
const ONLY_UNTICKED = ['candy.pendulum-hammer', 'candy.prompt-display', 'candy.spinner-bar']
const REAL_MESH = 'assets/common/costume.sparkler-wand.mesh'
const repo = new URL('../../', import.meta.url).pathname
const content = mkdtempSync(join(tmpdir(), 'rf-wavedash-content-'))
for (const id of [...TICKED, ...UNTICKED]) {
  mkdirSync(join(content, 'courses'), { recursive: true })
  copyFileSync(join(repo, 'courses', `${id}.course.json`), join(content, 'courses', `${id}.course.json`))
}
for (const world of readdirSync(join(repo, 'assets'))) {
  for (const file of readdirSync(join(repo, 'assets', world)).filter(f => f.endsWith('.asset.json'))) {
    mkdirSync(join(content, 'assets', world), { recursive: true })
    copyFileSync(join(repo, 'assets', world, file), join(content, 'assets', world, file))
    writeFileSync(join(content, 'assets', world, file.replace(/\.asset\.json$/, '.mesh')), `stand-in mesh ${file}`)
  }
}
copyFileSync(join(repo, REAL_MESH), join(content, REAL_MESH))
writeFileSync(join(content, 'sdfm.build.json'), JSON.stringify({ format: 'sdfm.build', version: 1, courses: TICKED }, null, 2) + '\n')
process.env.RF_CONTENT_DIR = content
process.env.RF_MESH_CACHE_DIR = join(content, 'empty-mesh-cache')
test.after(() => rmSync(content, { recursive: true, force: true }))

test('packWavedash writes the documented layout and manifest, entry game.html', async () => {
  const dir = tree({
    'dist/index.html': '<pre id="boot">booting</pre>\n',
    'dist/game.html': GAME, 'dist/assets/cdn.js': '"https://audio.example.invalid/sounds"',
    'dist/play.html': '<canvas></canvas>\n',
    'dist/assets/game.js': 'const audio = "https://audio.example.invalid/sounds"\n' + RELAY_JS,
    'dist/audio/manifest.json': EMPTY_AUDIO, 'dist/audio/old.mp3': 'cached',
    'dist/nmc.gpu.json': '{}\n',
    'dist/store/objects/aa/aa': '{}\n',
  })
  try {
    const out = join(dir, 'out')
    const result = await withDist(join(dir, 'dist'), () => packWavedash({ outDir: out }))
    assert.equal(result.entry, 'game.html')
    assert.deepEqual(result.files.filter(f => !f.startsWith('content/')),
      ['assets/cdn.js', 'assets/game.js', 'game.html', 'index.html', 'play.html', 'rf-build.json'])
    assert.ok(result.files.includes('content/index.json'))
    assert.ok(result.files.includes('content/assets/candy/candy.banner.asset.json'))
    assert.ok(result.files.includes('content/assets/candy/candy.banner.mesh'))
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
    assert.deepEqual(Object.keys(stamp),
      ['format', 'version', 'commit', 'builtAt', 'entry', 'raa', 'mama', 'defaultServer'])
    assert.doesNotMatch(stampText, /audio\.example|VITE_RF_AUDIO_URL/)
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

test('the relay URL is found however the minifier quotes it', () => {
  for (const q of ['"', "'", '`']) assert.equal(hasStringLiteral(`return ${q}${RELAY}${q}}`, RELAY), true)
  assert.equal(hasStringLiteral(`// ${RELAY}`, RELAY), false)
})

test('rf-build.json records only that a default relay was set, never its URL', async () => {
  const dir = tree({ 'dist/game.html': GAME, 'dist/assets/cdn.js': '"https://audio.example.invalid/sounds";' + RELAY_JS, 'dist/audio/manifest.json': EMPTY_AUDIO })
  const before = process.env.VITE_RF_SERVER
  const stampOf = () => readFileSync(join(dir, 'out', 'upload', 'rf-build.json'), 'utf8')
  try {
    process.env.VITE_RF_SERVER = RELAY
    await withDist(join(dir, 'dist'), () => packWavedash({ outDir: join(dir, 'out') }))
    assert.equal((JSON.parse(stampOf()) as { defaultServer: unknown }).defaultServer, true)
    assert.doesNotMatch(stampOf(), /relay\.example|wss:/)
    delete process.env.VITE_RF_SERVER
    await withDist(join(dir, 'dist'), () => packWavedash({ outDir: join(dir, 'out'), offline: true }))
    assert.equal((JSON.parse(stampOf()) as { defaultServer: unknown }).defaultServer, false)
  } finally {
    if (before === undefined) delete process.env.VITE_RF_SERVER
    else process.env.VITE_RF_SERVER = before
    rmSync(dir, { recursive: true, force: true })
  }
})

test('packing again replaces the previous upload', async () => {
  const dir = tree({ 'dist/game.html': GAME, 'dist/assets/cdn.js': '"https://audio.example.invalid/sounds";' + RELAY_JS, 'dist/audio/manifest.json': EMPTY_AUDIO, 'dist/audio/old.mp3': 'cached', 'out/upload/stale.js': 'old\n' })
  try {
    const result = await withDist(join(dir, 'dist'), () => packWavedash({ outDir: join(dir, 'out') }))
    assert.deepEqual(result.files.filter(f => !f.startsWith('content/')),
      ['assets/cdn.js', 'game.html', 'rf-build.json'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('without VITE_RF_AUDIO_URL the upload carries the audio manifest and only the MP3/Ogg it names', async () => {
  const manifest = JSON.stringify({ format: 'royal-fiesta.audio', version: 1, sounds: [{ files: ['a.0.mp3', 'a.1.ogg'] }] })
  const dir = tree({ 'dist/game.html': GAME, 'dist/assets/relay.js': RELAY_JS, 'dist/audio/manifest.json': manifest, 'dist/audio/a.0.mp3': 'm',
    'dist/audio/a.1.ogg': 'o', 'dist/audio/stale.mp3': 'old', 'dist/audio/a.0.wav': 'raw' })
  const before = process.env.VITE_RF_AUDIO_URL
  try {
    delete process.env.VITE_RF_AUDIO_URL
    const result = await withDist(join(dir, 'dist'), () => packWavedash({ outDir: join(dir, 'out') }))
    assert.deepEqual(result.files.filter(f => f.startsWith('audio/')), ['audio/a.0.mp3', 'audio/a.1.ogg', 'audio/manifest.json'])
    assert.equal(result.summary.audioBytes, 2 + manifest.length)
    writeFileSync(join(dir, 'dist/audio/manifest.json'), JSON.stringify({ sounds: [{ files: ['a.0.wav'] }] }))
    await assert.rejects(withDist(join(dir, 'dist'), () => packWavedash({ outDir: join(dir, 'out') })), /MP3\/Ogg/)
    writeFileSync(join(dir, 'dist/audio/manifest.json'), JSON.stringify({ sounds: [{ files: ['gone.mp3'] }] }))
    await assert.rejects(withDist(join(dir, 'dist'), () => packWavedash({ outDir: join(dir, 'out') })), /missing from the build/)
  } finally {
    process.env.VITE_RF_AUDIO_URL = before
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the upload ships only the ticked levels and the meshes their pages load, gzipped; checkUpload refuses any other mesh', async () => {
  const dir = tree({ 'dist/game.html': GAME, 'dist/assets/game.js': '"https://audio.example.invalid/sounds";' + RELAY_JS,
    'dist/content/assets/candy/candy.spinner-bar.mesh': 'an earlier local pack in dist' })
  try {
    const result = await withDist(join(dir, 'dist'), () => packWavedash({ outDir: join(dir, 'out') }))
    const upload = join(dir, 'out', 'upload')
    const index = JSON.parse(readFileSync(join(upload, 'content', 'index.json'), 'utf8')) as { assets: { id: string; mesh?: string }[]; courses: { id: string }[] }
    assert.deepEqual(index.courses.map(c => c.id), TICKED)
    assert.deepEqual(result.courses, TICKED)
    const shipped = index.assets.map(a => a.id)
    for (const id of ONLY_UNTICKED) {
      assert.ok(!shipped.includes(id), `${id} is placed only by unticked levels`)
      assert.ok(result.leftOut.includes(id))
    }
    assert.ok(shipped.includes('penguin.body') && shipped.includes('candy.sweeper-bar') && shipped.includes('costume.sparkler-wand'))
    const meshes = result.files.filter(f => /^content\/assets\/.+\.mesh$/.test(f))
    assert.deepEqual(meshes, index.assets.filter(a => a.mesh !== undefined).map(a => `content/${a.mesh}`).sort())
    assert.equal(result.summary.meshes.count, meshes.length)
    assert.ok(!result.files.some(f => f.startsWith('content/meshes/') && !f.endsWith('/')), 'every meshed asset has a saved mesh: no server mesh')
    // A packed saved mesh is gzipped under its name and decodes to the same asset as the source.
    const packed = readFileSync(join(upload, 'content', REAL_MESH))
    assert.deepEqual([packed[0], packed[1]], [0x1f, 0x8b])
    assert.deepEqual(gunzipSync(packed), readFileSync(join(content, REAL_MESH)))
    assert.deepEqual(await decodeMeshBytes(new Uint8Array(packed)), decodeMesh(new Uint8Array(readFileSync(join(content, REAL_MESH)))))
    assert.equal(result.summary.files, result.files.length)

    // A mesh no shipped page uses never passes the upload check, nor a server mesh while every asset has a saved one.
    mkdirSync(join(upload, 'content', 'assets', 'candy'), { recursive: true })
    writeFileSync(join(upload, 'content', 'assets', 'candy', 'candy.spinner-bar.mesh'), 'stale')
    await assert.rejects(checkUpload(upload), /no shipped page uses/)
    rmSync(join(upload, 'content', 'assets', 'candy', 'candy.spinner-bar.mesh'))
    mkdirSync(join(upload, 'content', 'meshes'), { recursive: true })
    writeFileSync(join(upload, 'content', 'meshes', 'a'.repeat(64)), 'old cache entry')
    await assert.rejects(checkUpload(upload), /server mesh/)
    rmSync(join(upload, 'content', 'meshes', 'a'.repeat(64)))
    rmSync(join(upload, 'content', REAL_MESH))
    await assert.rejects(checkUpload(upload), /named by content\/index\.json but missing/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a Wavedash pack needs the relay in its environment and its built JavaScript, unless --offline', async () => {
  const dir = tree({ 'dist/game.html': GAME, 'dist/assets/game.js': '"https://audio.example.invalid/sounds"\n' })
  const before = process.env.VITE_RF_SERVER
  try {
    delete process.env.VITE_RF_SERVER
    await assert.rejects(withDist(join(dir, 'dist'), () => packWavedash({ outDir: join(dir, 'out') })), (e: unknown) =>
      e instanceof RefusalError && e.message.includes('must play online') && e.message.includes('VITE_RF_SERVER=wss://<relay>/ws') && e.message.includes('--offline'))
    assert.equal(existsSync(join(dir, 'out')), false)
    process.env.VITE_RF_SERVER = 'https://not-a-socket.example.invalid'
    await assert.rejects(withDist(join(dir, 'dist'), () => packWavedash({ outDir: join(dir, 'out') })), /not a ws:\/\/ or wss:\/\/ URL/)
    process.env.VITE_RF_SERVER = RELAY
    await assert.rejects(withDist(join(dir, 'dist'), () => packWavedash({ outDir: join(dir, 'out') })), /absent from the built JavaScript/)
    delete process.env.VITE_RF_SERVER
    const offline = await withDist(join(dir, 'dist'), () => packWavedash({ outDir: join(dir, 'out'), offline: true }))
    assert.equal(offline.entry, 'game.html')
  } finally {
    if (before === undefined) delete process.env.VITE_RF_SERVER
    else process.env.VITE_RF_SERVER = before
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

