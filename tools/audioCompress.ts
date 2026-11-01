// Compresses the baked WAV set for the web build: every WAV the S17 manifest lists is decoded,
// a non-music sound whose two channels are sample-identical is encoded mono (music stays stereo),
// and both MP3 (libmp3lame, VBR -q:a 4) and Ogg Opus (libopus, 64 kb/s mono / 96 kb/s stereo,
// -vbr on) are tried at 48 kHz; the smaller file is kept and the WAV is removed. Encoded results
// are cached under the sound's bake key (bakeFileKeys), so a second build copies them and runs no
// ffmpeg. The encoder is injectable for tests; the real one refuses (never falls back) when
// ffmpeg or a codec is missing.
import { spawnSync } from 'node:child_process'
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { refuse } from '../packages/sim/src/refusal.ts'
import { audioCacheDir, bakeFileKeys } from './bake-audio.ts'
import type { AudioManifest, BakeFileKey } from './bake-audio.ts'

export type AudioCodec = 'mp3' | 'opus'

export interface EncodeRequest {
  input: string
  output: string
  codec: AudioCodec
  channels: 1 | 2
  sampleRate: number
}

/** Encodes one WAV into request.output; tests inject a stub, the default runs ffmpeg. */
export type AudioEncoder = (request: EncodeRequest) => void | Promise<void>

export interface CompressOptions {
  encode?: AudioEncoder
  /** Defaults to `<audioCacheDir()>/compressed/v1`; tests point RF_AUDIO_CACHE_DIR at a temp dir. */
  cacheDir?: string
  /** Defaults to bakeFileKeys(); tests inject their own names/keys without a real repo bake. */
  keys?: () => ReadonlyMap<string, BakeFileKey>
  log?: (line: string) => void
}

export interface CompressedFile {
  id: string
  from: string
  file: string
  codec: AudioCodec
  channels: 1 | 2
  music: boolean
  bytes: number
  cached: boolean
}

export interface CompressResult {
  encoded: number
  cached: number
  mono: number
  stereo: number
  files: CompressedFile[]
  /** Non-music sounds whose channels differ, reported by id. */
  stereoIds: string[]
}

const CACHE_VERSION = 1

interface CodecSpec {
  name: string
  extension: '.mp3' | '.ogg'
  args: (channels: 1 | 2) => string[]
}

const CODECS: Record<AudioCodec, CodecSpec> = {
  mp3: { name: 'libmp3lame', extension: '.mp3', args: () => ['-c:a', 'libmp3lame', '-q:a', '4'] },
  opus: {
    name: 'libopus',
    extension: '.ogg',
    args: (channels) => ['-c:a', 'libopus', '-b:a', channels === 1 ? '64k' : '96k', '-vbr', 'on'],
  },
}

function lastLine(text: string): string {
  const lines = text.trim().split('\n').filter((line) => line.trim() !== '')
  return lines.at(-1)?.trim() ?? 'no output'
}

/** The real encoder: ffmpeg at 48 kHz, refusing a missing binary or codec by codec name. */
export function ffmpegEncode(request: EncodeRequest): void {
  const spec = CODECS[request.codec]
  const args = [
    '-y', '-loglevel', 'error', '-i', request.input,
    '-ar', '48000', '-ac', String(request.channels), ...spec.args(request.channels), request.output,
  ]
  const result = spawnSync('ffmpeg', args, { encoding: 'utf8' })
  if (result.error) {
    if ((result.error as NodeJS.ErrnoException).code === 'ENOENT') {
      refuse('audio-compress', spec.name,
        `ffmpeg is not installed; install ffmpeg with ${spec.name} (for example: apt install ffmpeg)`)
    }
    refuse('audio-compress', spec.name, `could not run ffmpeg for ${spec.name}: ${result.error.message}`)
  }
  if (result.status !== 0) {
    const stderr = result.stderr ?? ''
    if (/Unknown encoder|Encoder .* not found/i.test(stderr)) {
      refuse('audio-compress', spec.name,
        `this ffmpeg has no ${spec.name} codec; install ffmpeg built with ${spec.name} (for example: apt install ffmpeg)`)
    }
    refuse('audio-compress', spec.name, `ffmpeg ${spec.name} encode failed (exit ${result.status}): ${lastLine(stderr)}`)
  }
  if (!existsSync(request.output) || statSync(request.output).size === 0) {
    refuse('audio-compress', spec.name, `ffmpeg ${spec.name} produced no output for ${request.input}`)
  }
}

interface PcmInfo {
  channels: 1 | 2
  sampleRate: number
  /** True when every decoded left sample equals the right one (or the source is mono). */
  identical: boolean
}

function chunkText(bytes: Buffer, start: number): string {
  return bytes.toString('ascii', start, start + 4)
}

/** Reads the PCM header and checks channel equality on the decoded samples. */
function readPcm(path: string): PcmInfo {
  const bytes = readFileSync(path)
  if (bytes.length < 12 || chunkText(bytes, 0) !== 'RIFF' || chunkText(bytes, 8) !== 'WAVE') {
    refuse('audio-compress', path, 'not a RIFF/WAVE file')
  }
  let format = 0
  let channels = 0
  let sampleRate = 0
  let bits = 0
  let data: Buffer | null = null
  let offset = 12
  while (offset + 8 <= bytes.length) {
    const id = chunkText(bytes, offset)
    const size = bytes.readUInt32LE(offset + 4)
    const start = offset + 8
    const end = Math.min(start + size, bytes.length)
    if (id === 'fmt ' && end - start >= 16) {
      format = bytes.readUInt16LE(start)
      channels = bytes.readUInt16LE(start + 2)
      sampleRate = bytes.readUInt32LE(start + 4)
      bits = bytes.readUInt16LE(start + 14)
    } else if (id === 'data') {
      data = bytes.subarray(start, end)
    }
    offset = start + size + (size % 2)
  }
  if (channels !== 1 && channels !== 2) refuse('audio-compress', path, `unsupported channel count ${channels}`)
  if (!data || data.length === 0) refuse('audio-compress', path, 'missing PCM data')
  const isFloat = format === 3 && bits === 32
  if (!isFloat && !(format === 1 && bits === 16)) {
    refuse('audio-compress', path, `unsupported PCM format ${format}/${bits}-bit (expected 16-bit PCM or 32-bit float)`)
  }
  let identical = channels === 1
  if (channels === 2) {
    identical = true
    const frameBytes = isFloat ? 8 : 4
    const frames = Math.floor(data.length / frameBytes)
    for (let frame = 0; frame < frames; frame++) {
      const at = frame * frameBytes
      const left = isFloat ? data.readFloatLE(at) : data.readInt16LE(at)
      const right = isFloat ? data.readFloatLE(at + 4) : data.readInt16LE(at + 2)
      if (left !== right) {
        identical = false
        break
      }
    }
  }
  return { channels, sampleRate, identical }
}

interface CachedChoice {
  file: string
  codec: AudioCodec
  channels: 1 | 2
}

interface CacheDoc {
  version: 1
  choices: Record<string, CachedChoice>
}

function readCache(dir: string): Record<string, CachedChoice> {
  try {
    const doc = JSON.parse(readFileSync(join(dir, 'choices.json'), 'utf8')) as CacheDoc
    if (doc.version !== CACHE_VERSION || typeof doc.choices !== 'object' || doc.choices === null) return {}
    return doc.choices
  } catch {
    return {}
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

interface EntryState {
  dir: string
  choices: Record<string, CachedChoice>
  dirty: boolean
}

function writeCacheEntry(state: EntryState, audioDir: string, log: (line: string) => void): void {
  const temp = `${state.dir}.${process.pid}.tmp`
  try {
    mkdirSync(temp, { recursive: true })
    for (const choice of Object.values(state.choices)) {
      const cached = join(state.dir, choice.file)
      const source = existsSync(cached) ? cached : join(audioDir, choice.file)
      if (!existsSync(source)) continue
      const target = join(temp, choice.file)
      mkdirSync(dirname(target), { recursive: true })
      copyFileSync(source, target)
    }
    const doc: CacheDoc = { version: CACHE_VERSION, choices: state.choices }
    writeFileSync(join(temp, 'choices.json'), `${JSON.stringify(doc, null, 2)}\n`)
    rmSync(state.dir, { recursive: true, force: true })
    renameSync(temp, state.dir)
  } catch (error) {
    rmSync(temp, { recursive: true, force: true })
    log(`[audio-compress] cache not written (${message(error)}): ${state.dir}`)
  }
}

/** Encodes every manifest WAV, keeps the smaller of MP3/Opus, rewrites the manifest and removes the WAVs. */
export async function compressAudio(audioDir: string, opts: CompressOptions = {}): Promise<CompressResult> {
  const dir = resolve(audioDir)
  const log = opts.log ?? console.log
  const encode = opts.encode ?? ffmpegEncode
  const keyMap = (opts.keys ?? (() => bakeFileKeys()))()
  const cacheRoot = opts.cacheDir
    ? resolve(opts.cacheDir)
    : join(audioCacheDir(), 'compressed', `v${CACHE_VERSION}`)
  const manifestPath = join(dir, 'manifest.json')
  let manifest: AudioManifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as AudioManifest
  } catch (error) {
    refuse('audio-compress', manifestPath, `cannot read the S17 manifest (${message(error)}); run npm run audio:bake first`)
  }
  if (manifest.format !== 'royal-fiesta.audio' || manifest.version !== 1 || !Array.isArray(manifest.sounds)) {
    refuse('audio-compress', manifestPath, 'expected an S17 sounds manifest')
  }
  const keyOfFile = (file: string): BakeFileKey => {
    const found = keyMap.get(file)
    if (!found) refuse('audio-compress', file, 'no bake key; run npm run audio:bake before compressing')
    return found
  }

  const states = new Map<string, EntryState>()
  const stateOf = (key: string): EntryState => {
    let state = states.get(key)
    if (!state) {
      const entry = join(cacheRoot, key)
      state = { dir: entry, choices: readCache(entry), dirty: false }
      states.set(key, state)
    }
    return state
  }

  const work = mkdtempSync(join(tmpdir(), 'rf-audio-compress-'))
  const results: CompressedFile[] = []
  const renames = new Map<string, string>()
  const stereoIds = new Set<string>()
  let encoded = 0
  let cached = 0
  let mono = 0
  let stereo = 0
  try {
    for (const sound of manifest.sounds) {
      for (const file of sound.files.filter((candidate) => /\.wav$/i.test(candidate))) {
        const baked = keyOfFile(file)
        const state = stateOf(baked.key)
        const known = state.choices[file]
        let choice: CachedChoice
        let bytes: number
        const hit = known !== undefined && existsSync(join(state.dir, known.file))
        if (known && hit) {
          choice = known
          bytes = statSync(join(state.dir, known.file)).size
          const target = join(dir, known.file)
          mkdirSync(dirname(target), { recursive: true })
          copyFileSync(join(state.dir, known.file), target)
          cached++
        } else {
          const input = join(dir, file)
          if (!existsSync(input)) refuse('audio-compress', file, `missing WAV in ${dir}`)
          const pcm = readPcm(input)
          const channels: 1 | 2 = baked.music ? 2 : pcm.identical ? 1 : 2
          const base = file.replace(/\.wav$/i, '')
          const candidates: { codec: AudioCodec; output: string; size: number }[] = []
          for (const codec of ['mp3', 'opus'] as const) {
            const output = join(work, `${encoded}-${codec}${CODECS[codec].extension}`)
            await encode({ input, output, codec, channels, sampleRate: pcm.sampleRate })
            if (!existsSync(output) || statSync(output).size === 0) {
              refuse('audio-compress', `${file}.${codec}`, `the encoder produced no ${codec} output`)
            }
            candidates.push({ codec, output, size: statSync(output).size })
          }
          const best = candidates.reduce((kept, candidate) => candidate.size < kept.size ? candidate : kept)
          const finalName = `${base}${CODECS[best.codec].extension}`
          const target = join(dir, finalName)
          mkdirSync(dirname(target), { recursive: true })
          copyFileSync(best.output, target)
          choice = { file: finalName, codec: best.codec, channels }
          state.choices[file] = choice
          state.dirty = true
          bytes = best.size
          encoded++
        }
        if (choice.channels === 1) mono++
        else stereo++
        if (!baked.music && choice.channels === 2) stereoIds.add(sound.id)
        renames.set(file, choice.file)
        results.push({
          id: sound.id, from: file, file: choice.file, codec: choice.codec,
          channels: choice.channels, music: baked.music, bytes, cached: hit,
        })
        log(`[audio-compress] ${hit ? 'cached' : 'encoded'} ${file} -> ${choice.file} (${choice.codec}, ${choice.channels === 1 ? 'mono' : 'stereo'}, ${bytes} bytes)`)
      }
    }
    for (const state of states.values()) {
      if (state.dirty) writeCacheEntry(state, dir, log)
    }
    manifest.sounds = manifest.sounds.map((sound) => ({
      ...sound, files: sound.files.map((file) => renames.get(file) ?? file),
    }))
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    for (const file of renames.keys()) rmSync(join(dir, file), { force: true })
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
  log(`[audio-compress] ${results.length} files: ${encoded} encoded, ${cached} cached; ${mono} mono, ${stereo} stereo -> ${dir}`)
  return { encoded, cached, mono, stereo, files: results, stereoIds: [...stereoIds] }
}
