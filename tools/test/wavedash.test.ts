import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { leakScan } from '../guard.ts'
import { etcitoBuild } from '../etcitoBuild.ts'
import { packWavedash, wavedashToml } from '../wavedash.ts'
import { RefusalError } from '../../packages/sim/src/refusal.ts'

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

const GAME = '<!doctype html><script type="module" src="./assets/game.js"></script>\n'

/** An S17 audio manifest; the tests without real sounds use an empty one, so no ffmpeg runs. */
function audioManifest(sounds: readonly Record<string, unknown>[]): string {
  return `${JSON.stringify({ format: 'royal-fiesta.audio', version: 1, sampleRate: 48000, sounds }, null, 2)}\n`
}

const EMPTY_AUDIO = audioManifest([])

/** A 16-bit stereo 48 kHz WAV; the right channel defaults to the left one (dual mono). */
function wavBytes(left: readonly number[], right: readonly number[] = left, sampleRate = 48000): Buffer {
  const data = Buffer.alloc(left.length * 4)
  for (let frame = 0; frame < left.length; frame++) {
    data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(left[frame]))), frame * 4)
    data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(right[frame]))), frame * 4 + 2)
  }
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(2, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 4, 28)
  header.writeUInt16LE(4, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(data.length, 40)
  return Buffer.concat([header, data])
}

function tone(frames: number, hz = 440, amplitude = 0.2): number[] {
  return Array.from({ length: frames }, (_, frame) =>
    Math.round(Math.sin(2 * Math.PI * hz * frame / 48000) * amplitude * 32767))
}

test('packWavedash writes the documented layout and manifest, entry game.html', async () => {
  const dir = tree({
    'dist/index.html': '<pre id="boot">booting</pre>\n',
    'dist/game.html': GAME,
    'dist/play.html': '<canvas></canvas>\n',
    'dist/assets/game.js': 'export {}\n',
    'dist/audio/manifest.json': EMPTY_AUDIO,
    'dist/nmc.gpu.json': '{}\n',
    'dist/store/objects/aa/aa': '{}\n',
  })
  try {
    const out = join(dir, 'out')
    const result = await withDist(join(dir, 'dist'), () => packWavedash({ outDir: out }))
    assert.equal(result.entry, 'game.html')
    assert.deepEqual(result.files.filter(f => !f.startsWith('content/')),
      ['assets/game.js', 'audio/manifest.json', 'game.html', 'index.html', 'play.html', 'rf-build.json'])
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
    assert.deepEqual(Object.keys(stamp),
      ['format', 'version', 'commit', 'builtAt', 'entry', 'raa', 'mama', 'defaultServer', 'audio'])
    assert.deepEqual(stamp.audio, { encoded: 0, cached: 0, mono: 0, stereo: 0 })
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
  const dir = tree({ 'dist/game.html': GAME, 'dist/audio/manifest.json': EMPTY_AUDIO })
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
  const dir = tree({ 'dist/game.html': GAME, 'dist/audio/manifest.json': EMPTY_AUDIO, 'out/upload/stale.js': 'old\n' })
  try {
    const result = await withDist(join(dir, 'dist'), () => packWavedash({ outDir: join(dir, 'out') }))
    assert.deepEqual(result.files.filter(f => !f.startsWith('content/')),
      ['audio/manifest.json', 'game.html', 'rf-build.json'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a dist without baked audio is refused, naming npm run audio:bake', async () => {
  const dir = tree({ 'dist/game.html': GAME })
  try {
    await assert.rejects(withDist(join(dir, 'dist'), () => packWavedash({ outDir: join(dir, 'out') })), (e: unknown) =>
      e instanceof RefusalError && e.message.includes('audio') && e.message.includes('manifest.json') &&
      e.message.includes('npm run audio:bake'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' }).status === 0

test('the upload ships compressed audio and a second pack reports cached files', {
  skip: hasFfmpeg ? false : 'ffmpeg is not on PATH',
}, async () => {
  const audio = audioManifest([
    { id: 'ui.click', bus: 'ui', mode: 'oneshot', files: ['ui.click.0.wav'], patch: null },
    { id: 'music.candy.lobby', bus: 'music', mode: 'loop', files: ['music.candy.lobby.0.wav'], patch: null },
  ])
  const dir = tree({
    'dist/game.html': GAME,
    'dist/audio/manifest.json': audio,
    'dist/audio/ui.click.0.wav': wavBytes(tone(480)),
    'dist/audio/music.candy.lobby.0.wav': wavBytes(tone(480)),
  })
  const cache = join(dir, 'cache')
  const before = process.env.RF_AUDIO_CACHE_DIR
  process.env.RF_AUDIO_CACHE_DIR = cache
  try {
    const first = await withDist(join(dir, 'dist'), () => packWavedash({ outDir: join(dir, 'out') }))
    assert.deepEqual(first.audio, { encoded: 2, cached: 0, mono: 1, stereo: 1 })
    const audioDir = join(dir, 'out', 'upload', 'audio')
    assert.deepEqual(readdirSync(audioDir).filter((name) => name.endsWith('.wav')), [])
    const manifest = JSON.parse(readFileSync(join(audioDir, 'manifest.json'), 'utf8')) as {
      sounds: { id: string; files: string[] }[]
    }
    assert.deepEqual(manifest.sounds.map((sound) => sound.id), ['ui.click', 'music.candy.lobby'])
    const files = manifest.sounds.flatMap((sound) => sound.files)
    assert.equal(files.length, 2)
    for (const file of files) {
      assert.match(file, /\.(mp3|ogg)$/)
      assert.equal(existsSync(join(audioDir, file)), true, file)
    }
    const stamp = JSON.parse(readFileSync(join(dir, 'out', 'upload', 'rf-build.json'), 'utf8')) as {
      audio: unknown
    }
    assert.deepEqual(stamp.audio, first.audio)

    const second = await withDist(join(dir, 'dist'), () => packWavedash({ outDir: join(dir, 'out') }))
    assert.deepEqual(second.audio, { encoded: 0, cached: 2, mono: 1, stereo: 1 })
  } finally {
    if (before === undefined) delete process.env.RF_AUDIO_CACHE_DIR
    else process.env.RF_AUDIO_CACHE_DIR = before
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

