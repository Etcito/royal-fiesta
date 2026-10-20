// `rf match`: run one offline match (bots by default), write the S6 log and print a round summary.
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { initRapier } from '@gamesaloon/rollback-rapier'
import type { ProfileName, ResolvedCourse } from '@royal-fiesta/sim/course'
import { matchLogJson } from '@royal-fiesta/sim/match/log'
import { runMatchOffline } from '@royal-fiesta/sim/match/offline'
import type { OfflineOptions } from '@royal-fiesta/sim/match/offline'
import type { MatchSetup } from '@royal-fiesta/sim/match/setup'
import { isRefusal, refuse } from '@royal-fiesta/sim/refusal'
import { MAX_PLAYERS } from '@royal-fiesta/sim/world'
import { loadAllCourses, repoPath } from './files.ts'
import { hex8, outDir } from './proofkit.ts'

const USAGE = 'usage: rf match --seed <u32> --profile sprint|standard [--humans N] [--rollback every,back[,fresh]] [--out <path>]'
const MATCH_KINDS = ['race', 'survival'] as const

interface MatchArgs {
  seed: number
  profile: ProfileName
  humans: number
  rollback: { every: number; back: number; fresh: boolean } | null
  out: string | null
}

function bad(flag: string, reason: string): never {
  refuse('cli', flag, `${reason}; ${USAGE}`)
}

function parseUint(flag: string, text: string, max: number): number {
  if (!/^\d+$/.test(text)) bad(flag, `'${text}' is not a non-negative integer`)
  const v = Number(text)
  if (v > max) bad(flag, `${v} is above ${max}`)
  return v
}

function parseRollback(text: string): { every: number; back: number; fresh: boolean } {
  const parts = text.split(',')
  if (parts.length < 2 || parts.length > 3 || (parts.length === 3 && parts[2] !== 'fresh')) {
    bad('--rollback', `'${text}' is not every,back or every,back,fresh`)
  }
  const every = parseUint('--rollback', parts[0], 0xffffffff)
  const back = parseUint('--rollback', parts[1], 0xffffffff)
  if (every < 1 || back < 1) bad('--rollback', `every and back must be >= 1, got ${every},${back}`)
  return { every, back, fresh: parts.length === 3 }
}

function parseMatchArgs(argv: string[]): MatchArgs {
  const values = new Map<string, string>()
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i]
    if (!['--seed', '--profile', '--humans', '--rollback', '--out'].includes(flag)) bad(flag, 'unknown argument')
    if (values.has(flag)) bad(flag, 'given twice')
    const v = argv[i + 1]
    if (v === undefined || v.startsWith('--')) bad(flag, 'missing value')
    values.set(flag, v)
  }
  const seedText = values.get('--seed')
  if (seedText === undefined) bad('--seed', 'required')
  const profile = values.get('--profile')
  if (profile === undefined) bad('--profile', 'required')
  if (profile !== 'sprint' && profile !== 'standard') bad('--profile', `unknown profile '${profile}'`)
  const humansText = values.get('--humans')
  const rollbackText = values.get('--rollback')
  return {
    seed: parseUint('--seed', seedText, 0xffffffff),
    profile,
    humans: humansText === undefined ? 0 : parseUint('--humans', humansText, MAX_PLAYERS),
    rollback: rollbackText === undefined ? null : parseRollback(rollbackText),
    out: values.get('--out') ?? null,
  }
}

// Same rule and message as game/courseSet matchCourses, applied to the already-loaded fixtures.
function filterMatchCourses(all: ResolvedCourse[], profile: ProfileName): ResolvedCourse[] {
  const courses = all.filter(c => (c.kind === 'race' || c.kind === 'survival') && c.profiles.includes(profile))
  for (const kind of MATCH_KINDS) {
    if (!courses.some(c => c.kind === kind)) {
      refuse('course', 'courses', `no ${kind} course for profile '${profile}'; add a ${kind} course whose profiles include '${profile}'`)
    }
  }
  return courses
}

async function runMatch(argv: string[]): Promise<void> {
  const args = parseMatchArgs(argv)
  const courses = filterMatchCourses(await loadAllCourses(), args.profile)
  const playerCount = 8
  const humans: boolean[] = []
  for (let p = 0; p < playerCount; p++) humans.push(p < args.humans)
  const setup: MatchSetup = { seed: args.seed, playerCount, humans, profile: args.profile, courses }
  const outFile = args.out === null ? path.join(outDir('m4'), `match-${args.seed}.json`) : repoPath(args.out)

  const R = await initRapier()
  const opts: OfflineOptions = {}
  if (args.rollback !== null) opts.forcedRollback = args.rollback
  const result = runMatchOffline(R, setup, opts)

  await mkdir(path.dirname(outFile), { recursive: true })
  await writeFile(outFile, matchLogJson(result.log))
  const log = result.log
  for (const r of log.rounds) {
    console.log(`round ${r.index} ${r.kind} ${r.course} ${r.reason} qualified=[${r.qualified.join(',')}] eliminated=[${r.eliminated.join(',')}]`)
  }
  let last = `winner ${log.winner} podium [${log.podium.join(',')}] finalHash ${hex8(result.finalHash)} ticks ${result.ticks}`
  if (args.rollback !== null) last += ` rollbacks ${result.rollbacks}`
  console.log(last)
}

async function main(argv: string[]): Promise<number> {
  try {
    const [command, ...rest] = argv
    if (command !== 'match') bad(command ?? '(none)', 'unknown command')
    await runMatch(rest)
    return 0
  } catch (e) {
    if (!isRefusal(e)) throw e
    console.error(e.message)
    return 1
  }
}

process.exitCode = await main(process.argv.slice(2))
