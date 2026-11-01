// Bakes the Royal Fiesta sound set with HAA 0.2.0: every catalog one-shot renders its bake-set
// variants through renderBank, every music cue renders its arrangement, and every patch loop is
// copied next to an S17 manifest.json that the browser loads. HAA's prebuilt worklet and wasm
// are copied as haa-processors.js and haa.wasm. Output: apps/web/public/audio (gitignored).
// Renders are cached outside the checkout, keyed by a hash of every input of the render (HAA's dist
// and wasm, this script, the sound def, its bank entries and every source text it reads), so a build
// whose sounds did not change copies them instead of rendering 372 WAVs again.
// Run by `npm run audio:bake` (and by web:build).
//   node --experimental-strip-types tools/bake-audio.ts [--out <dir>]
import { createHash } from 'node:crypto'
import {
  copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
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
import { rfCacheRoot, writableDir } from './content.ts'

export const DEFAULT_AUDIO_OUT = 'apps/web/public/audio'

// Every worktree of one clone shares one cache under rfCacheRoot, like the mesh cache (content.ts).
// null: no cache directory can be written, the bake renders everything and stores nothing.
export function audioCacheDir(root = repoRoot()): string | null {
  if (process.env.RF_AUDIO_CACHE_DIR) {
    const dir = resolve(process.env.RF_AUDIO_CACHE_DIR)
    return writableDir(dir) ? dir : null
  }
  const base = rfCacheRoot(root)
  return base === null ? null : join(base, 'audio')
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((item) => {
    const path = join(dir, item.name)
    return item.isDirectory() ? filesUnder(path) : [path]
  }).sort()
}

/** Hash of the renderer: HAA's built JS, its wasm and this script. */
function engineKey(root: string): string {
  const require = createRequire(join(root, 'package.json'))
  const hash = createHash('sha256')
  const dist = dirname(require.resolve('@etcito/haa-spatial/bank'))
  for (const file of [...filesUnder(dist), require.resolve('@etcito/haa-spatial/wasm'), new URL(import.meta.url).pathname]) {
    hash.update(file.slice(file.lastIndexOf('/') + 1)).update('\0').update(readFileSync(file)).update('\0')
  }
  return hash.digest('hex')
}

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

/** A baked WAV's render-cache key and whether it is a music cue (S17). */
export interface BakeFileKey {
  key: string
  music: boolean
}

interface BakeSources {
  familyOf(id: string): FamilyRender
  bakeSet(sound: SoundDef): BankEntry[]
  source(id: string, path: string): string
}

/** The family entries and source texts one bake reads; shared by the bake and the key function. */
function bakeSources(root: string): BakeSources {
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
  return { familyOf, bakeSet, source }
}

function loadCue(id: string, sources: BakeSources): ReturnType<typeof loadArrangement> {
  try {
    return loadArrangement(id, (path) => sources.source(id, path))
  } catch (error) {
    throw new Error(`[audio-bake] ${id}: ${message(error)}`)
  }
}

function keyBuilder(root: string): (parts: unknown[]) => string {
  const engine = engineKey(root)
  return (parts) => createHash('sha256').update(engine).update(JSON.stringify(parts)).digest('hex')
}

/**
 * The bake key of every WAV `bakeAudio` writes, and whether its sound is a music cue.
 * `bakeAudio` renders from this same map, so the bake cache and the audio compressor cannot
 * derive different keys for one file.
 */
export function bakeFileKeys(root: string = repoRoot()): Map<string, BakeFileKey> {
  const keyOf = keyBuilder(root)
  const sources = bakeSources(root)
  const keys = new Map<string, BakeFileKey>()
  for (const sound of SOUNDS) {
    if (MUSIC_CUE_IDS.includes(sound.id)) {
      const loaded = loadCue(sound.id, sources)
      keys.set(`${sound.id}.0.wav`, { key: keyOf([sound, loaded.arrangement, loaded.instruments]), music: true })
      continue
    }
    sources.familyOf(sound.id)
    if (sound.mode === 'loop') continue
    const entries = sources.bakeSet(sound)
    const text = sources.source(sound.id, sound.source)
    const key = keyOf([sound, entries, text])
    for (const entry of entries) keys.set(`${sound.id}.${entry.variant}.wav`, { key, music: false })
  }
  return keys
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
  outDir: string, log: (line: string) => void = console.log, cacheDir: string | null = audioCacheDir(),
): Promise<AudioManifest> {
  const root = repoRoot()
  mkdirSync(outDir, { recursive: true })
  if (cacheDir === null) log('[audio-bake] cache disabled: no writable cache directory (set RF_CACHE_DIR); rendering every sound')
  let module: Awaited<ReturnType<typeof loadModule>> | null = null
  const keys = bakeFileKeys(root)
  const sources = bakeSources(root)
  const keyOf = (file: string): string => {
    const baked = keys.get(file)
    if (!baked) throw new Error(`[audio-bake] ${file}: no bake key`)
    return baked.key
  }
  let cached = 0
  // A hit copies the cached files; a miss renders them (already checked) and stores them under the key.
  // The entry is written to a temporary folder and renamed, so a cut bake never leaves a partial entry.
  const fromCache = (key: string, files: string[]): boolean => {
    if (cacheDir === null) return false
    const dir = join(cacheDir, key)
    if (!files.every((file) => existsSync(join(dir, file)))) return false
    for (const file of files) copyFileSync(join(dir, file), join(outDir, file))
    cached += files.length
    return true
  }
  const toCache = (key: string, files: string[]): void => {
    if (cacheDir === null) return
    const dir = join(cacheDir, key)
    const temp = `${dir}.${process.pid}.tmp`
    try {
      mkdirSync(temp, { recursive: true })
      for (const file of files) copyFileSync(join(outDir, file), join(temp, file))
      rmSync(dir, { recursive: true, force: true })
      renameSync(temp, dir)
    } catch (error) {
      rmSync(temp, { recursive: true, force: true })
      log(`[audio-bake] cache not written (${message(error)}): ${dir}`)
    }
  }
  const renderer = async () => (module ??= await loadModule())

  const sounds: AudioManifestSound[] = []
  let wavs = 0
  for (const sound of SOUNDS) {
    if (MUSIC_CUE_IDS.includes(sound.id)) {
      const loaded = loadCue(sound.id, sources)
      const file = `${sound.id}.0.wav`
      const key = keyOf(file)
      if (!fromCache(key, [file])) {
        let render: StereoRender
        try {
          render = renderArrangement(await renderer(), loaded.arrangement, loaded.instruments)
        } catch (error) {
          throw new Error(`[audio-bake] ${sound.id}: ${message(error)}`)
        }
        checkRender(sound.id, render)
        writeFileSync(join(outDir, file), encodeWav(render))
        toCache(key, [file])
      }
      wavs++
      sounds.push({ id: sound.id, bus: sound.bus, mode: sound.mode, files: [file], patch: null })
      continue
    }

    sources.familyOf(sound.id)
    if (sound.mode === 'loop') {
      const patch = `audio/${sound.id}.haa.json`
      if (!existsSync(join(root, patch))) throw new Error(`[audio-bake] ${sound.id}: missing source file ${patch}`)
      copyFileSync(join(root, patch), join(outDir, `${sound.id}.haa.json`))
      sounds.push({ id: sound.id, bus: sound.bus, mode: sound.mode, files: [], patch })
      continue
    }

    const entries = sources.bakeSet(sound)
    const text = sources.source(sound.id, sound.source)
    const files = entries.map((entry) => `${sound.id}.${entry.variant}.wav`)
    const key = keyOf(files[0])
    if (!fromCache(key, files)) {
      let renders
      try {
        renders = renderBank(await renderer(), text, entries)
      } catch (error) {
        throw new Error(`[audio-bake] ${sound.id}: ${message(error)}`)
      }
      for (const [index, result] of renders.entries()) {
        checkRender(`${sound.id}.${entries[index].variant}`, result.render)
        writeFileSync(join(outDir, files[index]), encodeWav(result.render))
      }
      toCache(key, files)
    }
    wavs += files.length
    sounds.push({ id: sound.id, bus: sound.bus, mode: sound.mode, files, patch: null })
  }

  const manifest: AudioManifest = { format: 'royal-fiesta.audio', version: 1, sampleRate: 48000, sounds }
  writeFileSync(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  const require = createRequire(join(root, 'package.json'))
  copyFileSync(require.resolve('@etcito/haa-spatial/worklet'), join(outDir, 'haa-processors.js'))
  copyFileSync(require.resolve('@etcito/haa-spatial/wasm'), join(outDir, 'haa.wasm'))
  const patches = sounds.filter((sound) => sound.patch !== null).length
  log(`[audio-bake] ${sounds.length} sounds: ${wavs} WAVs (${wavs - cached} rendered, ${cached} from ${cacheDir ?? 'no cache'}), ${patches} live patches, manifest, worklet and wasm -> ${outDir}`)
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
