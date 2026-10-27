import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import {
  accessSync, constants, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync,
  symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { RefusalError, isRefusal, refuse } from '../packages/sim/src/refusal.ts'
import { redact } from './guard.ts'

// The GameSaloon rollback bricks (@gamesaloon/rollback, @gamesaloon/rollback-rapier) are installed
// from their GitHub release tarballs like any dependency; nothing here locates them.
// RAA (@etcito/raa) is a release dependency of apps/web too; raa is only looked up for the local
// override. gamesaloon-public and MAMA are located by directory.
export type BrickName = 'gamesaloon-public' | 'raa-assets-tools' | 'raa' | 'MAMA'

const names: BrickName[] = ['gamesaloon-public', 'raa-assets-tools', 'raa', 'MAMA']
const pathHere = dirname(fileURLToPath(import.meta.url))
const PIN_FILE = 'bricks.pins.json'

export function repoRoot(): string {
  let dir = pathHere
  while (true) {
    const manifest = join(dir, 'package.json')
    if (existsSync(manifest)) {
      try {
        if (JSON.parse(readFileSync(manifest, 'utf8')).name === 'royal-fiesta') return realpathSync(dir)
      } catch {}
    }
    const parent = dirname(dir)
    if (parent === dir) refuse('bricks', manifest, 'could not find package.json named royal-fiesta; run this tool from the royal-fiesta repository')
    dir = parent
  }
}

// Directory of a local brick checkout. Lookup order: the env override, then a folder named after
// the brick next to this repository (RF_BRICKS_DIR overrides the parent folder).
export function brickDir(name: BrickName): string | null {
  const root = repoRoot()
  const override = name === 'gamesaloon-public' ? process.env.GAMESALOON_DIR : undefined
  const candidates = [
    ...(override ? [override] : []),
    ...(process.env.RF_BRICKS_DIR ? [join(process.env.RF_BRICKS_DIR, name)] : []),
    join(dirname(root), name),
  ]
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate) && statSync(candidate).isDirectory()) return realpathSync(candidate)
    } catch {}
  }
  return null
}

export interface BrickPin { repo: string; commit: string }

const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const COMMIT_PATTERN = /^[0-9a-f]{40}$/

const PIN_NAMES = ['MAMA', 'UAA', 'RAA'] as const
type PinName = (typeof PIN_NAMES)[number]
const PIN_EXAMPLES: Record<PinName, string> = {
  MAMA: '{"repo":"Etcito/MAMA","commit":"<40 hex>"}',
  UAA: '{"repo":"Etcito/uaa","commit":"<40 hex>"}',
  RAA: '{"repo":"Etcito/raa","commit":"<40 hex>"}',
}

// The one pin table (S15). MAMA, uaa and raa are pinned; everything else is a release dependency.
export function readPins(file?: string): { MAMA: BrickPin; UAA: BrickPin; RAA: BrickPin } {
  const path = file ?? join(repoRoot(), PIN_FILE)
  const label = basename(path)
  const pointer = (name: PinName, field?: string): string => `${label}#/${name}${field ? `/${field}` : ''}`
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    refuse('bricks', label, `missing; add ${PIN_FILE} with ${PIN_NAMES.map((name) => `"${name}":${PIN_EXAMPLES[name]}`).join(',')}`)
  }
  let document: unknown
  try {
    document = JSON.parse(text)
  } catch (error) {
    refuse('bricks', label, `not valid JSON (${error instanceof Error ? error.message : String(error)}); fix the pins file`)
  }
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    refuse('bricks', label, `must be an object with the ${PIN_NAMES.join(', ')} keys; fix the pins file`)
  }
  const record = document as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (!PIN_NAMES.includes(key as PinName)) {
      refuse('bricks', `${label}#/${key}`, `unknown brick; the pins are ${PIN_NAMES.join(', ')}; remove it`)
    }
  }
  const pins = {} as Record<PinName, BrickPin>
  for (const name of PIN_NAMES) {
    const entry = record[name]
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      refuse('bricks', pointer(name), `missing or not an object; add ${PIN_EXAMPLES[name]}`)
    }
    const pin = entry as Record<string, unknown>
    for (const key of Object.keys(pin)) {
      if (key !== 'repo' && key !== 'commit') refuse('bricks', pointer(name, key), 'unknown field; keep only repo and commit')
    }
    if (typeof pin.repo !== 'string' || !REPO_PATTERN.test(pin.repo)) {
      refuse('bricks', pointer(name, 'repo'), `expected owner/name, got ${JSON.stringify(pin.repo)}; fix the ${name} pin in ${label}`)
    }
    if (typeof pin.commit !== 'string' || !COMMIT_PATTERN.test(pin.commit)) {
      refuse('bricks', pointer(name, 'commit'), `expected 40 lowercase hex, got ${JSON.stringify(pin.commit)}; fix the ${name} pin in ${label}`)
    }
    pins[name] = { repo: pin.repo, commit: pin.commit }
  }
  return { MAMA: pins.MAMA, UAA: pins.UAA, RAA: pins.RAA }
}

// Reads HEAD from the git files (a checkout or a `gitdir:` worktree file) without spawning git.
function gitDirOf(dir: string): string | null {
  const dotGit = join(dir, '.git')
  try {
    const stats = lstatSync(dotGit)
    if (stats.isDirectory()) return dotGit
    if (!stats.isFile()) return null
    const text = readFileSync(dotGit, 'utf8').trim()
    if (!text.startsWith('gitdir:')) return null
    return resolve(dir, text.slice('gitdir:'.length).trim())
  } catch {
    return null
  }
}

function readGitHead(dir: string): string | null {
  const gitDir = gitDirOf(dir)
  if (!gitDir) return null
  try {
    const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim()
    if (COMMIT_PATTERN.test(head)) return head
    if (!head.startsWith('ref: ')) return null
    const ref = head.slice('ref: '.length).trim()
    try {
      const direct = readFileSync(join(gitDir, ref), 'utf8').trim()
      if (COMMIT_PATTERN.test(direct)) return direct
    } catch {}
    try {
      for (const line of readFileSync(join(gitDir, 'packed-refs'), 'utf8').split('\n')) {
        const [hash, name] = line.trim().split(/\s+/)
        if (name === ref && COMMIT_PATTERN.test(hash)) return hash
      }
    } catch {}
  } catch {}
  return null
}

export type MamaSource =
  | { kind: 'sibling'; dir: string; commit: string | null; matchesPin: boolean }
  | { kind: 'cloned'; dir: string; commit: string }
  | { kind: 'absent'; reason: string }

export const MAMA_ABSENT_PREFIX = 'MAMA not available: '

// $RF_BRICKS_DIR/MAMA, then ../MAMA (brickDir's order), relative to the given repository root.
function mamaSibling(root: string): string | null {
  const candidates = [
    ...(process.env.RF_BRICKS_DIR ? [join(process.env.RF_BRICKS_DIR, 'MAMA')] : []),
    join(dirname(root), 'MAMA'),
  ]
  for (const candidate of candidates) {
    // .bricks/MAMA itself is never its own sibling (RF_BRICKS_DIR=.bricks)
    if (resolve(candidate) === join(root, '.bricks', 'MAMA')) continue
    try {
      if (existsSync(candidate) && statSync(candidate).isDirectory()) return realpathSync(candidate)
    } catch {}
  }
  return null
}

// Offline resolution of MAMA: .bricks/MAMA first, then the documented siblings. Never clones.
export function mamaSource(root: string = repoRoot()): MamaSource {
  const pins = readPins().MAMA
  const link = join(root, '.bricks', 'MAMA')
  try {
    const stats = lstatSync(link)
    if (stats.isSymbolicLink()) {
      let dir: string
      try {
        dir = realpathSync(link)
      } catch {
        return { kind: 'absent', reason: `${link} is a broken symlink; run npm run bricks -- fetch mama` }
      }
      const commit = readGitHead(dir)
      return { kind: 'sibling', dir, commit, matchesPin: commit !== null && commit === pins.commit }
    }
    if (stats.isDirectory()) {
      const commit = readGitHead(link)
      if (commit === null) return { kind: 'absent', reason: `${link} is a directory without a readable git HEAD; remove it and run npm run bricks -- fetch mama` }
      return { kind: 'cloned', dir: realpathSync(link), commit }
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') return { kind: 'absent', reason: `cannot inspect ${link} (${error instanceof Error ? error.message : String(error)})` }
  }
  const sibling = mamaSibling(root)
  if (sibling) {
    const commit = readGitHead(sibling)
    return { kind: 'sibling', dir: sibling, commit, matchesPin: commit !== null && commit === pins.commit }
  }
  return { kind: 'absent', reason: `no .bricks/MAMA, no $RF_BRICKS_DIR/MAMA or ../MAMA; clone ${pins.repo} next to this repository or run npm run bricks -- fetch mama` }
}

export type UaaSource =
  | { kind: 'sibling'; dir: string; commit: string | null; matchesPin: boolean }
  | { kind: 'cloned'; dir: string; commit: string }
  | { kind: 'absent'; reason: string }

export const UAA_ABSENT_PREFIX = 'UAA not available: '

// uaa is imported as file:../uaa, so its working directory is the sibling itself. A .bricks/UAA
// clone would not resolve the package export.
function uaaSibling(root: string): string | null {
  const candidate = join(dirname(root), 'uaa')
  try {
    if (existsSync(candidate) && statSync(candidate).isDirectory()) return realpathSync(candidate)
  } catch {}
  return null
}

// Offline resolution of uaa: .bricks/UAA first, then the ../uaa sibling. Never clones.
export function uaaSource(root: string = repoRoot()): UaaSource {
  const pins = readPins().UAA
  const link = join(root, '.bricks', 'UAA')
  try {
    const stats = lstatSync(link)
    if (stats.isSymbolicLink()) {
      let dir: string
      try {
        dir = realpathSync(link)
      } catch {
        return { kind: 'absent', reason: `${link} is a broken symlink; run npm run bricks -- fetch uaa` }
      }
      const commit = readGitHead(dir)
      return { kind: 'sibling', dir, commit, matchesPin: commit !== null && commit === pins.commit }
    }
    if (stats.isDirectory()) {
      const commit = readGitHead(link)
      if (commit === null) return { kind: 'absent', reason: `${link} is a directory without a readable git HEAD; remove it and run npm run bricks -- fetch uaa` }
      return { kind: 'cloned', dir: realpathSync(link), commit }
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') return { kind: 'absent', reason: `cannot inspect ${link} (${error instanceof Error ? error.message : String(error)})` }
  }
  const sibling = uaaSibling(root)
  if (sibling) {
    const commit = readGitHead(sibling)
    return { kind: 'sibling', dir: sibling, commit, matchesPin: commit !== null && commit === pins.commit }
  }
  return { kind: 'absent', reason: `no .bricks/UAA or ../uaa; clone ${pins.repo} next to this repository or run npm run bricks -- fetch uaa` }
}
export type RaaSource =
  | { kind: 'sibling'; dir: string; commit: string | null }
  | { kind: 'cloned'; dir: string; commit: string }
  | { kind: 'absent'; reason: string }
export const RAA_ABSENT_PREFIX = 'RAA not available: '
export const RAA_BRICK_DIRS = ['raa', 'raa-sdfm', 'raa-anim'] as const
// $RF_BRICKS_DIR/raa, then ../raa (brickDir's order). .bricks/RAA itself is never its own sibling.
function raaSibling(root: string): string | null {
  const candidates = [
    ...(process.env.RF_BRICKS_DIR ? [join(process.env.RF_BRICKS_DIR, 'raa')] : []),
    join(dirname(root), 'raa'),
  ]
  for (const candidate of candidates) {
    if (resolve(candidate) === join(root, '.bricks', 'RAA')) continue
    try {
      if (existsSync(candidate) && statSync(candidate).isDirectory()) return realpathSync(candidate)
    } catch {}
  }
  return null
}
// Offline resolution of RAA: .bricks/RAA first, then the documented siblings. Never builds.
export function raaSource(root: string = repoRoot()): RaaSource {
  const pins = readPins().RAA
  const link = join(root, '.bricks', 'RAA')
  try {
    const stats = lstatSync(link)
    if (stats.isSymbolicLink()) {
      let dir: string
      try { dir = realpathSync(link) } catch { return { kind: 'absent', reason: `${link} is a broken symlink; run npm run bricks -- fetch raa` } }
      const commit = readGitHead(dir)
      return { kind: 'sibling', dir, commit }
    }
    if (stats.isDirectory()) {
      const commit = readGitHead(link)
      if (commit === null) return { kind: 'absent', reason: `${link} is a directory without a readable git HEAD; remove it and run npm run bricks -- fetch raa` }
      return { kind: 'cloned', dir: realpathSync(link), commit }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return { kind: 'absent', reason: `cannot inspect ${link} (${error instanceof Error ? error.message : String(error)})` }
  }
  const sibling = raaSibling(root)
  if (sibling) {
    const commit = readGitHead(sibling)
    return { kind: 'sibling', dir: sibling, commit }
  }
  return { kind: 'absent', reason: `no .bricks/RAA, no $RF_BRICKS_DIR/raa or ../raa; clone ${pins.repo} next to this repository or run npm run bricks -- fetch raa` }
}
export interface RaaBricks { manifest: string; commit: string | null; packages: string[] }
// The staged brick manifest and the three package directories under dist/bricks.
export function raaBricks(dir: string): RaaBricks {
  const manifest = join(dir, 'dist', 'bricks', 'bricks.json')
  let commit: string | null = null
  try {
    const document = JSON.parse(readFileSync(manifest, 'utf8')) as { commit?: unknown }
    const value = document.commit
    if (typeof value === 'string') commit = value
    // Managed siblings are read-only. Older build-bricks.sh manifests omit provenance;
    // retain their staging record here, bound to the actual sibling and its Git HEAD.
    // An explicit manifest commit (including an invalid one) always takes precedence.
    if (!Object.hasOwn(document, 'commit')) {
      const root = repoRoot()
      const lock = JSON.parse(readFileSync(join(root, 'bricks.raa.lock.json'), 'utf8'))
      if (lock.repo === readPins().RAA.repo && lock.source === '../raa'
        && lock.manifest === 'dist/bricks/bricks.json'
        && typeof lock.commit === 'string' && COMMIT_PATTERN.test(lock.commit)
        && realpathSync(resolve(root, lock.source)) === realpathSync(dir)
        && readGitHead(dir) === lock.commit) commit = lock.commit
    }
  } catch {}
  const packages = RAA_BRICK_DIRS.filter((name) => {
    try { return statSync(join(dir, 'dist', 'bricks', name)).isDirectory() } catch { return false }
  })
  return { manifest, commit, packages }
}
// The build script writes versions and wasm sizes; fetch records the pinned commit in the same
// manifest when the script did not, so the manifest can be checked against the pin.
function verifyRaaBricks(dir: string, pin: BrickPin, print: (line: string) => void): RaaBricks {
  const bricks = raaBricks(dir)
  let document: Record<string, unknown>
  try {
    document = JSON.parse(readFileSync(bricks.manifest, 'utf8')) as Record<string, unknown>
  } catch (error) {
    refuse('bricks', 'RAA', `${bricks.manifest} is missing or not JSON (${error instanceof Error ? error.message : String(error)}); run bash scripts/build-bricks.sh in ${dir} and fix the error`)
  }
  if ('commit' in document && document.commit !== pin.commit) refuse('bricks', 'RAA', `${bricks.manifest} records commit ${JSON.stringify(document.commit)}, expected the pin ${pin.commit}; rebuild the pinned checkout or update ${PIN_FILE}`)
  if (!('commit' in document)) {
    document.commit = pin.commit
    writeFileSync(bricks.manifest, `${JSON.stringify(document, null, 2)}\n`)
  }
  const missing = RAA_BRICK_DIRS.filter((name) => !bricks.packages.includes(name))
  if (missing.length > 0) refuse('bricks', 'RAA', `${bricks.manifest} is at the pin but dist/bricks/${missing.join(', dist/bricks/')} is missing; run bash scripts/build-bricks.sh in ${dir} and fix the error`)
  print(`RAA bricks.json ${bricks.manifest} commit ${pin.commit} packages ${bricks.packages.join(' ')}`)
  return { ...bricks, commit: pin.commit }
}
function writable(dir: string): boolean {
  try { accessSync(dir, constants.W_OK); return true } catch { return false }
}
// Runs the consumed brick build script in the pinned checkout and checks its manifest.
async function buildRaa(dir: string, pin: BrickPin, print: (line: string) => void): Promise<void> {
  await run('bash', ['scripts/build-bricks.sh'], dir, childEnv(), [], print, {
    brick: 'RAA',
    timeoutMs: 1800000,
    exitHint: `see its output above, then run bash scripts/build-bricks.sh in ${dir} by hand and fix the error`,
  })
  verifyRaaBricks(dir, pin, print)
}
// S15: links a sibling at .bricks/RAA and builds it, else clones the pinned commit into ../raa.
// A read-only sibling (CI/containers) is copied under .bricks/RAA instead of being written to;
// the sibling checkout itself is never checked out, reset or otherwise modified.
export async function fetchRaa(root: string = repoRoot(), print: (line: string) => void = printLine): Promise<RaaSource> {
  const pin = readPins().RAA
  const link = join(root, '.bricks', 'RAA')
  const target = join(dirname(root), 'raa')
  const sibling = raaSibling(root)
  if (sibling) {
    const commit = readGitHead(sibling)
    if (commit === null) {
      refuse('bricks', 'RAA', `${sibling} has no readable git HEAD; check out ${pin.repo} at ${pin.commit} there or remove it and run npm run bricks -- fetch raa`)
    }
    if (commit !== pin.commit) {
      refuse('bricks', 'RAA', `the sibling ${sibling} is at ${commit}, expected the pin ${pin.commit}; check out the pinned commit or update ${PIN_FILE}`)
    }
    mkdirSync(dirname(link), { recursive: true })
    removeLink(link)
    let dir = sibling
    try {
      if (writable(sibling)) {
        symlinkSync(relative(dirname(link), sibling), link, 'dir')
      } else {
        print(`RAA: ${sibling} is read-only; building the pinned copy at ${link}`)
        cpSync(sibling, link, { recursive: true })
        dir = realpathSync(link)
      }
      await buildRaa(dir, pin, print)
    } catch (error) {
      removeLink(link)
      throw error
    }
    return raaSource(root)
  }
  try {
    if (!lstatSync(target).isDirectory()) {
      refuse('bricks', 'RAA', `${target} is not a directory; remove it or move it aside and run npm run bricks -- fetch raa`)
    }
  } catch (error) {
    if (isRefusal(error)) throw error
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      refuse('bricks', 'RAA', `cannot inspect ${target} (${error instanceof Error ? error.message : String(error)}); remove it or move it aside and run npm run bricks -- fetch raa`)
    }
  }
  const token = githubToken()
  if (!token) {
    refuse('bricks', 'RAA', `not found; clone ${pin.repo} next to this repository or set MAMA_TOKEN, GH_TOKEN or GITHUB_TOKEN on the build machine`)
  }
  const basic = Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64')
  const secrets = [token, basic]
  const gitEnv = childEnv({ GIT_TERMINAL_PROMPT: '0' })
  const fetchEnv = childEnv({
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
  })
  const url = `https://github.com/${pin.repo}.git`
  removeLink(link)
  mkdirSync(target, { recursive: true })
  try {
    const steps: [string[], NodeJS.ProcessEnv][] = [
      [['init', '--quiet'], gitEnv],
      [['fetch', '--depth', '1', url, pin.commit], fetchEnv],
      [['checkout', '--quiet', '--detach', 'FETCH_HEAD'], gitEnv],
    ]
    for (const [args, env] of steps) await run('git', args, target, env, secrets, print, { brick: 'RAA' })
    await buildRaa(target, pin, print)
    mkdirSync(dirname(link), { recursive: true })
    removeLink(link)
    symlinkSync(relative(dirname(link), target), link, 'dir')
    return { kind: 'cloned', dir: realpathSync(target), commit: pin.commit }
  } catch (error) {
    removeLink(link)
    rmSync(target, { recursive: true, force: true })
    throw error
  }
}
export interface BrickStatus { ok: boolean; lines: string[] }
// Reports every pinned brick. The RAA channel is the required one: its checkout, manifest
// commit and three package directories must all be at the pin for the status to pass.
export function brickStatus(root: string = repoRoot()): BrickStatus {
  const pins = readPins()
  const lines: string[] = []
  const report = (name: 'MAMA' | 'UAA', pin: BrickPin, source: MamaSource | UaaSource): void => {
    if (source.kind === 'absent') lines.push(`${name} absent: ${source.reason}`)
    else lines.push(`${name} ${source.kind} ${source.dir} commit ${source.commit ?? 'unknown'} ${source.commit === pin.commit ? 'pin ok' : `pin differs (${pin.commit})`}`)
  }
  report('MAMA', pins.MAMA, mamaSource(root))
  report('UAA', pins.UAA, uaaSource(root))
  const raa = raaSource(root)
  if (raa.kind === 'absent') {
    lines.push(`RAA absent: ${raa.reason}`)
    return { ok: false, lines }
  }
  const bricks = raaBricks(raa.dir)
  const atPin = raa.commit === pins.RAA.commit
  const complete = atPin && bricks.commit === pins.RAA.commit && RAA_BRICK_DIRS.every((name) => bricks.packages.includes(name))
  lines.push(`RAA ${raa.kind} ${raa.dir} commit ${raa.commit ?? 'unknown'} ${atPin ? 'pin ok' : `pin differs (${pins.RAA.commit})`}`)
  lines.push(`RAA bricks ${bricks.manifest} commit ${bricks.commit ?? 'missing'} packages ${bricks.packages.join(' ') || 'none'}`)
  if (!complete) lines.push('RAA channel incomplete; run npm run bricks -- fetch raa')
  return { ok: complete, lines }
}
const TOKEN_KEYS = ['MAMA_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'] as const
// Every secret value that could reach a child line, raw and trimmed. The values are never printed.
function tokenSecrets(): string[] {
  return TOKEN_KEYS.flatMap((key) => {
    const value = process.env[key]
    return value ? [value, value.trim()] : []
  })
}
// MAMA_TOKEN, else GH_TOKEN, else GITHUB_TOKEN. The value is never printed.
export function githubToken(): string | null {
  for (const key of TOKEN_KEYS) {
    const value = process.env[key]?.trim()
    if (value) return value
  }
  return null
}
// Deprecated: apps/web/vite.config.ts and the m11-m13 proofs still import this for their release
// alias. The pinned RAA channel (fetch/status) never reads RF_RAA_LOCAL.
export function raaLocal(): { active: boolean; dir: string | null } {
  if (process.env.RF_RAA_LOCAL !== '1') return { active: false, dir: null }
  const dir = brickDir('raa')
  return { active: dir !== null, dir }
}

// The @etcito/raa-sdfm the web build uses: the installed package, or the local RAA override (1.2).
// Part of the client mesh cache key (S15), read by vite.config.ts and by Node meshing alike.
export function raaSdfmVersion(): string {
  const root = repoRoot()
  const candidates = [
    join(root, 'apps', 'web', 'node_modules', '@etcito', 'raa-sdfm', 'package.json'),
    join(root, 'node_modules', '@etcito', 'raa-sdfm', 'package.json'),
  ]
  const raa = raaLocal()
  if (raa.active) {
    const dir = raa.dir ?? brickDir('raa')
    if (dir !== null) candidates.unshift(join(dir, 'packages', 'raa-sdfm', 'package.json'))
  }
  for (const file of candidates) {
    if (!existsSync(file)) continue
    const manifest = JSON.parse(readFileSync(file, 'utf8')) as { name?: unknown; version?: unknown }
    if (manifest.name === '@etcito/raa-sdfm' && typeof manifest.version === 'string' && manifest.version !== '') return manifest.version
    throw new RefusalError('sdf', '@etcito/raa-sdfm', `${file} has no name @etcito/raa-sdfm with a version; reinstall it with npm install`)
  }
  throw new RefusalError('sdf', '@etcito/raa-sdfm', 'the package is not installed; run npm install at the repository root')
}

// Children never see the token variables; only `git fetch` gets the auth header (extra).
function childEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra }
  for (const key of TOKEN_KEYS) delete env[key]
  return env
}

function printLine(line: string): void {
  process.stderr.write(`${line}\n`)
}

interface RunHints { brick?: string; exitHint?: string; spawnHint?: string; timeoutMs?: number }

// Runs one child from an argv array. Its stdout and stderr are printed line by line, each line
// redacted first, so a secret never reaches the terminal or a transcript. Every token variable is
// redacted even when a child was not handed it, so build output cannot leak one either.
function run(
  command: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv,
  givenSecrets: readonly string[], print: (line: string) => void, hints: RunHints = {},
): Promise<void> {
  const label = `${command} ${args[0] ?? ''}`.trim()
  const brick = hints.brick ?? 'MAMA'
  const secrets = [...givenSecrets, ...tokenSecrets()]
  print(redact(`$ ${[command, ...args].join(' ')}`, secrets))
  return new Promise((done, fail) => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], timeout: hints.timeoutMs ?? 600000 })
    const relay = (stream: NodeJS.ReadableStream): void => {
      let pending = ''
      stream.setEncoding('utf8')
      stream.on('data', (chunk: string) => {
        pending += chunk
        const lines = pending.split('\n')
        pending = lines.pop() ?? ''
        for (const line of lines) print(redact(line, secrets))
      })
      stream.on('end', () => {
        if (pending) print(redact(pending, secrets))
        pending = ''
      })
    }
    if (child.stdout) relay(child.stdout)
    if (child.stderr) relay(child.stderr)
    child.on('error', (error) => {
      fail(new RefusalError('bricks', brick, `${label} failed (${redact(error.message, secrets)}); ${hints.spawnHint ?? `check that ${command} is installed`}`))
    })
    child.on('close', (code, signal) => {
      if (code === 0) done()
      else fail(new RefusalError('bricks', brick, `${label} exited ${code ?? signal ?? 'abnormally'}; ${hints.exitHint ?? `see its output above, then check the token and the pin in ${PIN_FILE}`}`))
    })
  })
}

function removeLink(link: string): void {
  try {
    if (lstatSync(link).isSymbolicLink()) unlinkSync(link)
    else rmSync(link, { recursive: true, force: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

// S15: links a sibling at .bricks/MAMA, else clones the pinned commit there with the env token,
// else refuses. A failed step removes .bricks/MAMA again, so a half clone is never resolved.
export async function fetchMama(root: string = repoRoot(), print: (line: string) => void = printLine): Promise<MamaSource> {
  const pin = readPins().MAMA
  const link = join(root, '.bricks', 'MAMA')
  const sibling = mamaSibling(root)
  if (sibling) {
    removeLink(link)
    mkdirSync(dirname(link), { recursive: true })
    symlinkSync(relative(dirname(link), sibling), link, 'dir')
    try {
      if (!existsSync(join(sibling, 'node_modules'))) await run('npm', ['ci', '--no-audit', '--no-fund'], sibling, childEnv(), [], print)
    } catch (error) {
      removeLink(link)
      throw error
    }
    return mamaSource(root)
  }
  const token = githubToken()
  if (!token) refuse('bricks', 'MAMA', 'not found; clone Etcito/MAMA next to this repository or set MAMA_TOKEN on the build machine')
  const basic = Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64')
  const secrets = [token, basic]
  const gitEnv = childEnv({ GIT_TERMINAL_PROMPT: '0' })
  const fetchEnv = childEnv({
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
  })
  const url = `https://github.com/${pin.repo}.git`
  removeLink(link)
  mkdirSync(link, { recursive: true })
  try {
    await run('git', ['init', '--quiet'], link, gitEnv, secrets, print)
    await run('git', ['fetch', '--depth', '1', url, pin.commit], link, fetchEnv, secrets, print)
    await run('git', ['checkout', '--quiet', '--detach', 'FETCH_HEAD'], link, gitEnv, secrets, print)
    await run('npm', ['ci', '--no-audit', '--no-fund'], link, childEnv(), secrets, print)
    const source = mamaSource(root)
    if (source.kind !== 'cloned' || source.commit !== pin.commit) {
      refuse('bricks', 'MAMA', `the clone resolves to ${source.kind === 'absent' ? source.reason : `${source.kind} ${source.commit}`}, expected cloned ${pin.commit}; check the pin in ${PIN_FILE}`)
    }
    return source
  } catch (error) {
    removeLink(link)
    throw error
  }
}

// The package exports of file:../uaa are dist/uaa.js and dist/webgpu.js, so a checkout without a
// build cannot be imported. npm ci comes with the build because dist is built from a clean tree.
async function ensureUaaBuilt(dir: string, print: (line: string) => void): Promise<void> {
  const dist = join(dir, 'dist')
  if (existsSync(dist)) return
  await run('npm', ['ci', '--no-audit', '--no-fund'], dir, childEnv(), [], print, {
    brick: 'UAA',
    exitHint: `see its output above, then run npm ci in ${dir} by hand and fix the error`,
  })
  await run('npm', ['run', 'build'], dir, childEnv(), [], print, {
    brick: 'UAA',
    exitHint: `see its output above, then run npm run build in ${dir} by hand and fix the error`,
  })
  if (!existsSync(dist)) {
    refuse('bricks', 'UAA', `npm run build left ${dist} missing; check the build in ${dir} and the exports of its package.json`)
  }
}

// A uaa checkout at the pin is linked as .bricks/UAA. A missing checkout is cloned into ../uaa
// itself, because the game imports it as file:../uaa. Either way a missing dist is built.
export async function fetchUaa(root: string = repoRoot(), print: (line: string) => void = printLine): Promise<UaaSource> {
  const pin = readPins().UAA
  const link = join(root, '.bricks', 'UAA')
  const target = join(dirname(root), 'uaa')
  const sibling = uaaSibling(root)
  if (sibling) {
    const commit = readGitHead(sibling)
    if (commit === null) {
      refuse('bricks', 'UAA', `${sibling} has no readable git HEAD; check out ${pin.repo} at ${pin.commit} there or remove it and run npm run bricks -- fetch uaa`)
    }
    if (commit !== pin.commit) {
      refuse('bricks', 'UAA', `the sibling ${sibling} is at ${commit}, expected the pin ${pin.commit}; check out the pinned commit or update ${PIN_FILE}`)
    }
    removeLink(link)
    mkdirSync(dirname(link), { recursive: true })
    symlinkSync(relative(dirname(link), sibling), link, 'dir')
    try {
      await ensureUaaBuilt(sibling, print)
    } catch (error) {
      removeLink(link)
      throw error
    }
    const source = uaaSource(root)
    if (source.kind === 'absent') refuse('bricks', 'UAA', `${source.reason}; the link to ${sibling} did not resolve`)
    return source
  }
  try {
    if (!lstatSync(target).isDirectory()) {
      refuse('bricks', 'UAA', `${target} is not a directory; remove it or move it aside and run npm run bricks -- fetch uaa`)
    }
  } catch (error) {
    if (isRefusal(error)) throw error
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      refuse('bricks', 'UAA', `cannot inspect ${target} (${error instanceof Error ? error.message : String(error)}); remove it or move it aside and run npm run bricks -- fetch uaa`)
    }
  }
  const token = githubToken()
  if (!token) {
    refuse('bricks', 'UAA', `not found; clone ${pin.repo} next to this repository or set MAMA_TOKEN, GH_TOKEN or GITHUB_TOKEN on the build machine`)
  }
  const basic = Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64')
  const secrets = [token, basic]
  const gitEnv = childEnv({ GIT_TERMINAL_PROMPT: '0' })
  const fetchEnv = childEnv({
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
  })
  const url = `https://github.com/${pin.repo}.git`
  removeLink(link)
  mkdirSync(target, { recursive: true })
  try {
    await run('git', ['init', '--quiet'], target, gitEnv, secrets, print, { brick: 'UAA' })
    await run('git', ['fetch', '--depth', '1', url, pin.commit], target, fetchEnv, secrets, print, {
      brick: 'UAA',
      exitHint: `see its output above, then check the token and the pin in ${PIN_FILE}`,
    })
    await run('git', ['checkout', '--quiet', '--detach', 'FETCH_HEAD'], target, gitEnv, secrets, print, { brick: 'UAA' })
    await ensureUaaBuilt(target, print)
    mkdirSync(dirname(link), { recursive: true })
    removeLink(link)
    symlinkSync(relative(dirname(link), target), link, 'dir')
    return { kind: 'cloned', dir: realpathSync(target), commit: pin.commit }
  } catch (error) {
    removeLink(link)
    rmSync(target, { recursive: true, force: true })
    throw error
  }
}

export interface BrickCheck { ok: boolean; lines: string[] }

// Checks the installed GameSaloon packages: they resolve from the repository, and the Rapier WASM
// initialises. A failure names the install command that fixes it.
export async function checkBricks(): Promise<BrickCheck> {
  const lines: string[] = []
  const fail = (path: string, what: string, fix: string): void => { lines.push(`FAIL [bricks] ${path}: ${what}; ${fix}`) }
  const require = createRequire(join(repoRoot(), 'package.json'))
  const fix = 'run the install (npm install or kong rules + kong use) in the repository root'
  for (const pkg of ['@gamesaloon/rollback', '@gamesaloon/rollback-rapier', '@dimforge/rapier3d-deterministic-compat']) {
    try {
      lines.push(`PASS ${pkg} resolves to ${realpathSync(require.resolve(pkg))}`)
    } catch {
      fail(pkg, 'package does not resolve', fix)
    }
  }
  try {
    const rapier = await import('@gamesaloon/rollback-rapier')
    await rapier.initRapier()
    lines.push('PASS @gamesaloon/rollback-rapier initRapier()')
  } catch (error) {
    fail('@gamesaloon/rollback-rapier', `initRapier() failed: ${error instanceof Error ? error.message : String(error)}`, fix)
  }
  try {
    const pin = readPins().MAMA
    const source = mamaSource()
    if (source.kind === 'absent') lines.push(`INFO ${MAMA_ABSENT_PREFIX}${source.reason}`)
    else if (source.kind === 'cloned') lines.push(`PASS MAMA cloned ${source.dir} at ${source.commit}`)
    else if (source.matchesPin) lines.push(`PASS MAMA sibling ${source.dir} at ${source.commit}`)
    else lines.push(`WARN [bricks] MAMA: sibling ${source.dir} at ${source.commit ?? 'unknown'} differs from the pin ${pin.commit}; fetch the pinned commit or update bricks.pins.json`)
  } catch (error) {
    lines.push(`FAIL ${isRefusal(error) ? error.message : String(error)}`)
  }
  try {
    const raa = raaSource()
    if (raa.kind === 'absent') lines.push(`INFO ${RAA_ABSENT_PREFIX}${raa.reason}`)
    else lines.push(`INFO RAA ${raa.kind} ${raa.dir} at ${raa.commit ?? 'unknown'}; the pinned local channel (RF_RAA_LOCAL is no longer read by fetch or status)`)
  } catch (error) {
    lines.push(`FAIL ${isRefusal(error) ? error.message : String(error)}`)
  }
  return { ok: !lines.some((line) => line.startsWith('FAIL ')), lines }
}

export async function main(argv: string[]): Promise<number> {
  const [command, name] = argv
  try {
    if (command === 'check') {
      const result = await checkBricks()
      for (const line of result.lines) console.log(line)
      return result.ok ? 0 : 1
    }
    if (command === 'where' && name && names.includes(name as BrickName)) {
      const brick = name as BrickName
      if (brick === 'MAMA') {
        const source = mamaSource()
        if (source.kind === 'absent') {
          console.log(`not found: ${source.reason}`)
          return 1
        }
        console.log(source.dir)
        return 0
      }
      const dir = brickDir(brick)
      if (dir === null) {
        console.log('not found')
        return 1
      }
      console.log(dir)
      return 0
    }
    if (command === 'status') {
      const status = brickStatus()
      for (const line of status.lines) console.log(line)
      return status.ok ? 0 : 1
    }
    if (command === 'pins') {
      console.log(JSON.stringify(readPins(), null, 2))
      return 0
    }
    if (command === 'fetch' && name === 'mama') {
      const source = await fetchMama()
      if (source.kind === 'absent') {
        console.log(`${MAMA_ABSENT_PREFIX}${source.reason}`)
        return 1
      }
      console.log(`MAMA ${source.kind} ${source.commit ?? 'unknown'}`)
      if (source.kind === 'sibling' && !source.matchesPin) {
        console.log(`WARN [bricks] MAMA: the sibling differs from the pin ${readPins().MAMA.commit}; check out the pinned commit or update ${PIN_FILE}`)
      }
      return 0
    }
    if (command === 'fetch' && name === 'uaa') {
      const source = await fetchUaa()
      if (source.kind === 'absent') {
        console.log(`${UAA_ABSENT_PREFIX}${source.reason}`)
        return 1
      }
      console.log(`UAA ${source.kind} ${source.commit ?? 'unknown'}`)
      return 0
    }
    if (command === 'fetch' && name === 'raa') {
      const source = await fetchRaa()
      if (source.kind === 'absent') {
        console.log(`${RAA_ABSENT_PREFIX}${source.reason}`)
        return 1
      }
      console.log(`RAA ${source.kind} ${source.commit ?? 'unknown'}`)
      return 0
    }
  } catch (error) {
    if (isRefusal(error)) {
      console.error(error.message)
      return 1
    }
    throw error
  }
  console.error(`usage: npm run bricks -- check | status | where <${names.join('|')}> | fetch mama | fetch uaa | fetch raa | pins`)
  return 1
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (import.meta.url === entry) process.exitCode = await main(process.argv.slice(2))
