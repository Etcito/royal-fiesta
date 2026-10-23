import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import {
  existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync,
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

const TOKEN_KEYS = ['MAMA_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'] as const

// MAMA_TOKEN, else GH_TOKEN, else GITHUB_TOKEN. The value is never printed.
export function githubToken(): string | null {
  for (const key of TOKEN_KEYS) {
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

// Children never see the token variables; only `git fetch` gets the auth header (extra).
function childEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra }
  for (const key of TOKEN_KEYS) delete env[key]
  return env
}

function printLine(line: string): void {
  process.stderr.write(`${line}\n`)
}

// Runs one child from an argv array. Its stdout and stderr are printed line by line, each line
// redacted first, so a secret never reaches the terminal or a transcript.
function run(
  command: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv,
  secrets: readonly string[], print: (line: string) => void,
): Promise<void> {
  const step = `${command} ${args[0] ?? ''}`.trim()
  print(redact(`$ ${[command, ...args].join(' ')}`, secrets))
  return new Promise((done, fail) => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 600000 })
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
      fail(new RefusalError('bricks', 'MAMA', `${step} failed (${redact(error.message, secrets)}); check that ${command} is installed`))
    })
    child.on('close', (code, signal) => {
      if (code === 0) done()
      else fail(new RefusalError('bricks', 'MAMA', `${step} exited ${code ?? signal ?? 'abnormally'}; see its output above, then check the token and the pin in ${PIN_FILE}`))
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
  if (raa.active) lines.push(`WARN RF_RAA_LOCAL=1: local RAA override active from ${raa.dir}`)
  else if (process.env.RF_RAA_LOCAL === '1') lines.push('INFO RF_RAA_LOCAL=1 but no raa brick ($RF_BRICKS_DIR/raa or ../raa); using the release @etcito/raa')
  else lines.push('INFO RF_RAA_LOCAL is off; using the release @etcito/raa')
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
        console.log(`${MAMA_ABSENT_PREFIX}${source.reason}`)
        return 1
      }
      console.log(`MAMA ${source.kind} ${source.commit ?? 'unknown'}`)
      if (source.kind === 'sibling' && !source.matchesPin) {
        console.log(`WARN [bricks] MAMA: the sibling differs from the pin ${readPins().MAMA.commit}; check out the pinned commit or update ${PIN_FILE}`)
      }
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
