// Bakes the Royal Fiesta sound set with HAA 0.2.0: every catalog one-shot renders its bake-set
// variants through renderBank, every music cue renders its arrangement, and every patch loop is
// copied next to an S17 manifest.json that the browser loads. HAA's prebuilt worklet and wasm
// are copied as haa-processors.js and haa.wasm. Output: apps/web/public/audio (gitignored).
// Run by `npm run audio:bake` (and by web:build).
//   node --experimental-strip-types tools/bake-audio.ts [--out <dir>]
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
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
import { meshCacheDir } from './content.ts'

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

/** Bakes every catalog sound into outDir and returns the S17 manifest. Deterministic. With `cacheDir`, each sound is
 * kept under a key of what that sound is made of (see soundKey): a sound whose key is unchanged is copied, never
 * rendered; a new or modified sound (its definition, its source, its arrangement, the HAA runtime) is rendered. */
export async function bakeAudio(
  outDir: string, log: (line: string) => void = console.log, cacheDir: string | null = null,
): Promise<AudioManifest> {
  const root = repoRoot()
  mkdirSync(outDir, { recursive: true })
  const module = await loadModule()
  const require = createRequire(join(root, 'package.json'))
  // What every render depends on besides the sound itself: the HAA runtime and this tool.
  const common = createHash('sha256')
  common.update(readFileSync(require.resolve('@etcito/haa-spatial/worklet')))
  common.update(readFileSync(require.resolve('@etcito/haa-spatial/wasm')))
  common.update(readFileSync(join(root, 'tools/bake-audio.ts')))
  const commonKey = common.digest('hex')
  const soundKey = (parts: unknown[]): string => {
    const hash = createHash('sha256').update(commonKey)
    for (const part of parts) hash.update('\0').update(typeof part === 'string' ? part : JSON.stringify(part))
    return hash.digest('hex')
  }
  let rendered = 0
  let reused = 0
  /** Copies a cached sound into outDir and returns its files, or null on a miss. */
  const fromCache = (key: string): string[] | null => {
    if (cacheDir === null) return null
    const dir = join(cacheDir, 'sounds', key)
    if (!existsSync(dir)) return null
    const files = readdirSync(dir).sort()
    for (const file of files) copyFileSync(join(dir, file), join(outDir, file))
    reused++
    return files
  }
  /** Publishes a freshly rendered sound atomically: copy beside, then rename (a half copy is never a hit). */
  const toCache = (key: string, files: string[]): void => {
    rendered++
    if (cacheDir === null) return
    const dir = join(cacheDir, 'sounds', key)
    const tmp = `${dir}.tmp-${process.pid}`
    mkdirSync(tmp, { recursive: true })
    for (const file of files) copyFileSync(join(outDir, file), join(tmp, file))
    mkdirSync(dirname(dir), { recursive: true })
    try { renameSync(tmp, dir) } catch { rmSync(tmp, { recursive: true, force: true }) }
  }

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
      const read: [string, string][] = []
      let loaded
      try {
        loaded = loadArrangement(sound.id, (path) => {
          const text = source(sound.id, path)
          read.push([path, text])
          return text
        })
      } catch (error) {
        throw new Error(`[audio-bake] ${sound.id}: ${message(error)}`)
      }
      const key = soundKey([sound, read])
      const cached = fromCache(key)
      if (cached !== null) {
        wavs += cached.length
        sounds.push({ id: sound.id, bus: sound.bus, mode: sound.mode, files: cached, patch: null })
        continue
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
      toCache(key, [file])
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
    const text = source(sound.id, sound.source)
    const key = soundKey([sound, entries, text])
    const cached = fromCache(key)
    if (cached !== null) {
      wavs += cached.length
      sounds.push({ id: sound.id, bus: sound.bus, mode: sound.mode, files: cached, patch: null })
      continue
    }
    let renders
    try {
      renders = renderBank(module, text, entries)
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
    toCache(key, files)
    sounds.push({ id: sound.id, bus: sound.bus, mode: sound.mode, files, patch: null })
  }

  const manifest: AudioManifest = { format: 'royal-fiesta.audio', version: 1, sampleRate: 48000, sounds }
  writeFileSync(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  copyFileSync(require.resolve('@etcito/haa-spatial/worklet'), join(outDir, 'haa-processors.js'))
  copyFileSync(require.resolve('@etcito/haa-spatial/wasm'), join(outDir, 'haa.wasm'))
  const patches = sounds.filter((sound) => sound.patch !== null).length
  log(`[audio-bake] ${sounds.length} sounds: ${wavs} WAVs (${rendered} rendered, ${reused} from the cache), ${patches} live patches, manifest, worklet and wasm -> ${outDir}`)
  return manifest
}

/** Where baked sounds are kept between builds, one folder per sound key: outside the checkout (RF_CACHE_DIR is one
 * root shared by every clone; RF_AUDIO_CACHE_DIR overrides it; otherwise next to the mesh cache). */
export function audioCacheDir(): string {
  if (process.env.RF_AUDIO_CACHE_DIR) return resolve(process.env.RF_AUDIO_CACHE_DIR)
  if (process.env.RF_CACHE_DIR) return join(resolve(process.env.RF_CACHE_DIR), 'audio')   // one root shared by every clone
  return join(dirname(meshCacheDir()), 'audio')
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (import.meta.url === entry) {
  const flag = process.argv.indexOf('--out')
  const out = flag >= 0 && process.argv[flag + 1] ? resolve(process.argv[flag + 1]) : join(repoRoot(), DEFAULT_AUDIO_OUT)
  const started = Date.now()
  rmSync(out, { recursive: true, force: true })
  const manifest = await bakeAudio(out, console.log, audioCacheDir())
  console.log(`baked ${manifest.sounds.length} sounds into ${out} in ${((Date.now() - started) / 1000).toFixed(1)} s`)
}
