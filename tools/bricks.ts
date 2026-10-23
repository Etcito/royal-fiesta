import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import {
  existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync,
} from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { isRefusal, refuse } from '../packages/sim/src/refusal.ts'

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

// The one pin table (S15). Only MAMA is pinned; everything else is a release dependency.
export function readPins(file?: string): { MAMA: BrickPin } {
  const path = file ?? join(repoRoot(), PIN_FILE)
  const label = basename(path)
  const pointer = (field?: string): string => `${label}#/MAMA${field ? `/${field}` : ''}`
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    refuse('bricks', label, 'missing; add bricks.pins.json with {"MAMA":{"repo":"Etcito/MAMA","commit":"<40 hex>"}}')
  }
  let document: unknown
  try {
    document = JSON.parse(text)
  } catch (error) {
    refuse('bricks', label, `not valid JSON (${error instanceof Error ? error.message : String(error)}); fix the pins file`)
  }
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    refuse('bricks', label, 'must be an object with only the MAMA key; fix the pins file')
  }
  const record = document as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (key !== 'MAMA') refuse('bricks', `${label}#/${key}`, 'unknown brick; the only pin is MAMA; remove it')
  }
  const mama = record.MAMA
  if (!mama || typeof mama !== 'object' || Array.isArray(mama)) {
    refuse('bricks', pointer(), 'missing or not an object; add {"repo":"Etcito/MAMA","commit":"<40 hex>"}')
  }
  const pin = mama as Record<string, unknown>
  for (const key of Object.keys(pin)) {
    if (key !== 'repo' && key !== 'commit') refuse('bricks', pointer(key), 'unknown field; keep only repo and commit')
  }
  if (typeof pin.repo !== 'string' || !REPO_PATTERN.test(pin.repo)) {
    refuse('bricks', pointer('repo'), `expected owner/name, got ${JSON.stringify(pin.repo)}; fix the pin in ${label}`)
  }
  if (typeof pin.commit !== 'string' || !COMMIT_PATTERN.test(pin.commit)) {
    refuse('bricks', pointer('commit'), `expected 40 lowercase hex, got ${JSON.stringify(pin.commit)}; fix the pin in ${label}`)
  }
  return { MAMA: { repo: pin.repo, commit: pin.commit } }
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
  const candidates = [
    ...(process.env.RF_BRICKS_DIR ? [join(process.env.RF_BRICKS_DIR, 'MAMA')] : []),
    join(dirname(root), 'MAMA'),
  ]
  for (const candidate of candidates) {
    try {
      if (!existsSync(candidate) || !statSync(candidate).isDirectory()) continue
    } catch {
      continue
    }
    const dir = realpathSync(candidate)
    const commit = readGitHead(dir)
    return { kind: 'sibling', dir, commit, matchesPin: commit !== null && commit === pins.commit }
  }
  return { kind: 'absent', reason: `no .bricks/MAMA, no $RF_BRICKS_DIR/MAMA or ../MAMA; clone ${pins.repo} next to this repository or run npm run bricks -- fetch mama` }
}

// MAMA_TOKEN, else GH_TOKEN, else GITHUB_TOKEN. The value is never printed.
export function githubToken(): string | null {
  for (const key of ['MAMA_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'] as const) {
    const value = process.env[key]?.trim()
    if (value) return value
  }
  return null
}

export function raaLocal(): { active: boolean; dir: string | null } {
  if (process.env.RF_RAA_LOCAL !== '1') return { active: false, dir: null }
  const dir = brickDir('raa')
  return { active: dir !== null, dir }
}

function redactText(text: string, secrets: readonly string[]): string {
  let out = text
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join('[redacted]')
  }
  return out
}

function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, secrets: readonly string[]): string {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 600000 })
  const output = redactText(`${result.stdout ?? ''}${result.stderr ?? ''}`, secrets).trim()
  const tail = output ? `: ${output.split('\n').slice(-6).join('\n')}` : ''
  if (result.error) {
    refuse('bricks', 'MAMA', `${command} failed (${redactText(result.error.message, secrets)}); check the token and the pins commit${tail}`)
  }
  if (result.status !== 0) {
    refuse('bricks', 'MAMA', `${command} ${args[0] ?? ''} exited ${result.status ?? 'on a signal'}; check the token and the pins commit${tail}`)
  }
  return output
}

function removeLink(link: string): void {
  try {
    if (lstatSync(link).isSymbolicLink()) unlinkSync(link)
    else rmSync(link, { recursive: true, force: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

// Links or clones MAMA below .bricks/MAMA and installs it when node_modules is missing.
export async function fetchMama(): Promise<MamaSource> {
  const root = repoRoot()
  const pins = readPins()
  const link = join(root, '.bricks', 'MAMA')
  mkdirSync(dirname(link), { recursive: true })
  const sibling = brickDir('MAMA')
  if (sibling) {
    removeLink(link)
    symlinkSync(relative(dirname(link), sibling), link, 'dir')
    if (!existsSync(join(sibling, 'node_modules'))) run('npm', ['ci', '--no-audit', '--no-fund'], sibling, process.env, [])
    return mamaSource()
  }
  const token = githubToken()
  if (!token) refuse('bricks', 'MAMA', 'not found; clone Etcito/MAMA next to this repository or set MAMA_TOKEN on the build machine')
  removeLink(link)
  mkdirSync(link, { recursive: true })
  const url = `https://github.com/${pins.MAMA.repo}.git`
  const auth = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: auth,
    GIT_TERMINAL_PROMPT: '0',
  }
  // The auth header is the only place the token reaches a child; the env vars are removed.
  delete env.MAMA_TOKEN
  delete env.GH_TOKEN
  delete env.GITHUB_TOKEN
  const secrets = [token, auth, auth.slice('AUTHORIZATION: basic '.length)]
  run('git', ['init', '--quiet'], link, env, secrets)
  run('git', ['fetch', '--depth', '1', url, pins.MAMA.commit], link, env, secrets)
  run('git', ['checkout', '--quiet', '--detach', 'FETCH_HEAD'], link, env, secrets)
  if (!existsSync(join(link, 'node_modules'))) run('npm', ['ci', '--no-audit', '--no-fund'], link, env, secrets)
  const commit = readGitHead(link)
  if (commit === null) refuse('bricks', 'MAMA', `cloned ${url} but its HEAD is unreadable; check the pin`)
  return { kind: 'cloned', dir: realpathSync(link), commit }
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
  const raa = raaLocal()
  lines.push(raa.active
    ? `WARN RF_RAA_LOCAL=1: local RAA override active from ${raa.dir}`
    : 'INFO RF_RAA_LOCAL is off; using the release @etcito/raa')
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
    if (command === 'pins') {
      console.log(JSON.stringify(readPins(), null, 2))
      return 0
    }
    if (command === 'fetch' && name === 'mama') {
      const source = await fetchMama()
      if (source.kind === 'absent') {
        console.log(`MAMA absent: ${source.reason}`)
        return 1
      }
      console.log(`MAMA ${source.kind}: ${source.dir} at ${source.commit}`)
      return 0
    }
  } catch (error) {
    if (isRefusal(error)) {
      console.error(error.message)
      return 1
    }
    throw error
  }
  console.error(`usage: npm run bricks -- check | where <${names.join('|')}> | fetch mama | pins`)
  return 1
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (import.meta.url === entry) process.exitCode = await main(process.argv.slice(2))
