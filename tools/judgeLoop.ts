// AI media judge loop: runs the judge client on one picture with up to 3 attempts, stopping at the first
// pass. A run of three reds is accepted as 'accepted-after-3-red'. The JSON record goes to out/s3/judge/
// and the CLI prints one summary line. Env values and tokens are never printed.
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isRefusal, refuse } from '../packages/sim/src/refusal.ts'
import { repoRoot } from './bricks.ts'

const AREA = 'judge'
const ATTEMPTS = 3
const DEFAULT_MIN_SCORE = 6
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/
const OUT_DIR = ['out', 's3', 'judge']

export interface JudgeAttempt { score: number | null; pass: boolean; output: string }
export interface JudgeOutcome {
  name: string
  picture: string
  attempts: JudgeAttempt[]
  accepted: 'pass' | 'accepted-after-3-red'
}

export interface JudgeOptions {
  aspect?: 'design'
  minScore?: number
  run?: (args: string[]) => Promise<{ code: number; out: string }>
  root?: string
}

// The judge client reports "JUDGE PASS: 8.0/10 (minimum 6.0)"; a bare "score: 8" is accepted too.
export function parseScore(output: string): number | null {
  const ofTen = /(\d+(?:\.\d+)?)\s*\/\s*10(?:\b|$)/.exec(output)
  if (ofTen) return Number(ofTen[1])
  const named = /score\s*[:=]?\s*(\d+(?:\.\d+)?)/i.exec(output)
  return named ? Number(named[1]) : null
}

function clientPath(): string {
  const value = process.env.NMC_JUDGE_CLIENT
  if (value === undefined || value.trim().length === 0) {
    return refuse(AREA, 'NMC_JUDGE_CLIENT', 'is unset; fix by running this where the judge client is attached')
  }
  return value
}

function judgeArgs(picture: string, description: string, aspect: string | undefined, minScore: number): string[] {
  const args = [picture, '--description', description]
  if (aspect !== undefined) args.push('--aspect', aspect)
  args.push('--min-score', String(minScore))
  return args
}

function defaultRun(client: string): (args: string[]) => Promise<{ code: number; out: string }> {
  return args => new Promise((done, reject) => {
    const child = spawn('python3', [client, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout?.on('data', (chunk: Buffer) => { out += chunk.toString('utf8') })
    child.stderr?.on('data', (chunk: Buffer) => { out += chunk.toString('utf8') })
    child.once('error', reject)
    child.once('close', code => done({ code: code ?? 1, out }))
  })
}

export async function judgeLoop(
  name: string,
  picture: string,
  description: string,
  o?: JudgeOptions,
): Promise<JudgeOutcome> {
  if (picture === undefined || picture.trim().length === 0) {
    refuse(AREA, 'picture', 'is missing or empty; fix the call to pass the picture to judge')
  }
  if (!NAME_RE.test(name)) {
    refuse(AREA, 'name', `is ${JSON.stringify(name)}, not a file-safe name; fix it to match ${NAME_RE.source}`)
  }
  const minScore = o?.minScore ?? DEFAULT_MIN_SCORE
  const run = o?.run ?? defaultRun(clientPath())
  const attempts: JudgeAttempt[] = []
  let accepted: JudgeOutcome['accepted'] = 'accepted-after-3-red'
  for (let i = 0; i < ATTEMPTS; i++) {
    const result = await run(judgeArgs(picture, description, o?.aspect, minScore))
    const attempt: JudgeAttempt = { score: parseScore(result.out), pass: result.code === 0, output: result.out }
    attempts.push(attempt)
    if (attempt.pass) {
      accepted = 'pass'
      break
    }
  }
  const outcome: JudgeOutcome = { name, picture, attempts, accepted }
  const dir = join(o?.root ?? repoRoot(), ...OUT_DIR)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${name}.json`), `${JSON.stringify(outcome, null, 2)}\n`)
  const scores = attempts.map(attempt => (attempt.score === null ? 'none' : String(attempt.score))).join(', ')
  console.log(`[judge] ${name}: ${accepted} (scores ${scores})`)
  return outcome
}

interface CliArgs {
  name: string
  picture: string
  description: string
  aspect?: 'design'
  minScore?: number
}

export function parseArgv(argv: string[]): CliArgs {
  const name = argv[0]
  const picture = argv[1]
  if (name === undefined || name.length === 0 || picture === undefined || picture.length === 0) {
    refuse(AREA, 'argv', 'takes <name> <picture> --description "<text>" [--aspect design] [--min-score 6]')
  }
  let description: string | undefined
  let aspect: 'design' | undefined
  let minScore: number | undefined
  for (let i = 2; i < argv.length; i++) {
    const flag = argv[i]
    const value = argv[i + 1]
    if (flag !== '--description' && flag !== '--aspect' && flag !== '--min-score') {
      refuse(AREA, 'argv', `has unknown argument ${JSON.stringify(flag)}; fix it to --description, --aspect or --min-score`)
    }
    if (value === undefined) refuse(AREA, `argv/${flag}`, 'needs a value')
    i++
    if (flag === '--description') description = value
    else if (flag === '--aspect') {
      if (value !== 'design') refuse(AREA, 'argv/--aspect', `is ${JSON.stringify(value)}, not 'design'`)
      aspect = 'design'
    } else {
      const n = Number(value)
      if (!Number.isFinite(n)) refuse(AREA, 'argv/--min-score', `is ${JSON.stringify(value)}, not a number`)
      minScore = n
    }
  }
  if (description === undefined) refuse(AREA, 'argv/--description', 'is missing; fix the call to say what the picture must show')
  return { name, picture, description, ...(aspect === undefined ? {} : { aspect }), ...(minScore === undefined ? {} : { minScore }) }
}

export async function main(argv: string[]): Promise<number> {
  try {
    const args = parseArgv(argv)
    await judgeLoop(args.name, args.picture, args.description, { aspect: args.aspect, minScore: args.minScore })
    return 0
  } catch (e) {
    if (!isRefusal(e)) throw e
    console.log(`[judge] failed: ${e.message}`)
    return 1
  }
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (import.meta.url === entry) process.exitCode = await main(process.argv.slice(2))
