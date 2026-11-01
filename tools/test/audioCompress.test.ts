import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { compressAudio } from '../audioCompress.ts'
import type { AudioEncoder, EncodeRequest } from '../audioCompress.ts'
import type { AudioManifest, BakeFileKey } from '../bake-audio.ts'

const cache = mkdtempSync(join(tmpdir(), 'rf-audio-compress-cache-'))
process.env.RF_AUDIO_CACHE_DIR = cache
const temps: string[] = []

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  temps.push(dir)
  return dir
}

test.after(() => {
  rmSync(cache, { recursive: true, force: true })
  for (const dir of temps) rmSync(dir, { recursive: true, force: true })
})

/** A 16-bit stereo 48 kHz WAV; the right channel defaults to the left one (dual mono). */
function wavBytes(left: readonly number[], right: readonly number[] = left, sampleRate = 48000): Buffer {
  const frames = left.length
  const data = Buffer.alloc(frames * 4)
  for (let frame = 0; frame < frames; frame++) {
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

interface FixtureSound {
  id: string
  bus: 'music' | 'sfx' | 'ui' | 'ambience' | 'crowd'
  mode: 'oneshot' | 'loop'
  files: string[]
  key: string
  music: boolean
}

function fixture(wavs: Record<string, Buffer>, sounds: FixtureSound[]): { dir: string; keys: Map<string, BakeFileKey> } {
  const dir = tempDir('rf-audio-compress-')
  for (const [name, bytes] of Object.entries(wavs)) writeFileSync(join(dir, name), bytes)
  const manifest: AudioManifest = {
    format: 'royal-fiesta.audio',
    version: 1,
    sampleRate: 48000,
    sounds: sounds.map((sound) => ({
      id: sound.id, bus: sound.bus, mode: sound.mode, files: sound.files, patch: null,
    })),
  }
  writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  const keys = new Map<string, BakeFileKey>()
  for (const sound of sounds) {
    for (const file of sound.files) keys.set(file, { key: sound.key, music: sound.music })
  }
  return { dir, keys }
}

function readManifest(dir: string): AudioManifest {
  return JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as AudioManifest
}

function stubEncoder(mp3: number, opus: number): { encode: AudioEncoder; calls: EncodeRequest[] } {
  const calls: EncodeRequest[] = []
  const encode: AudioEncoder = (request) => {
    calls.push(request)
    writeFileSync(request.output, Buffer.alloc(request.codec === 'mp3' ? mp3 : opus, 7))
  }
  return { encode, calls }
}

test('a dual-mono SFX is encoded mono in both candidate formats', async () => {
  const { dir, keys } = fixture(
    { 'move.jump.0.wav': wavBytes(tone(480)) },
    [{ id: 'move.jump', bus: 'sfx', mode: 'oneshot', files: ['move.jump.0.wav'], key: 'k-dual-mono', music: false }],
  )
  const { encode, calls } = stubEncoder(400, 300)
  const result = await compressAudio(dir, { encode, keys: () => keys, log: () => {} })
  assert.equal(result.encoded, 1)
  assert.equal(result.cached, 0)
  assert.equal(result.mono, 1)
  assert.equal(result.stereo, 0)
  assert.deepEqual(result.stereoIds, [])
  assert.equal(result.files[0].channels, 1)
  assert.ok(calls.length === 2 && calls.every((call) => call.channels === 1))
})

test('a music cue stays stereo even when its channels are identical', async () => {
  const { dir, keys } = fixture(
    { 'music.candy.lobby.0.wav': wavBytes(tone(480)) },
    [{ id: 'music.candy.lobby', bus: 'music', mode: 'loop', files: ['music.candy.lobby.0.wav'], key: 'k-music-lobby', music: true }],
  )
  const { encode, calls } = stubEncoder(400, 300)
  const result = await compressAudio(dir, { encode, keys: () => keys, log: () => {} })
  assert.equal(result.files[0].channels, 2)
  assert.equal(result.stereo, 1)
  assert.equal(result.mono, 0)
  assert.deepEqual(result.stereoIds, [])
  assert.ok(calls.length === 2 && calls.every((call) => call.channels === 2))
})

test('a stereo SFX stays stereo and is reported by id', async () => {
  const left = tone(480)
  const right = left.map((sample) => -sample)
  const { dir, keys } = fixture(
    { 'move.land.hard.0.wav': wavBytes(left, right) },
    [{ id: 'move.land.hard', bus: 'sfx', mode: 'oneshot', files: ['move.land.hard.0.wav'], key: 'k-stereo-land', music: false }],
  )
  const { encode, calls } = stubEncoder(400, 300)
  const result = await compressAudio(dir, { encode, keys: () => keys, log: () => {} })
  assert.equal(result.files[0].channels, 2)
  assert.equal(result.stereo, 1)
  assert.deepEqual(result.stereoIds, ['move.land.hard'])
  assert.ok(calls.length === 2 && calls.every((call) => call.channels === 2))
})

test('the smaller of the two encodes is kept', async () => {
  const { dir, keys } = fixture(
    { 'ui.click.0.wav': wavBytes(tone(480)) },
    [{ id: 'ui.click', bus: 'ui', mode: 'oneshot', files: ['ui.click.0.wav'], key: 'k-smaller', music: false }],
  )
  const { encode } = stubEncoder(500, 200)
  const result = await compressAudio(dir, { encode, keys: () => keys, log: () => {} })
  assert.equal(result.files[0].codec, 'opus')
  assert.equal(result.files[0].file, 'ui.click.0.ogg')
  assert.equal(readFileSync(join(dir, 'ui.click.0.ogg')).length, 200)
  assert.equal(existsSync(join(dir, 'ui.click.0.mp3')), false)
})

test('the manifest is rewritten with the new file names and the WAVs are removed', async () => {
  const { dir, keys } = fixture(
    { 'obj.goal.0.wav': wavBytes(tone(480)) },
    [{ id: 'obj.goal', bus: 'sfx', mode: 'oneshot', files: ['obj.goal.0.wav'], key: 'k-manifest', music: false }],
  )
  const { encode } = stubEncoder(500, 200)
  await compressAudio(dir, { encode, keys: () => keys, log: () => {} })
  const manifest = readManifest(dir)
  const sound = manifest.sounds[0]
  assert.equal(manifest.format, 'royal-fiesta.audio')
  assert.equal(manifest.version, 1)
  assert.equal(manifest.sampleRate, 48000)
  assert.equal(sound.id, 'obj.goal')
  assert.equal(sound.bus, 'sfx')
  assert.equal(sound.mode, 'oneshot')
  assert.equal(sound.patch, null)
  assert.deepEqual(sound.files, ['obj.goal.0.ogg'])
  assert.equal(existsSync(join(dir, 'obj.goal.0.wav')), false)
  assert.equal(existsSync(join(dir, 'obj.goal.0.ogg')), true)
})

test('a second run with the same keys copies the cache and calls the encoder zero times', async () => {
  const sound = (dir: string, keys: Map<string, BakeFileKey>) => ({ dir, keys })
  const first = fixture(
    { 'mech.door.0.wav': wavBytes(tone(480)) },
    [{ id: 'mech.door', bus: 'sfx', mode: 'oneshot', files: ['mech.door.0.wav'], key: 'k-second-run', music: false }],
  )
  const firstEncoder = stubEncoder(500, 250)
  const firstResult = await compressAudio(first.dir, {
    encode: firstEncoder.encode, keys: () => first.keys, log: () => {},
  })
  assert.equal(firstResult.encoded, 1)

  const second = fixture(
    { 'mech.door.0.wav': wavBytes(tone(480)) },
    [{ id: 'mech.door', bus: 'sfx', mode: 'oneshot', files: ['mech.door.0.wav'], key: 'k-second-run', music: false }],
  )
  const secondEncoder = stubEncoder(500, 250)
  const secondResult = await compressAudio(sound(second.dir, second.keys).dir, {
    encode: secondEncoder.encode, keys: () => second.keys, log: () => {},
  })
  assert.equal(secondEncoder.calls.length, 0)
  assert.equal(secondResult.encoded, 0)
  assert.equal(secondResult.cached, 1)
  assert.equal(secondResult.files[0].cached, true)
  assert.equal(secondResult.files[0].file, firstResult.files[0].file)
  assert.ok(readFileSync(join(second.dir, secondResult.files[0].file))
    .equals(readFileSync(join(first.dir, firstResult.files[0].file))))
})

test('a changed key re-encodes only that sound', async () => {
  const sounds = (bKey: string): FixtureSound[] => [
    { id: 'move.jump', bus: 'sfx', mode: 'oneshot', files: ['move.jump.0.wav'], key: 'k-unchanged', music: false },
    { id: 'move.dive', bus: 'sfx', mode: 'oneshot', files: ['move.dive.0.wav'], key: bKey, music: false },
  ]
  const wavs = { 'move.jump.0.wav': wavBytes(tone(240)), 'move.dive.0.wav': wavBytes(tone(240)) }
  const first = fixture(wavs, sounds('k-changed-before'))
  const firstEncoder = stubEncoder(500, 250)
  const firstResult = await compressAudio(first.dir, {
    encode: firstEncoder.encode, keys: () => first.keys, log: () => {},
  })
  assert.equal(firstResult.encoded, 2)

  const second = fixture(wavs, sounds('k-changed-after'))
  const secondEncoder = stubEncoder(500, 250)
  const secondResult = await compressAudio(second.dir, {
    encode: secondEncoder.encode, keys: () => second.keys, log: () => {},
  })
  assert.equal(secondResult.cached, 1)
  assert.equal(secondResult.encoded, 1)
  assert.ok(secondEncoder.calls.length === 2)
  assert.ok(secondEncoder.calls.every((call) => call.input.endsWith('move.dive.0.wav')))
  assert.equal(secondResult.files.find((file) => file.id === 'move.jump')!.cached, true)
  assert.equal(secondResult.files.find((file) => file.id === 'move.dive')!.cached, false)
})

const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' }).status === 0
const hasFfprobe = spawnSync('ffprobe', ['-version'], { encoding: 'utf8' }).status === 0
const missing = !hasFfmpeg ? 'ffmpeg is not on PATH' : !hasFfprobe ? 'ffprobe is not on PATH' : false

test('real ffmpeg encodes a short WAV both ways and the kept mono file decodes', { skip: missing }, async () => {
  const { dir, keys } = fixture(
    { 'move.step.candy.0.wav': wavBytes(tone(12000)) },
    [{ id: 'move.step.candy', bus: 'sfx', mode: 'oneshot', files: ['move.step.candy.0.wav'], key: 'k-real-ffmpeg', music: false }],
  )
  const result = await compressAudio(dir, { keys: () => keys, log: () => {} })
  assert.equal(result.encoded, 1)
  assert.equal(result.files[0].channels, 1)
  const kept = join(dir, result.files[0].file)
  assert.ok(existsSync(kept), kept)
  const probe = spawnSync('ffprobe', [
    '-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=channels,codec_name', '-of', 'json', kept,
  ], { encoding: 'utf8' })
  assert.equal(probe.status, 0, probe.stderr)
  const streams = (JSON.parse(probe.stdout) as { streams: { channels: number; codec_name: string }[] }).streams
  assert.equal(streams[0].channels, 1)
  assert.ok(streams[0].codec_name === 'mp3' || streams[0].codec_name === 'opus', streams[0].codec_name)
})
