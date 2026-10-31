// Bakes the Royal Fiesta sound set with HAA 0.2.0: every catalog one-shot renders its bake-set
// variants through renderBank, every music cue renders its arrangement, and every patch loop is
// copied next to an S17 manifest.json that the browser loads. HAA's prebuilt worklet and wasm
// are copied as haa-processors.js and haa.wasm. Output: apps/web/public/audio (gitignored).
// Run by `npm run audio:bake` (and by web:build).
//   node --experimental-strip-types tools/bake-audio.ts [--out <dir>]
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { renderArrangement } from '@etcito/haa-spatial/arranger'
import { analyse, renderBank } from '@etcito/haa-spatial/bank'
import type { BankEntry } from '@etcito/haa-spatial/bank'
import { encodeWav, loadModule } from '@etcito/haa-spatial/node'
import type { StereoRender } from '@etcito/haa-spatial/node'
import { SOUNDS } from '../packages/game/src/audio/catalog.ts'
import type { Bus, SoundDef } from '../packages/game/src/audio/catalog.ts'
import { FLOW_FAMILIES } from '../packages/game/src/audio/sounds/flow.ts'
import { MOVEMENT_FAMILIES } from '../packages/game/src/audio/sounds/movement.ts'
import type { FamilyRender } from '../packages/game/src/audio/sounds/movement.ts'
import { BED_FAMILIES, loadArrangement, MUSIC_CUE_IDS } from '../packages/game/src/audio/sounds/music.ts'
import { WORLD_FAMILIES } from '../packages/game/src/audio/sounds/world.ts'
import { repoRoot } from './bricks.ts'

export const DEFAULT_AUDIO_OUT = 'apps/web/public/audio'

/** One manifest row (S17): a sound, its bus/mode, its baked files and its live-loop patch. */
export interface AudioManifestSound {
  id: string
  bus: Bus
  mode: SoundDef['mode']
  files: string[]
  patch: string | null
}

/** The S17 audio manifest written to `<out>/manifest.json`. */
export interface AudioManifest {
  format: 'royal-fiesta.audio'
  version: 1
  sampleRate: 48000
  sounds: AudioManifestSound[]
}

/** Refuses a render that analyse marks non-finite, silent or clipped; the message names the id. */
export function checkRender(id: string, render: StereoRender): void {
  const stats = analyse(render)
  if (stats.nonFinite > 0) throw new Error(`[audio-bake] ${id}: ${stats.nonFinite} non-finite samples`)
  if (stats.silent) throw new Error(`[audio-bake] ${id}: silent (peak ${stats.peakDbfs.toFixed(1)} dBFS)`)
  if (stats.clipped) throw new Error(`[audio-bake] ${id}: clipped (peak ${stats.peakDbfs.toFixed(1)} dBFS)`)
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Bakes every catalog sound into outDir and returns the S17 manifest. Deterministic. */
export async function bakeAudio(
  outDir: string, log: (line: string) => void = console.log,
): Promise<AudioManifest> {
  const root = repoRoot()
  mkdirSync(outDir, { recursive: true })
  const module = await loadModule()

  const families = new Map<string, FamilyRender>()
  for (const family of [...MOVEMENT_FAMILIES, ...WORLD_FAMILIES, ...FLOW_FAMILIES, ...BED_FAMILIES]) {
    families.set(family.id, family)
  }
  const source = (id: string, path: string): string => {
    try {
      return readFileSync(join(root, path), 'utf8')
    } catch {
      throw new Error(`[audio-bake] ${id}: missing source file ${path}`)
    }
  }
  const familyOf = (id: string): FamilyRender => {
    const family = families.get(id)
    if (!family) throw new Error(`[audio-bake] ${id}: missing family`)
    return family
  }
  const bakeSet = (sound: SoundDef): BankEntry[] => {
    const family = familyOf(sound.id)
    const entries: BankEntry[] = []
    for (let variant = 0; variant < sound.variants; variant++) {
      const entry = family.entries.find((candidate) => candidate.variant === variant)
      if (!entry) throw new Error(`[audio-bake] ${sound.id}: missing family entry for variant ${variant}`)
      entries.push(entry)
    }
    return entries
  }

  const sounds: AudioManifestSound[] = []
  let wavs = 0
  for (const sound of SOUNDS) {
    if (MUSIC_CUE_IDS.includes(sound.id)) {
      let loaded
      try {
        loaded = loadArrangement(sound.id, (path) => source(sound.id, path))
      } catch (error) {
        throw new Error(`[audio-bake] ${sound.id}: ${message(error)}`)
      }
      let render: StereoRender
      try {
        render = renderArrangement(module, loaded.arrangement, loaded.instruments)
      } catch (error) {
        throw new Error(`[audio-bake] ${sound.id}: ${message(error)}`)
      }
      checkRender(sound.id, render)
      const file = `${sound.id}.0.wav`
      writeFileSync(join(outDir, file), encodeWav(render))
      wavs++
      sounds.push({ id: sound.id, bus: sound.bus, mode: sound.mode, files: [file], patch: null })
      continue
    }

    familyOf(sound.id)
    if (sound.mode === 'loop') {
      const patch = `audio/${sound.id}.haa.json`
      if (!existsSync(join(root, patch))) throw new Error(`[audio-bake] ${sound.id}: missing source file ${patch}`)
      copyFileSync(join(root, patch), join(outDir, `${sound.id}.haa.json`))
      sounds.push({ id: sound.id, bus: sound.bus, mode: sound.mode, files: [], patch })
      continue
    }

    const entries = bakeSet(sound)
    let renders
    try {
      renders = renderBank(module, source(sound.id, sound.source), entries)
    } catch (error) {
      throw new Error(`[audio-bake] ${sound.id}: ${message(error)}`)
    }
    const files: string[] = []
    for (const [index, result] of renders.entries()) {
      const id = `${sound.id}.${entries[index].variant}`
      checkRender(id, result.render)
      const file = `${id}.wav`
      writeFileSync(join(outDir, file), encodeWav(result.render))
      files.push(file)
      wavs++
    }
    sounds.push({ id: sound.id, bus: sound.bus, mode: sound.mode, files, patch: null })
  }

  const manifest: AudioManifest = { format: 'royal-fiesta.audio', version: 1, sampleRate: 48000, sounds }
  writeFileSync(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  const require = createRequire(join(root, 'package.json'))
  copyFileSync(require.resolve('@etcito/haa-spatial/worklet'), join(outDir, 'haa-processors.js'))
  copyFileSync(require.resolve('@etcito/haa-spatial/wasm'), join(outDir, 'haa.wasm'))
  const patches = sounds.filter((sound) => sound.patch !== null).length
  log(`[audio-bake] ${sounds.length} sounds: ${wavs} WAVs, ${patches} live patches, manifest, worklet and wasm -> ${outDir}`)
  return manifest
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (import.meta.url === entry) {
  const flag = process.argv.indexOf('--out')
  const out = flag >= 0 && process.argv[flag + 1] ? resolve(process.argv[flag + 1]) : join(repoRoot(), DEFAULT_AUDIO_OUT)
  const started = Date.now()
  const manifest = await bakeAudio(out)
  const files = manifest.sounds.reduce((count, sound) => count + sound.files.length, 0) +
    manifest.sounds.filter((sound) => sound.patch !== null).length + 3
  console.log(`baked ${manifest.sounds.length} sounds (${files} files) into ${out} in ${((Date.now() - started) / 1000).toFixed(1)} s`)
}
