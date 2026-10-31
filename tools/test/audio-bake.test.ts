import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { StereoRender } from '@etcito/haa-spatial/node'
import { SOUNDS } from '../../packages/game/src/audio/catalog.ts'
import { MUSIC_CUE_IDS } from '../../packages/game/src/audio/sounds/music.ts'
import { bakeAudio, checkRender } from '../bake-audio.ts'
import type { AudioManifest } from '../bake-audio.ts'

const out = mkdtempSync(join(tmpdir(), 'rf-audio-bake-'))
const manifest: AudioManifest = await bakeAudio(out, () => {})
test.after(() => rmSync(out, { recursive: true, force: true }))

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

test('patch loops list their patch and no files, and the patch is copied next to the manifest', () => {
  const loops = SOUNDS.filter((sound) => sound.mode === 'loop' && !MUSIC_CUE_IDS.includes(sound.id))
  assert.ok(loops.length > 0)
  for (const sound of loops) {
    const entry = manifest.sounds.find((candidate) => candidate.id === sound.id)
    assert.ok(entry, sound.id)
    assert.deepEqual(entry.files, [], sound.id)
    assert.equal(entry.patch, `audio/${sound.id}.haa.json`, sound.id)
    assert.ok(existsSync(join(out, `${sound.id}.haa.json`)), sound.id)
  }
})

test('the HAA worklet and wasm are copied next to the manifest', () => {
  assert.ok(existsSync(join(out, 'haa-processors.js')))
  assert.ok(existsSync(join(out, 'haa.wasm')))
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
