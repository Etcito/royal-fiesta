import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { githubToken, repoRoot } from './bricks.ts'
import { leakScan, redact } from './guard.ts'

// QB13: clones HEAD into a temporary directory, runs `npm ci` and `npm run play -- --check` there,
// and writes the S17 record proofs/m15/clean-clone.json. It needs network (npm ci), so it runs only
// from a programmatic card.

const PLAY_URL = 'http://localhost:5173/game.html'
const TAIL_LINES = 40
const USAGE = 'usage: node --experimental-strip-types tools/cleanClone.ts --out <file>'

// Token-like env names whose values are redacted. Short values ('1', 'true') are kept, since
// replacing them would mangle every line.
const SECRET_NAME = /TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH|PROXY/i
const MIN_SECRET_LENGTH = 8
const TOKEN_KEYS = ['MAMA_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN']
// A clean clone uses the public path only: no token, no sibling override, no test seam.
const DROPPED_ENV = [...TOKEN_KEYS, 'RF_PLAY_SKIP_BUILD', 'RF_PLAY_DIST', 'RF_RAA_LOCAL', 'RF_BRICKS_DIR', 'GAMESALOON_DIR']

const STEP_TIMEOUT_S = { clone: 600, ci: 1800, play: 1200 } as const

// Same shape as the guard's home-path rule, so a removed home path can never hit it.
const HOME_PATH = /(?<![\w.-])(?:\/home\/[A-Za-z0-9._-]+|\/Users\/[A-Za-z0-9._-]+|\/root|[A-Za-z]:(?:\\{1,2}|\/)[Uu]sers(?:\\{1,2}|\/)[^\\/\s'"]+)(?=[\\/])/g
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g

interface Step { cmd: string; exit: number; tail: string[] }
interface CleanCloneRecord { commit: string; steps: Step[]; playUrl: string; httpStatus: number | null }

function secrets(): string[] {
  const values = new Set<string>()
  const token = githubToken()
  if (token) values.add(token)
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined || !SECRET_NAME.test(name)) continue
    const trimmed = value.trim()
    if (trimmed.length >= MIN_SECRET_LENGTH) values.add(trimmed)
  }
  return [...values]
}

function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', NO_COLOR: '1' }
  for (const key of DROPPED_ENV) delete env[key]
  return env
}

// Exact path replacements, longest first, so <clone> wins over a home it may sit under.
function pathRules(root: string, clone: string, linkedClone: string): [string, string][] {
  const rules: [string, string][] = [[clone, '<clone>'], [linkedClone, '<clone>'], [root, '<repo>']]
  const home = homedir()
  rules.push([home, '~'])
  try {
    rules.push([realpathSync(home), '~'])
  } catch {}
  return rules
    .filter(([from]) => from.length > 1)
    .sort((a, b) => b[0].length - a[0].length)
}

function sanitizer(rules: readonly [string, string][], hidden: readonly string[]): (line: string) => string {
  return (line) => {
    // the last carriage-return segment is what a terminal would show
    let out = redact(line.replace(/\r$/, '').replace(ANSI, '').split('\r').pop() ?? '', hidden)
    for (const [from, to] of rules) out = out.split(from).join(to)
    return out.replace(HOME_PATH, '~')
  }
}

// Runs one step from an argv array. Output is kept line by line (so a secret is never split
// across chunks before redaction) and printed sanitized as it comes.
function runStep(
  command: string, args: readonly string[], cwd: string, timeoutS: number, clean: (line: string) => string,
): Promise<{ step: Step; lines: string[] }> {
  const cmd = clean([command, ...args].join(' '))
  process.stderr.write(`$ ${cmd}\n`)
  const lines: string[] = []
  const keep = (raw: string): void => {
    const line = clean(raw)
    lines.push(line)
    process.stderr.write(`${line}\n`)
  }
  return new Promise((done) => {
    const child = spawn(command, args, { cwd, env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutS * 1000 })
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
    child.once('error', (error) => { failure = `[clean-clone] ${cmd}: ${error.message}; check that ${command} is installed` })
    child.once('close', (code, signal) => {
      if (signal) failure = `[clean-clone] ${cmd}: stopped by ${signal} (timeout ${timeoutS} s); see the output above`
      if (failure) keep(failure)
      while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop()
      const exit = code !== null && code !== 0 ? code : failure ? 1 : (code ?? 1)
      done({ step: { cmd, exit, tail: lines.slice(-TAIL_LINES) }, lines })
    })
  })
}

// 200 when the check passed; otherwise the first non-200 status the check printed, if any.
function httpStatusOf(play: { step: Step; lines: string[] } | null): number | null {
  if (play === null) return null
  if (play.step.exit === 0) return 200
  for (const line of play.lines) {
    const match = /^play: GET \/\S+ (\d+)$/.exec(line.trim())
    if (match && match[1] !== '200') return Number(match[1])
  }
  return null
}

function headCommit(root: string): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
}

// The clone checks out the source's HEAD; a mismatch fails the clone step instead of testing
// another commit.
function verifyHead(clone: string, commit: string): string | null {
  try {
    const head = headCommit(clone)
    return head === commit ? null : `[clean-clone] <clone>: HEAD is ${head}, expected ${commit}; commit the work to test, then run again`
  } catch (error) {
    return `[clean-clone] <clone>: git rev-parse HEAD failed (${error instanceof Error ? error.message : String(error)}); check the clone output above`
  }
}

export async function cleanClone(outFile: string): Promise<number> {
  const root = repoRoot()
  const out = resolve(outFile)
  const commit = headCommit(root)
  const hidden = secrets()
  const clone = mkdtempSync(join(realpathSync(tmpdir()), 'rf-clean-clone-'))
  const clean = sanitizer(pathRules(root, clone, join(tmpdir(), basename(clone))), hidden)
  const steps: Step[] = []
  let play: { step: Step; lines: string[] } | null = null
  try {
    const cloned = await runStep('git', ['clone', '--no-local', root, clone], root, STEP_TIMEOUT_S.clone, clean)
    if (cloned.step.exit === 0) {
      const mismatch = verifyHead(clone, commit)
      if (mismatch !== null) {
        process.stderr.write(`${clean(mismatch)}\n`)
        cloned.step.exit = 1
        cloned.step.tail = [...cloned.step.tail, clean(mismatch)].slice(-TAIL_LINES)
      }
    }
    steps.push(cloned.step)
    if (cloned.step.exit === 0) {
      const ci = await runStep('npm', ['ci'], clone, STEP_TIMEOUT_S.ci, clean)
      steps.push(ci.step)
      if (ci.step.exit === 0) {
        play = await runStep('npm', ['run', 'play', '--', '--check'], clone, STEP_TIMEOUT_S.play, clean)
        steps.push(play.step)
      }
    }
  } finally {
    rmSync(clone, { recursive: true, force: true, maxRetries: 3 })
  }

  const record: CleanCloneRecord = { commit, steps, playUrl: PLAY_URL, httpStatus: httpStatusOf(play) }
  const text = redact(`${JSON.stringify(record, null, 2)}\n`, hidden)
  const hits = leakScan(text, hidden)
  if (hits.length > 0) {
    for (const hit of hits) console.error(`[clean-clone] ${outFile}: leakScan ${hit.pattern} at ${hit.index}: ${hit.excerpt}`)
    console.error(`[clean-clone] ${outFile}: not written (${hits.length} leak hit(s)); fix the output that leaks, then run again`)
    return 1
  }
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, text)
  const pass = steps.length === 3 && steps.every((step) => step.exit === 0) && record.httpStatus === 200
  console.log(`clean-clone: ${outFile} written (commit ${commit.slice(0, 12)}, httpStatus ${record.httpStatus})`)
  console.log(`clean-clone: ${pass ? 'PASS' : 'FAIL'}`)
  return pass ? 0 : 1
}

function parseArgs(argv: string[]): string {
  let out: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--out') {
      out = argv[++i]
      if (out === undefined || out.startsWith('--')) throw new Error('missing value for --out')
    } else if (arg.startsWith('--out=')) out = arg.slice('--out='.length)
    else throw new Error(`unknown option ${arg}`)
  }
  if (!out) throw new Error('missing --out <file>')
  return out
}

async function main(argv: string[]): Promise<number> {
  let out: string
  try {
    out = parseArgs(argv)
  } catch (error) {
    console.error(`clean-clone: ${error instanceof Error ? error.message : String(error)}`)
    console.error(USAGE)
    return 1
  }
  try {
    return await cleanClone(out)
  } catch (error) {
    console.error(redact(`clean-clone: ${error instanceof Error ? error.message : String(error)}`, secrets()))
    return 1
  }
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (import.meta.url === entry) process.exitCode = await main(process.argv.slice(2))
