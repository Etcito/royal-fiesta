import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { StereoRender } from '@etcito/haa-spatial/node'
import { SOUNDS } from '../../packages/game/src/audio/catalog.ts'
import { MUSIC_CUE_IDS } from '../../packages/game/src/audio/sounds/music.ts'
import { bakeAudio, checkRender, seamlessLoop } from '../bake-audio.ts'
import type { AudioManifest } from '../bake-audio.ts'

const out = mkdtempSync(join(tmpdir(), 'rf-audio-bake-'))
const cache = mkdtempSync(join(tmpdir(), 'rf-audio-cache-'))
const manifest: AudioManifest = await bakeAudio(out, () => {}, cache)
test.after(() => {
  rmSync(out, { recursive: true, force: true })
  rmSync(cache, { recursive: true, force: true })
})

test('a second bake with unchanged inputs renders nothing and copies the same bytes from the cache', async () => {
  const again = mkdtempSync(join(tmpdir(), 'rf-audio-bake-'))
  try {
    const lines: string[] = []
    const second = await bakeAudio(again, (line) => lines.push(line), cache)
    assert.deepEqual(second, manifest)
    assert.match(lines.join('\n'), new RegExp(`\\(0 rendered, ${manifest.sounds.reduce((n, s) => n + s.files.length, 0)} from `))
    for (const sound of manifest.sounds) {
      for (const file of sound.files) assert.ok(readFileSync(join(again, file)).equals(readFileSync(join(out, file))), file)
    }
  } finally {
    rmSync(again, { recursive: true, force: true })
  }
})

/** Checks the RIFF/FMT header encodeWav writes: PCM, stereo, 48 kHz, 16-bit, and returns the byte size. */
function wavBytes(path: string): number {
  const bytes = readFileSync(path)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  assert.equal(bytes.toString('ascii', 0, 4), 'RIFF', path)
  assert.equal(bytes.toString('ascii', 8, 12), 'WAVE', path)
  assert.equal(bytes.toString('ascii', 12, 16), 'fmt ', path)
  assert.equal(view.getUint16(20, true), 1, `${path} is PCM`)
  assert.equal(view.getUint16(22, true), 2, `${path} is stereo`)
  assert.equal(view.getUint32(24, true), 48000, `${path} is 48 kHz`)
  assert.equal(view.getUint16(34, true), 16, `${path} is 16-bit`)
  assert.equal(bytes.toString('ascii', 36, 40), 'data', path)
  assert.equal(view.getUint32(40, true), bytes.byteLength - 44, `${path} data chunk size`)
  return bytes.byteLength
}

test('the manifest has 98 sounds with the catalog bus and mode', () => {
  assert.equal(manifest.format, 'royal-fiesta.audio')
  assert.equal(manifest.version, 1)
  assert.equal(manifest.sampleRate, 48000)
  assert.equal(manifest.sounds.length, 98)
  assert.deepEqual(manifest.sounds.map((sound) => sound.id), SOUNDS.map((sound) => sound.id))
  for (const sound of SOUNDS) {
    const entry = manifest.sounds.find((candidate) => candidate.id === sound.id)
    assert.ok(entry, sound.id)
    assert.equal(entry.bus, sound.bus, sound.id)
    assert.equal(entry.mode, sound.mode, sound.id)
  }
})

test('every one-shot bakes exactly its variant files as 48 kHz stereo WAVs', () => {
  for (const sound of SOUNDS.filter((candidate) => candidate.mode === 'oneshot')) {
    const entry = manifest.sounds.find((candidate) => candidate.id === sound.id)
    assert.ok(entry, sound.id)
    const files = Array.from({ length: sound.variants }, (_, variant) => `${sound.id}.${variant}.wav`)
    assert.deepEqual(entry.files, files, sound.id)
    for (const file of entry.files) assert.ok(wavBytes(join(out, file)) > 44, file)
  }
})

test('music cues bake their single arrangement render, whatever their mode', () => {
  for (const id of MUSIC_CUE_IDS) {
    const entry = manifest.sounds.find((candidate) => candidate.id === id)
    assert.ok(entry, id)
    assert.equal(entry.patch, null, id)
    assert.deepEqual(entry.files, [`${id}.0.wav`], id)
    assert.ok(wavBytes(join(out, `${id}.0.wav`)) > 44, id)
  }
})

test('all patch loops bake media and explicit loop points, without browser HAA assets', () => {
  const loops = SOUNDS.filter(sound => sound.mode === 'loop' && !MUSIC_CUE_IDS.includes(sound.id))
  assert.equal(loops.length, 11)
  for (const sound of loops) {
    const entry = manifest.sounds.find(candidate => candidate.id === sound.id)!
    assert.equal(entry.patch, null)
    assert.ok(entry.files.length > 0)
    assert.equal(entry.loopStart, 0)
    assert.ok(entry.loopEnd! >= 16)
    for (const file of entry.files) assert.ok(wavBytes(join(out, file)) > 44)
    assert.equal(existsSync(join(out, `${sound.id}.haa.json`)), false)
  }
  assert.equal(existsSync(join(out, 'haa-processors.js')), false)
  assert.equal(existsSync(join(out, 'haa.wasm')), false)
})

test('seamless splice follows the continuous render across the wrap, in both channels', () => {
  const rate = 100
  const source = Float32Array.from({ length: 610 }, (_, i) => Math.sin(i * 0.17))
  const render = seamlessLoop({ left: source, right: source.map(v => -v), sampleRate: rate, issues: [] }, 4)
  assert.equal(render.left.length, 400)
  assert.equal(render.left[0], source[600])
  assert.equal(render.left.at(-1), source[599])
  assert.equal(render.left[10], source[210])
  assert.equal(render.right[0], -source[600])
})

test('the exported check refuses NaN, silent and clipped renders with the id', () => {
  const render = (left: number[], right: number[] = left): StereoRender => ({
    left: Float32Array.from(left), right: Float32Array.from(right), sampleRate: 48000, issues: [],
  })
  assert.throws(() => checkRender('bad.nan', render([NaN, 0.5])), /bad\.nan/)
  assert.throws(() => checkRender('bad.silent', render(new Array<number>(480).fill(0))), /bad\.silent/)
  assert.throws(() => checkRender('bad.clipped', render(new Array<number>(480).fill(1.5))), /bad\.clipped/)
  checkRender('good.quiet', render(new Array<number>(480).fill(0.02)))
})
