import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'
import type { Arrangement } from '@etcito/haa-spatial/arranger'
import { renderArrangement, validateArrangement } from '@etcito/haa-spatial/arranger'
import { analyse, renderBank } from '@etcito/haa-spatial/bank'
import { loadModule } from '@etcito/haa-spatial/node'
import { MUSIC_CUES, SOUNDS, WORLDS_AUDIO } from '../src/audio/catalog.ts'
import { BED_FAMILIES, MUSIC_CUE_IDS, loadArrangement } from '../src/audio/sounds/music.ts'

const ROOT = new URL('../../../', import.meta.url)
const readText = (path: string): string => readFileSync(new URL(path, ROOT), 'utf8')
const module = await loadModule()

const music = SOUNDS.filter(sound => sound.group === 'music' && sound.id.startsWith('music.'))
const beds = SOUNDS.filter(sound => sound.group === 'music' && (sound.bus === 'ambience' || sound.bus === 'crowd'))

test('MUSIC_CUE_IDS equals the catalog music ids', () => {
  assert.equal(music.length, 32)
  assert.deepEqual(MUSIC_CUE_IDS, music.map(sound => sound.id))
  assert.deepEqual(
    [...MUSIC_CUE_IDS].sort(),
    WORLDS_AUDIO.flatMap(world => MUSIC_CUES.map(cue => `music.${world}.${cue}`)).sort(),
  )
})

test('every cue loads through the caller reader, loops as its catalog mode and validates', () => {
  for (const id of MUSIC_CUE_IDS) {
    const sound = music.find(entry => entry.id === id)
    assert.ok(sound, id)
    const { arrangement, instruments } = loadArrangement(id, readText)
    assert.equal(arrangement.id, id)
    assert.equal(arrangement.loop, sound.mode === 'loop', id)
    const cue = id.split('.').pop()!
    if (cue === 'results' || cue === 'podium') assert.equal(arrangement.loop, false, id)
    assert.deepEqual(validateArrangement(arrangement, instruments), [], id)
  }
})

test('every instrument path referenced by an arrangement exists', () => {
  const paths = new Set<string>()
  for (const id of MUSIC_CUE_IDS) {
    const arrangement = JSON.parse(readText(`audio/${id}.arr.json`)) as Arrangement
    for (const instrument of arrangement.instruments) paths.add(instrument.patch)
  }
  assert.ok(paths.size > 0)
  for (const path of paths) assert.ok(existsSync(new URL(path, ROOT)), path)
})

test('every cue renders once, finite, audible and unclipped', () => {
  for (const id of MUSIC_CUE_IDS) {
    const { arrangement, instruments } = loadArrangement(id, readText)
    const stats = analyse(renderArrangement(module, arrangement, instruments))
    const label = `${id}: peak ${stats.peakDbfs.toFixed(1)} dBFS, rms ${stats.rmsDbfs.toFixed(1)} dBFS`
    assert.equal(stats.nonFinite, 0, label)
    assert.equal(stats.silent, false, label)
    assert.equal(stats.clipped, false, label)
  }
})

test('BED_FAMILIES covers the ambience beds and the crowd bed', () => {
  assert.deepEqual(BED_FAMILIES.map(family => family.id), beds.map(sound => sound.id))
})

test('every bed renders functional audio through renderBank', () => {
  for (const family of BED_FAMILIES) {
    const renders = renderBank(module, readText(`audio/${family.id}.haa.json`), family.entries)
    assert.equal(renders.length, family.entries.length, family.id)
    for (const [index, result] of renders.entries()) {
      const label = `${family.id} entry ${index}: ${JSON.stringify(family.entries[index])}`
      const stats = analyse(result.render)
      assert.equal(stats.nonFinite, 0, label)
      assert.equal(stats.silent, false, label)
      assert.equal(stats.clipped, false, label)
    }
  }
})

test('the crowd bed publishes excitement', () => {
  const patch = JSON.parse(readText('audio/crowd.haa.json')) as { inputs?: { name: string }[] }
  assert.ok(patch.inputs?.some(input => input.name === 'excitement'))
})
