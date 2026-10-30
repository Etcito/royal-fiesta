import { spawn, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { packContent } from './content.ts'
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

export async function packWavedash(opts: { outDir: string }): Promise<{ files: string[]; entry: 'game.html' }> {
  const root = repoRoot()
  const dist = resolve(process.env.RF_WAVEDASH_DIST ?? join(root, 'apps', 'web', 'dist'))
  const page = join(dist, ENTRY)
  if (!existsSync(page)) refuse('bricks', page, `the built game page is missing; run npm run build so apps/web/${ENTRY} is built`)

  const out = resolve(opts.outDir)
  const upload = join(out, UPLOAD_DIR)
  rmSync(upload, { recursive: true, force: true })
  mkdirSync(upload, { recursive: true })
  for (const name of readdirSync(dist).sort()) {
    if (EXCLUDED.includes(name)) continue
    cpSync(join(dist, name), join(upload, name), { recursive: true })
  }

  // Remove this bundled content when the CDN serves it.
  packContent(join(upload, 'content'))

  const stamp = {
    format: 'royal-fiesta.build',
    version: 1,
    commit: gitCommit(root),
    entry: ENTRY,
    raa: raaVersion(root),
    mama: mamaStamp(root),
    // Only whether the build had a default relay (VITE_RF_SERVER, read from the build environment): never its value.
    defaultServer: (process.env.VITE_RF_SERVER ?? '').trim() !== '',
  }
  writeFileSync(join(upload, BUILD_STAMP), `${JSON.stringify(stamp, null, 2)}\n`)
  writeFileSync(join(out, CONFIG_NAME), wavedashToml())
  return { files: listFiles(upload), entry: ENTRY }
}

function build(root: string): Promise<number> {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  return new Promise((resolveExit, reject) => {
    const child = spawn(npm, ['run', 'build'], { cwd: root, stdio: 'inherit' })
    child.once('error', reject)
    child.once('close', (code) => resolveExit(code ?? 1))
  })
}

const USAGE = 'usage: npm run wavedash [-- --out <dir>] [--skip-build]'

export async function main(argv: string[]): Promise<number> {
  let outDir = DEFAULT_OUT
  let skipBuild = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--skip-build') skipBuild = true
    else if (arg === '--out' && argv[i + 1] !== undefined) outDir = argv[++i]
    else {
      console.error(`wavedash: unexpected argument ${JSON.stringify(arg)}`)
      console.error(USAGE)
      return 1
    }
  }
  const root = repoRoot()
  if (!skipBuild) {
    const code = await build(root)
    if (code !== 0) return code
  }
  try {
    const out = resolve(root, outDir)
    const { files, entry } = await packWavedash({ outDir: out })
    const rel = (p: string): string => relative(root, p) || '.'
    console.log(`wavedash: upload_dir=${rel(join(out, UPLOAD_DIR))} files=${files.length} entry=${entry} config=${rel(join(out, CONFIG_NAME))}`)
    return 0
  } catch (error) {
    if (!isRefusal(error)) throw error
    console.error(error.message)
    return 1
  }
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (import.meta.url === entry) process.exitCode = await main(process.argv.slice(2))
