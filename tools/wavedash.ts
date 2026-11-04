import { spawn, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { buildContentIndex, packContent, shippedContent } from './content.ts'
import type { ContentIndex } from './content.ts'
import { decodeMesh } from '../apps/web/src/sdf/meshWire.ts'
import { mamaSource, repoRoot } from './bricks.ts'
import { isRefusal, refuse } from '../packages/sim/src/refusal.ts'

// Ported from the V0 M13 Wavedash packager, on release dependencies: RAA is the @etcito/raa release from
// package.json, so there is no raaBuild step and no sibling. Layout and manifest: docs/wavedash.md.
// Nothing here reads a key or a token, and nothing is pushed or published.
//
// Test-only seam (internal): RF_WAVEDASH_DIST=<dir> packs <dir> instead of apps/web/dist.

export const DEFAULT_OUT = 'out/wavedash-build'
export const UPLOAD_DIR = 'upload'
export const CONFIG_NAME = 'wavedash.toml'
export const BUILD_STAMP = 'rf-build.json'
export const ENTRY = 'game.html'
// nmc.gpu.json is the GPU-client declaration and store/ a local asset mirror: neither is part of the game.
export const EXCLUDED: readonly string[] = ['nmc.gpu.json', 'store']
// audio/ is copied by packAudio (the manifest and the MP3/Ogg it names), unless VITE_RF_AUDIO_URL points at a CDN.
export const AUDIO_DIR = 'audio'

export function wavedashToml(): string {
  return [
    '# Written by npm run wavedash. No key or token belongs here; the push run sets game_id in its own config.',
    `upload_dir = ${JSON.stringify(`./${UPLOAD_DIR}`)}`,
    `entrypoint = ${JSON.stringify(ENTRY)}`,
    '',
  ].join('\n')
}

function listFiles(dir: string, rel = ''): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir).sort()) {
    const childRel = rel === '' ? name : `${rel}/${name}`
    if (statSync(join(dir, name)).isDirectory()) out.push(...listFiles(join(dir, name), childRel))
    else out.push(childRel)
  }
  return out
}

function gitCommit(root: string): string | null {
  const result = spawnSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' })
  const commit = result.status === 0 ? result.stdout.trim() : ''
  return /^[0-9a-f]{40}$/.test(commit) ? commit : null
}

function raaVersion(root: string): string | null {
  const file = join(root, 'node_modules', '@etcito', 'raa', 'package.json')
  if (!existsSync(file)) return null
  const version = (JSON.parse(readFileSync(file, 'utf8')) as { version?: unknown }).version
  return typeof version === 'string' ? version : null
}

// Only the kind and the commit: a sibling path or an absent reason may name a local directory.
function mamaStamp(root: string): { source: 'sibling' | 'cloned' | 'absent'; commit: string | null } {
  const source = mamaSource(root)
  return { source: source.kind, commit: source.kind === 'absent' ? null : source.commit }
}

/** The audio CDN base from the host build environment, or null when the audio ships in the upload. */
export function audioCdn(raw = process.env.VITE_RF_AUDIO_URL): string | null {
  const base = (raw ?? '').trim().replace(/\/+$/, '')
  if (base === '') return null
  if (!/^https?:\/\/[^\s?#]+$/.test(base)) refuse('bricks', 'VITE_RF_AUDIO_URL', 'set an http(s) audio directory URL in the host build environment, or leave it unset to pack the audio')
  return base
}

function audioFiles(dir: string): string[] {
  const manifest = join(dir, 'manifest.json')
  if (!existsSync(manifest)) refuse('bricks', manifest, 'the audio manifest is missing; run npm run build (it prepares the compressed audio)')
  const sounds = (JSON.parse(readFileSync(manifest, 'utf8')) as { sounds?: { files?: string[] }[] }).sounds ?? []
  return [...new Set(sounds.flatMap(sound => sound.files ?? []))].sort()
}

/** Copy the audio manifest and exactly the MP3/Ogg files it names; a WAV or a missing file is refused. */
export function packAudio(from: string, to: string): void {
  const names = audioFiles(from)
  for (const name of names) {
    if (!/\.(mp3|ogg)$/i.test(name)) refuse('bricks', `${AUDIO_DIR}/${name}`, 'only compressed MP3/Ogg audio ships; run npm run audio:bake')
    if (!existsSync(join(from, name))) refuse('bricks', `${AUDIO_DIR}/${name}`, 'named by the audio manifest but missing from the build')
  }
  mkdirSync(to, { recursive: true })
  for (const name of ['manifest.json', ...names]) cpSync(join(from, name), join(to, name))
}

/** What an upload weighs: every file, the meshes (saved .mesh and server meshes, both gzipped) and the audio. */
export interface UploadSummary {
  files: number
  bytes: number
  meshes: { count: number; bytes: number }
  audioBytes: number
}

const RELAY_FIX = 'set VITE_RF_SERVER=wss://<relay>/ws in the build environment (never a file), or pass --offline for an offline-only build'

/** The relay a Wavedash build plays online with (VITE_RF_SERVER), or null with --offline. Unset or malformed refuses. */
export function relayServer(raw = process.env.VITE_RF_SERVER, offline = false): string | null {
  if (offline) return null
  const url = (raw ?? '').trim()
  if (url === '') refuse('bricks', 'VITE_RF_SERVER', `a Wavedash build must play online; ${RELAY_FIX}`)
  if (!/^wss?:\/\/\S+$/.test(url)) refuse('bricks', 'VITE_RF_SERVER', `is not a ws:// or wss:// URL; ${RELAY_FIX}`)
  return url
}

/** The built JavaScript of the upload must carry the relay (an existing dist packed with --skip-build may not). */
export function checkRelay(upload: string, raw = process.env.VITE_RF_SERVER, offline = false): void {
  const url = relayServer(raw, offline)
  if (url === null) return
  const literal = JSON.stringify(url)
  if (!listFiles(upload).filter(file => /\.js$/.test(file)).some(file => readFileSync(join(upload, file), 'utf8').includes(literal))) {
    refuse('bricks', 'VITE_RF_SERVER', 'the relay URL is absent from the built JavaScript; rebuild with it in the build environment (npm run wavedash without --skip-build)')
  }
}

const sizeOf = (path: string): number => statSync(path).size

/**
 * The upload's content carries exactly what a shipped page uses (tools/content.ts shippedContent, computed again from
 * the upload's own courses): every file index.json names is there, no asset file or saved mesh of an asset no page
 * meshes, and a server mesh only for a meshed asset that has no saved mesh.
 */
async function checkContent(upload: string): Promise<{ count: number; bytes: number }> {
  const content = join(upload, 'content')
  if (!existsSync(join(content, 'index.json'))) return { count: 0, bytes: 0 }
  const index = JSON.parse(readFileSync(join(content, 'index.json'), 'utf8')) as ContentIndex
  const named = [...index.assets.flatMap(a => a.mesh === undefined ? [a.path] : [a.path, a.mesh]), ...index.courses.map(c => c.path),
    ...index.audio.map(p => p.path), ...index.thumbs.map(t => t.path)]
  for (const path of named) {
    if (!existsSync(join(content, path))) refuse('bricks', `content/${path}`, 'named by content/index.json but missing from the upload')
  }
  const ship = await shippedContent(content)
  for (const a of buildContentIndex(content).assets) {
    if (!ship.assets.has(a.id)) refuse('bricks', `content/${a.path}`, `asset '${a.id}' is used by no shipped page; pack with npm run wavedash`)
  }
  const saved = new Map(index.assets.flatMap(a => a.mesh === undefined ? [] : [[a.mesh, a.id] as const]))
  let count = 0
  let bytes = 0
  const assetsDir = join(content, 'assets')
  for (const file of existsSync(assetsDir) ? listFiles(assetsDir).filter(f => f.endsWith('.mesh')) : []) {
    const path = `assets/${file}`
    const id = saved.get(path)
    if (id === undefined || !ship.meshed.has(id)) {
      refuse('bricks', `content/${path}`, 'carries a mesh no shipped page uses; pack with npm run wavedash (only the ticked levels, the characters and the catalog cosmetics)')
    }
    count++
    bytes += sizeOf(join(content, path))
  }
  const serverOnly = new Set([...ship.meshed].filter(id => !index.assets.some(a => a.id === id && a.mesh !== undefined)))
  const meshes = join(content, 'meshes')
  if (existsSync(meshes)) {
    for (const name of readdirSync(meshes).sort()) {
      const path = `content/meshes/${name}`
      if (/^[a-f0-9]{64}\.failed$/.test(name)) {
        if (serverOnly.size === 0) refuse('bricks', path, 'a server mesh refusal, but every meshed asset has a saved mesh')
        continue
      }
      let assetId = ''
      try { assetId = decodeMesh(gunzipSync(readFileSync(join(meshes, name)))).assetId } catch { /* not a server mesh */ }
      if (!/^[a-f0-9]{64}$/.test(name) || !serverOnly.has(assetId)) {
        refuse('bricks', path, `carries a server mesh${assetId ? ` of '${assetId}'` : ''} no shipped page uses: only a meshed asset without a saved mesh gets one`)
      }
      count++
      bytes += sizeOf(join(meshes, name))
    }
  }
  return { count, bytes }
}

/**
 * Verify an upload, including an existing build used with --skip-build: the audio packed (default) or on a CDN, and the
 * content limited to what a shipped page uses. Returns what the upload weighs.
 */
export async function checkUpload(upload: string, raw = process.env.VITE_RF_AUDIO_URL): Promise<UploadSummary> {
  const files = listFiles(upload)
  const base = audioCdn(raw)
  if (base === null) {
    const wav = files.find(file => /\.wav$/i.test(file))
    if (wav !== undefined) refuse('bricks', wav, 'a WAV never ships; only the MP3/Ogg the audio manifest names')
    const audio = join(upload, AUDIO_DIR)
    for (const name of audioFiles(audio)) {
      if (!existsSync(join(audio, name))) refuse('bricks', `${AUDIO_DIR}/${name}`, 'named by the audio manifest but missing from the upload')
    }
  } else {
    if (files.some(file => file.startsWith('audio/') || /\.(wav|mp3|ogg|opus|flac|aac|m4a)$/i.test(file))) {
      refuse('bricks', upload, 'audio must be uploaded separately with npm run audio:upload')
    }
    if (!files.filter(file => /\.js$/.test(file)).some(file => [JSON.stringify(base), JSON.stringify(base + '/')].some(literal => readFileSync(join(upload, file), 'utf8').includes(literal)))) {
      refuse('bricks', 'VITE_RF_AUDIO_URL', 'audio URL base is absent from built JavaScript; rebuild with the host environment')
    }
  }
  const meshes = await checkContent(upload)
  const sum = (list: string[]): number => list.reduce((n, file) => n + sizeOf(join(upload, file)), 0)
  return { files: files.length, bytes: sum(files), meshes, audioBytes: sum(files.filter(file => file.startsWith(`${AUDIO_DIR}/`))) }
}

export async function packWavedash(
  opts: { outDir: string; offline?: boolean },
): Promise<{ files: string[]; entry: 'game.html'; summary: UploadSummary; courses: string[]; leftOut: string[] }> {
  const root = repoRoot()
  const dist = resolve(process.env.RF_WAVEDASH_DIST ?? join(root, 'apps', 'web', 'dist'))
  const page = join(dist, ENTRY)
  if (!existsSync(page)) refuse('bricks', page, `the built game page is missing; run npm run build so apps/web/${ENTRY} is built`)
  relayServer(process.env.VITE_RF_SERVER, opts.offline === true)

  const out = resolve(opts.outDir)
  const upload = join(out, UPLOAD_DIR)
  rmSync(upload, { recursive: true, force: true })
  mkdirSync(upload, { recursive: true })
  for (const name of readdirSync(dist).sort()) {
    // content/ (an earlier local pack into dist, e.g. tools/chromeCheck.ts) is packed again below from the sources.
    if (EXCLUDED.includes(name) || name === AUDIO_DIR || name === 'content') continue
    cpSync(join(dist, name), join(upload, name), { recursive: true })
  }
  if (audioCdn() === null) packAudio(join(dist, AUDIO_DIR), join(upload, AUDIO_DIR))

  // Remove this bundled content when the CDN serves it. Only what a shipped page uses: the levels ticked in SDF Modeler
  // (sdfm.build.json), the assets they load, the characters and the catalog cosmetics. A meshed asset loads its saved
  // .mesh (sdfLoad.ts tries it first); a server mesh ships only for a meshed asset without one, never the whole cache.
  const ship = await shippedContent()
  const full = buildContentIndex()
  const serverOnly = [...ship.meshed].filter(id => !full.assets.some(a => a.id === id && a.mesh !== undefined)).sort()
  let meshKeys: ReadonlySet<string> = new Set()
  if (serverOnly.length > 0) {
    const { MeshBaker } = await import('./meshBake.ts')
    const baker = new MeshBaker(undefined, undefined, serverOnly)
    await baker.scan()
    meshKeys = baker.keys
  }
  packContent(join(upload, 'content'), undefined, meshKeys, ship)
  const leftOut = full.assets.filter(a => a.mesh !== undefined && !ship.meshed.has(a.id)).map(a => a.id).sort()

  const summary = await checkUpload(upload)
  checkRelay(upload, process.env.VITE_RF_SERVER, opts.offline === true)

  const stamp = {
    format: 'royal-fiesta.build',
    version: 1,
    commit: gitCommit(root),
    builtAt: new Date().toISOString().slice(0, 16).replace('T', ' ') + 'Z',
    entry: ENTRY,
    raa: raaVersion(root),
    mama: mamaStamp(root),
    // Only whether the build had a default relay (VITE_RF_SERVER, read from the build environment): never its value.
    defaultServer: (process.env.VITE_RF_SERVER ?? '').trim() !== '',
  }
  writeFileSync(join(upload, BUILD_STAMP), `${JSON.stringify(stamp, null, 2)}\n`)
  writeFileSync(join(out, CONFIG_NAME), wavedashToml())
  const files = listFiles(upload)
  return { files, entry: ENTRY, summary: { ...summary, files: files.length, bytes: summary.bytes + sizeOf(join(upload, BUILD_STAMP)) }, courses: [...ship.courses].sort(), leftOut }
}

function build(root: string): Promise<number> {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  return new Promise((resolveExit, reject) => {
    const child = spawn(npm, ['run', 'build'], { cwd: root, stdio: 'inherit' })
    child.once('error', reject)
    child.once('close', (code) => resolveExit(code ?? 1))
  })
}

const USAGE = 'usage: npm run wavedash [-- --out <dir>] [--skip-build] [--offline]'
const mb = (bytes: number): string => `${(bytes / 1e6).toFixed(1)} MB`

export async function main(argv: string[]): Promise<number> {
  let outDir = DEFAULT_OUT
  let skipBuild = false
  let offline = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--skip-build') skipBuild = true
    else if (arg === '--offline') offline = true
    else if (arg === '--out' && argv[i + 1] !== undefined) outDir = argv[++i]
    else {
      console.error(`wavedash: unexpected argument ${JSON.stringify(arg)}`)
      console.error(USAGE)
      return 1
    }
  }
  const root = repoRoot()
  try {
    // Before the build: a Wavedash build without a relay is offline-only (one was pushed so on 2026-11-04).
    relayServer(process.env.VITE_RF_SERVER, offline)
  } catch (error) {
    if (!isRefusal(error)) throw error
    console.error(error.message)
    return 1
  }
  if (!skipBuild) {
    const code = await build(root)
    if (code !== 0) return code
  }
  try {
    const out = resolve(root, outDir)
    const { entry, summary, courses, leftOut } = await packWavedash({ outDir: out, offline })
    const rel = (p: string): string => relative(root, p) || '.'
    console.log(`wavedash: upload_dir=${rel(join(out, UPLOAD_DIR))} files=${summary.files} total=${mb(summary.bytes)}` +
      ` meshes=${summary.meshes.count} (${mb(summary.meshes.bytes)} gzipped) audio=${mb(summary.audioBytes)} levels=${courses.length}` +
      ` entry=${entry} config=${rel(join(out, CONFIG_NAME))}${offline ? ' offline' : ''}`)
    console.log(`wavedash: levels ${courses.join(', ')}`)
    console.log(`wavedash: meshes left out (${leftOut.length}): ${leftOut.join(', ') || 'none'}`)
    return 0
  } catch (error) {
    if (!isRefusal(error)) throw error
    console.error(error.message)
    return 1
  }
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (import.meta.url === entry) process.exitCode = await main(process.argv.slice(2))
