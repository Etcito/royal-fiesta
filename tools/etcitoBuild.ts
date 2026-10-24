import { execFileSync, spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { mamaSource, repoRoot } from './bricks.ts'
import { leakScan, redact } from './guard.ts'
import { DEFAULT_OUT as WAVEDASH_OUT, UPLOAD_DIR } from './wavedash.ts'
import { isRefusal, refuse } from '../packages/sim/src/refusal.ts'

// Ported from the V0 M13 build-alone (scripts/fresh-clone-build.sh), on release dependencies: a clean
// checkout of `from` builds the Wavedash bundle with nothing but npm, the MAMA pin and the env token.
// It needs network (npm ci, the MAMA clone), so it runs only from a programmatic card. docs/etcito-build.md.

const TAIL_LINES = 40
const DEFAULT_OUT = 'out/etcito-build'
const USAGE = 'usage: npm run etcito:build -- [--from <git URL or path>] [--out <dir>] [--record <file>]'

// The names githubToken() reads (tools/bricks.ts). Only the bricks step sees them.
const TOKEN_KEYS = ['MAMA_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN']
// Token-like env names whose values are redacted; short values ('1', 'true') would mangle every line.
const SECRET_NAME = /TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH|PROXY/i
const MIN_SECRET_LENGTH = 8
// Release dependencies only: no local RAA, no GameSaloon override, no test seam. RF_BRICKS_DIR stays
// (the MAMA sibling route).
const DROPPED_ENV = ['RF_RAA_LOCAL', 'GAMESALOON_DIR', 'RF_WAVEDASH_DIST', 'RF_PLAY_SKIP_BUILD', 'RF_PLAY_DIST']

// Same shape as the guard's home-path rule, so a removed home path can never hit it.
const HOME_PATH = /(?<![\w.-])(?:\/home\/[A-Za-z0-9._-]+|\/Users\/[A-Za-z0-9._-]+|\/root|[A-Za-z]:(?:\\{1,2}|\/)[Uu]sers(?:\\{1,2}|\/)[^\\/\s'"]+)(?=[\\/])/g
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g
const URL_FORM = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//
const SCP_FORM = /^[^\s/\\@]+@[^\s/\\:]+:/

interface Step { cmd: string; exit: number; tail: string[] }
interface EtcitoBuildRecord { commit: string; mama: { source: 'cloned'; commit: string }; steps: Step[]; bundleFiles: string[] }

function isGitUrl(from: string): boolean {
  return URL_FORM.test(from) || SCP_FORM.test(from)
}

function secrets(from: string): string[] {
  const values = new Set<string>()
  for (const key of TOKEN_KEYS) {
    const token = process.env[key]?.trim()
    if (!token) continue
    values.add(token)
    // the form tools/bricks.ts puts in the git auth header
    values.add(Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64'))
  }
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined || !SECRET_NAME.test(name)) continue
    const trimmed = value.trim()
    if (trimmed.length >= MIN_SECRET_LENGTH) values.add(trimmed)
  }
  const userinfo = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/@]+)@/.exec(from)?.[1]
  if (userinfo) values.add(userinfo)
  return [...values]
}

function childEnv(withToken: boolean): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', NO_COLOR: '1' }
  for (const key of DROPPED_ENV) delete env[key]
  if (!withToken) for (const key of TOKEN_KEYS) delete env[key]
  return env
}

// Exact path replacements, longest first, so <clone> wins over the folders it sits under.
function pathRules(pairs: [string, string][]): [string, string][] {
  const home = homedir()
  const rules: [string, string][] = [...pairs, [home, '~']]
  try {
    rules.push([realpathSync(home), '~'])
  } catch {}
  return rules.filter(([path]) => path.length > 1).sort((a, b) => b[0].length - a[0].length)
}

function sanitizer(rules: readonly [string, string][], hidden: readonly string[]): (line: string) => string {
  return (line) => {
    // the last carriage-return segment is what a terminal would show
    let out = redact(line.replace(/\r$/, '').replace(ANSI, '').split('\r').pop() ?? '', hidden)
    for (const [path, label] of rules) out = out.split(path).join(label)
    return out.replace(HOME_PATH, '~')
  }
}

// Runs one step from an argv array. Output is split into lines before redaction (a secret is never
// cut across chunks) and printed sanitized as it comes; the step keeps the last TAIL_LINES lines.
function runStep(
  command: string, args: readonly string[], cwd: string, opts: { timeoutS: number; withToken: boolean },
  clean: (line: string) => string,
): Promise<Step> {
  const cmd = clean([command, ...args].join(' '))
  process.stderr.write(`$ ${cmd}\n`)
  const lines: string[] = []
  const keep = (raw: string): void => {
    const line = clean(raw)
    lines.push(line)
    if (lines.length > TAIL_LINES * 2) lines.splice(0, lines.length - TAIL_LINES)
    process.stderr.write(`${line}\n`)
  }
  return new Promise((done) => {
    const child = spawn(command, args, {
      cwd, env: childEnv(opts.withToken), stdio: ['ignore', 'pipe', 'pipe'], timeout: opts.timeoutS * 1000,
    })
    const relay = (stream: NodeJS.ReadableStream): void => {
      let pending = ''
      stream.setEncoding('utf8')
      stream.on('data', (chunk: string) => {
        pending += chunk
        const parts = pending.split('\n')
        pending = parts.pop() ?? ''
        for (const part of parts) keep(part)
      })
      stream.on('end', () => {
        if (pending) keep(pending)
        pending = ''
      })
    }
    if (child.stdout) relay(child.stdout)
    if (child.stderr) relay(child.stderr)
    let failure: string | null = null
    child.once('error', (error) => { failure = `[bricks] ${cmd}: ${error.message}; check that ${command} is installed` })
    child.once('close', (code, signal) => {
      if (signal) failure = `[bricks] ${cmd}: stopped by ${signal} (timeout ${opts.timeoutS} s); see the output above`
      else if (!failure && code !== 0) failure = `[bricks] ${cmd}: exited ${code ?? 'abnormally'}; see the output above`
      if (failure) keep(failure)
      while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop()
      const exit = code !== null && code !== 0 ? code : failure ? 1 : 0
      process.stderr.write(`== ${cmd} exit=${exit}\n`)
      done({ cmd, exit, tail: lines.slice(-TAIL_LINES) })
    })
  })
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

const STEP_TIMEOUT_S = { clone: 600, uaa: 1800, ci: 1800, bricks: 1800, build: 1800, pack: 600 } as const

// A path `from` must exist before anything runs, so a typo never reaches git or the network.
function sourceOf(from: string): { arg: string; path: string | null } {
  if (from.trim() === '') refuse('bricks', '--from', 'empty; pass a git URL or the path of a royal-fiesta checkout')
  if (isGitUrl(from)) return { arg: from, path: null }
  const path = resolve(from)
  if (!existsSync(path) || !statSync(path).isDirectory()) {
    refuse('bricks', from, 'not found; pass --from a git URL or the path of an existing royal-fiesta checkout')
  }
  const real = realpathSync(path)
  return { arg: real, path: real }
}

function shown(root: string, path: string): string {
  const rel = relative(root, path)
  return rel === '' ? '.' : rel.startsWith('..') ? path : rel
}

// Replaces only what the pack writes (upload/ and wavedash.toml), never the rest of `out`.
function copyBundle(built: string, out: string): void {
  mkdirSync(out, { recursive: true })
  for (const name of readdirSync(built).sort()) {
    rmSync(join(out, name), { recursive: true, force: true })
    cpSync(join(built, name), join(out, name), { recursive: true })
  }
}

export async function etcitoBuild(opts: { from: string; out: string; record?: string }): Promise<number> {
  const hidden = secrets(opts.from)
  let clean = sanitizer(pathRules([]), hidden)
  let work: string | null = null
  try {
    const root = repoRoot()
    const source = sourceOf(opts.from)
    const out = resolve(opts.out)
    const record = opts.record === undefined ? null : resolve(opts.record)
    work = mkdtempSync(join(realpathSync(tmpdir()), 'rf-etcito-build-'))
    // In its own folder, so the clone's ../MAMA is never a stray $TMPDIR/MAMA.
    const clone = join(work, 'royal-fiesta')
    const linkedWork = join(tmpdir(), basename(work))
    clean = sanitizer(pathRules([
      [clone, '<clone>'], [join(linkedWork, 'royal-fiesta'), '<clone>'], [work, '<work>'], [linkedWork, '<work>'],
      [root, '<repo>'], ...(source.path === null ? [] : [[source.path, '<from>'] as [string, string]]),
    ]), hidden)

    const steps: Step[] = []
    const step = async (command: string, args: readonly string[], cwd: string, timeoutS: number, withToken = false): Promise<boolean> => {
      const result = await runStep(command, args, cwd, { timeoutS, withToken }, clean)
      steps.push(result)
      return result.exit === 0
    }
    const cloneArgs = source.path === null
      ? ['clone', '--quiet', '--depth', '1', source.arg, clone]
      : ['clone', '--quiet', '--no-local', source.arg, clone]
    const ok = await step('git', cloneArgs, work, STEP_TIMEOUT_S.clone)
      && await step('npm', ['run', 'bricks', '--', 'fetch', 'uaa'], clone, STEP_TIMEOUT_S.uaa, true)
      && await step('npm', ['ci'], clone, STEP_TIMEOUT_S.ci)
      && await step('npm', ['run', 'bricks', '--', 'fetch', 'mama'], clone, STEP_TIMEOUT_S.bricks, true)
      && await step('npm', ['run', 'build'], clone, STEP_TIMEOUT_S.build)
      && await step('npm', ['run', 'wavedash', '--', '--skip-build'], clone, STEP_TIMEOUT_S.pack)
    if (!ok) {
      console.error(clean(`[bricks] ${steps[steps.length - 1].cmd}: the Etcito build stopped here; fix the step from its output above, then run again`))
      return 1
    }

    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: clone, encoding: 'utf8' }).trim()
    const mama = mamaSource(clone)
    copyBundle(join(clone, WAVEDASH_OUT), out)
    const bundleFiles = listFiles(join(out, UPLOAD_DIR))
    const mamaText = mama.kind === 'absent' ? 'absent' : `${mama.kind} ${mama.commit ?? 'unknown'}`
    console.log(clean(`etcito-build: commit ${commit} mama ${mamaText} files=${bundleFiles.length} out=${shown(root, out)}`))
    if (record === null) {
      console.log('etcito-build: PASS')
      return 0
    }

    // S17 records a GitHub clone at the pin: a sibling build proves nothing about the build machine.
    if (mama.kind !== 'cloned') {
      refuse('bricks', opts.record ?? '', `MAMA resolved as ${mama.kind}, the record needs the GitHub clone at the pin; unset RF_BRICKS_DIR, set MAMA_TOKEN and run again`)
    }
    const doc: EtcitoBuildRecord = { commit, mama: { source: 'cloned', commit: mama.commit }, steps, bundleFiles }
    const text = redact(`${JSON.stringify(doc, null, 2)}\n`, hidden)
    const hits = leakScan(text, hidden)
    if (hits.length > 0) {
      for (const hit of hits) console.error(clean(`[guard] ${opts.record}: leakScan ${hit.pattern} at ${hit.index}: ${hit.excerpt}`))
      console.error(clean(`[guard] ${opts.record}: not written (${hits.length} leak hit(s)); fix the output that leaks, then run again`))
      return 1
    }
    mkdirSync(dirname(record), { recursive: true })
    writeFileSync(record, text)
    console.log(clean(`etcito-build: ${shown(root, record)} written`))
    console.log('etcito-build: PASS')
    return 0
  } catch (error) {
    if (isRefusal(error)) console.error(clean(error.message))
    else console.error(clean(`[bricks] etcito-build: ${error instanceof Error ? error.message : String(error)}; see the output above`))
    return 1
  } finally {
    if (work !== null) rmSync(work, { recursive: true, force: true, maxRetries: 3 })
  }
}

function parseArgs(argv: string[]): { from: string; out: string; record?: string } {
  const opts: { from: string; out: string; record?: string } = { from: '.', out: DEFAULT_OUT }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const value = (): string => {
      const next = argv[++i]
      if (next === undefined || next.startsWith('--')) throw new Error(`missing value for ${arg}`)
      return next
    }
    if (arg === '--from') opts.from = value()
    else if (arg === '--out') opts.out = value()
    else if (arg === '--record') opts.record = value()
    else throw new Error(`unknown option ${arg}`)
  }
  return opts
}

export async function main(argv: string[]): Promise<number> {
  let opts: { from: string; out: string; record?: string }
  try {
    opts = parseArgs(argv)
  } catch (error) {
    console.error(`etcito-build: ${error instanceof Error ? error.message : String(error)}`)
    console.error(USAGE)
    return 1
  }
  return etcitoBuild(opts)
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (import.meta.url === entry) process.exitCode = await main(process.argv.slice(2))
