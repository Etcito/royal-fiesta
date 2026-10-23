// Ported V0 M11 proof (docs/v0-port.md). The V0 local.html page, LocalMatch and the asset store
// are not on main: the GPU checks run the game.html gameCapture op and the client frameTiming op,
// RAA is the @etcito/raa release (no RAA build step) and the v0 content reads fixtures/assets.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { initRapier } from '@gamesaloon/rollback-rapier'
import { Pilot } from '@royal-fiesta/game/net/pilot'
import { neutralInput } from '@royal-fiesta/sim/input'
import type { PlayerInput } from '@royal-fiesta/sim/input'
import { matchLogJson } from '@royal-fiesta/sim/match/log'
import { createMatchSim, Phase } from '@royal-fiesta/sim/match/matchSim'
import type { MatchSim, MatchViewState } from '@royal-fiesta/sim/match/matchSim'
import type { MatchSetup } from '@royal-fiesta/sim/match/setup'
import { refuse } from '@royal-fiesta/sim/refusal'
import { raaLocal, repoRoot } from '../../../tools/bricks.ts'
import { loadAllCourses } from '../src/files.ts'
import { publishDist, renderOp } from '../src/gpuClient.ts'
import { decodePng, unwrapOp } from '../src/gpuRecord.ts'
import type { CapturesRecord, CaptureEntry, OpResult } from '../src/gpuRecord.ts'
import { parseProofArgs, report, runProof, spawnCases } from '../src/proofkit.ts'
import type { CheckResult, ProofArgs, ProofCheck } from '../src/proofkit.ts'

const root = repoRoot()
const out = join(root, 'out/m11')
const timingFile = join(out, 'frame-timing-result.json')
const gpuFile = join(out, 'gpu-result.json')
const pageRefFile = join(out, 'page-ref.txt')
const dist = join(root, 'apps/web/dist')
const pageFile = join(dist, 'game.html')
const gpuConfig = join(dist, 'nmc.gpu.json')
const raaPackage = join(root, 'node_modules/@etcito/raa/package.json')
const capturesFile = join(root, 'proofs/m11/captures.json')
const WIDTH = 1920
const HEIGHT = 1080
// One in-page client with bots, from the loading screen to the podium (gameCapture moments, flow order).
const CAPTURE_AT = ['loading', 'match-5s', 'match-10s', 'match-15s', 'match-20s', 'podium']
const started = performance.now()

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function npmRun(args: string[]): Promise<{ code: number; tail: string }> {
  return new Promise(resolve => {
    const child = spawn('npm', args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
    let tail = ''
    const keep = (chunk: Buffer) => { tail = (tail + chunk.toString()).slice(-4000) }
    child.stdout.on('data', keep)
    child.stderr.on('data', keep)
    child.on('error', e => resolve({ code: -1, tail: `${tail}\n${e.message}` }))
    child.on('close', code => resolve({ code: code ?? -1, tail }))
  })
}

async function build(): Promise<{ code: number; tail: string }> {
  const primary = await npmRun(['run', 'web:build'])
  if (primary.code === 0 || !primary.tail.includes('node_modules/.vite-temp')) return primary
  // The managed worktree cannot write Vite's bundled config cache under node_modules.
  return await npmRun(['run', 'build', '-w', '@royal-fiesta/web', '--', '--configLoader', 'runner'])
}

// The web build imports the @etcito/raa release installed by npm install (no RAA build step).
function ensureRaaRelease(): void {
  if (!existsSync(raaPackage)) {
    console.error('[raa] @etcito/raa is not installed; run npm install from the repository root and rerun')
    process.exit(1)
  }
  const version = object(JSON.parse(readFileSync(raaPackage, 'utf8')) as unknown)?.version
  const local = raaLocal().active ? ' (RF_RAA_LOCAL=1: local override active)' : ''
  console.log(`[raa] @etcito/raa ${String(version)} release${local}`)
}

// nmc.gpu.json lists op names; an object keyed by op is still accepted.
function opNames(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((o): o is string => typeof o === 'string')
  return Object.keys(object(raw) ?? {})
}

function adapterLabel(out: Record<string, unknown>, where: string): { label: string; software: boolean } {
  const a = object(out.adapter)
  if (a === null || typeof a.software !== 'boolean') return refuse('m11-proof', `${where}/adapter`, 'is not an adapter object; pass the unmodified op output')
  const s = (k: string): string => (typeof a[k] === 'string' ? a[k] : refuse('m11-proof', `${where}/adapter/${k}`, 'is not a string; pass the unmodified op output'))
  return { label: `${s('vendor')} | ${s('architecture')} | ${s('description')}`, software: a.software }
}

async function frameP95(): Promise<CheckResult> {
  const b = await build()
  if (b.code !== 0) return { value: `web-build=${b.code}`, threshold: 'web build succeeds', pass: false, notes: b.tail.split('\n').slice(-10) }
  const missing = [pageFile, gpuConfig].filter(p => !existsSync(p))
  if (missing.length) return { value: 'missing build files', threshold: 'dist/game.html + dist/nmc.gpu.json', pass: false, notes: missing }
  const config = object(JSON.parse(await readFile(gpuConfig, 'utf8')) as unknown)
  const ops = opNames(config?.ops)
  const undeclared = ['frameTiming', 'gameCapture'].filter(op => !ops.includes(op))
  if (undeclared.length) return { value: `undeclared=${undeclared.join(',')}`, threshold: 'nmc.gpu.json declares frameTiming and gameCapture', pass: false }
  const pageRef = await publishDist(dist)
  await mkdir(out, { recursive: true })
  await writeFile(pageRefFile, `${pageRef}\n`)
  const result = await renderOp('frameTiming', { frames: 600, width: WIDTH, height: HEIGHT }, out, 'frame-timing', pageRef)
  await writeFile(timingFile, JSON.stringify(result.json, null, 2) + '\n')
  const got = unwrapOp(result, 'p95Ms').out
  const frames = got.frames
  const p95 = got.p95Ms
  const software = object(got.adapter)?.software
  const pass = typeof frames === 'number' && frames >= 600 && typeof p95 === 'number' && p95 <= 16.7 && software === false
  return {
    value: `frames=${String(frames)} p95Ms=${String(p95)} software=${String(software)}`,
    threshold: 'frames>=600 p95Ms<=16.7 adapter.software=false', pass,
    notes: [`pageRef=${pageRef}`, `raw GPU result: ${timingFile}`],
  }
}

function frameTimingOf(where: string): { timing: CapturesRecord['frameTiming']; software: boolean } {
  if (!existsSync(timingFile)) return { timing: null, software: false }
  const res: OpResult = { file: timingFile, json: JSON.parse(readFileSync(timingFile, 'utf8')) as unknown }
  const t = unwrapOp(res, 'p95Ms').out
  const num = (k: string): number => (typeof t[k] === 'number' && Number.isFinite(t[k]) ? t[k] : refuse('m11-proof', `${where}/${k}`, 'is not a finite number; rerun frame-p95'))
  return { timing: { width: WIDTH, height: HEIGHT, frames: num('frames'), p50Ms: num('p50Ms'), p95Ms: num('p95Ms') }, software: adapterLabel(t, where).software }
}

async function gpuMatch(): Promise<CheckResult> {
  if (!existsSync(pageRefFile)) return { value: 'no page ref', threshold: 'frame-p95 published the build', pass: false, notes: ['run frame-p95 first'] }
  const pageRef = (await readFile(pageRefFile, 'utf8')).trim()
  const input = { content: 'v0', flow: 'match', clients: 1, width: WIDTH, height: HEIGHT, captureAt: CAPTURE_AT }
  const result = await renderOp('gameCapture', input, out, 'game-capture', pageRef)
  await writeFile(gpuFile, JSON.stringify(result.json, null, 2) + '\n')
  const { out: data, path } = unwrapOp(result, 'captures')
  const where = `${gpuFile}${path}`
  const adapter = adapterLabel(data, where)
  const list = Array.isArray(data.captures) ? data.captures.map(object) : []
  const bad: string[] = []
  const captures: CaptureEntry[] = []
  for (const [i, c] of list.entries()) {
    const name = c?.name
    if (c === null || typeof name !== 'string' || !/^[A-Za-z0-9._-]{1,80}$/.test(name)) {
      bad.push(`captures/${i}: no file-safe name`)
      continue
    }
    const file = join(out, `${name}.png`)
    if (!existsSync(file)) {
      bad.push(`${name}: ${name}.png not returned`)
      continue
    }
    const bytes = readFileSync(file)
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    if (sha256 !== c.sha256 || bytes.length !== c.bytes) bad.push(`${name}: file differs from its record entry`)
    const png = decodePng(bytes, WIDTH, HEIGHT, `${where}/captures/${i}`)
    captures.push({ name, width: png.width, height: png.height, sha256, bytes: bytes.length, nonEmpty: c.nonEmpty === true })
  }
  const names = captures.map(c => c.name)
  const absent = CAPTURE_AT.filter(m => !names.includes(m))
  const nonEmpty = captures.length > 0 && captures.every(c => c.nonEmpty)
  const { timing, software } = frameTimingOf(timingFile)
  const record: CapturesRecord = {
    renderer: 'raa', adapter: adapter.label, software: adapter.software || software, pageRef, captures, frameTiming: timing,
  }
  await mkdir(join(root, 'proofs/m11'), { recursive: true })
  await writeFile(capturesFile, JSON.stringify(record, null, 2) + '\n')
  const pass = data.renderer === 'raa' && data.content === 'v0' && nonEmpty && absent.length === 0 && bad.length === 0
  return {
    value: `renderer=${String(data.renderer)} content=${String(data.content)} captures=${captures.length} nonEmpty=${nonEmpty}`,
    threshold: 'raa, v0 content, 1920x1080 non-empty captures from loading through the match to the podium',
    pass,
    notes: [...bad, ...absent.map(m => `missing moment: ${m}`), `record: ${capturesFile}`],
  }
}

// V0 LocalMatch: one human (piloted here) and 3..7 bots on the sprint profile; its rematch is a fresh
// sim with the next seed, back at tick 0 in intro.
function localSetup(bots: number, seed: number, courses: MatchSetup['courses']): MatchSetup {
  const playerCount = 1 + bots
  return { seed, playerCount, humans: Array.from({ length: playerCount }, (_, p) => p === 0), profile: 'sprint', courses }
}

async function runLocalCase(bots: number): Promise<boolean> {
  if (!Number.isInteger(bots) || bots < 3 || bots > 7) refuse('m11-proof', '--local-case', `${bots} is outside 3..7; pass an integer bot count in 3..7`)
  const R = await initRapier()
  const courses = await loadAllCourses(c => c.profiles.includes('sprint') && (c.kind === 'race' || c.kind === 'survival'))
  const setup = localSetup(bots, 1100 + bots, courses)
  const pilot = new Pilot(0, setup.seed)
  const state: MatchViewState = {
    tick: 0, phase: Phase.intro, phaseTicksLeft: 0, roundIndex: -1, roundKind: null, final: false, courseIndex: -1,
    roundTicksLeft: 0, alive: 0, target: 0, qualifiedCount: 0, winner: -1, podium: [],
  }
  const inputs: PlayerInput[] = Array.from({ length: setup.playerCount }, () => neutralInput())
  let sim: MatchSim = createMatchSim(R, setup)
  let running = false
  try {
    let ticks = 0
    while (!sim.done && ticks < 30_000) {
      pilot.sample(sim, inputs[0])
      sim.step(inputs)
      running ||= sim.phase(state).phase === Phase.playing
      ticks++
    }
    if (!sim.done || !running) return false
    const log = sim.log()
    await mkdir(out, { recursive: true })
    await writeFile(join(out, `round-log-${bots}.json`), matchLogJson(log))
    const ok = log.rounds.some(r => r.kind === 'race') && log.rounds.some(r => r.kind === 'survival') &&
      log.rounds.some(r => r.eliminated.length > 0) && log.winner >= 0
    if (!ok) return false
    const next = createMatchSim(R, { ...setup, seed: (setup.seed + 1) >>> 0 })
    sim.free()
    sim = next
    sim.phase(state)
    return sim.tick === 0 && state.phase === Phase.intro
  } finally { sim.free() }
}

async function localMatch(_mode: string, args: ProofArgs): Promise<CheckResult> {
  const direct = args.rest.indexOf('--local-case')
  if (direct >= 0) {
    const bots = Number(args.rest[direct + 1])
    const pass = await runLocalCase(bots)
    return { value: `bots=${bots} done+rematch=${pass}`, threshold: 'match done, race+survival, elimination+winner, rematch tick=0 intro', pass }
  }
  const outcomes = await spawnCases(fileURLToPath(import.meta.url), [3, 7].map(bots => ({ label: `local-match-${bots}`, args: ['--local-case', String(bots)] })))
  const failed = outcomes.filter(o => o.code !== 0 || !o.stdout.includes('done+rematch=true'))
  return {
    value: outcomes.map(o => `${o.label}:${o.code === 0 ? 'PASS' : `exit-${o.code}`}`).join(' '),
    threshold: 'bots 3 and 7 reach done and rematch', pass: failed.length === 0,
    notes: failed.flatMap(o => [o.stdout, o.stderr].filter(Boolean).map(s => `${o.label}: ${s.trim().split('\n').slice(0, 8).join(' | ')}`)),
  }
}

async function playDoc(): Promise<CheckResult> {
  const text = await readFile(join(root, 'proofs/m11/play.md'), 'utf8')
  const lines = text.split(/\r?\n/).filter(line => line.trim().length > 0)
  const pass = lines.length <= 10 && text.includes('npm run play') && text.includes('game.html')
  return { value: `${lines.length} non-empty lines`, threshold: '<=10 lines; npm run play; game.html', pass }
}

const checks: ProofCheck[] = [
  { label: 'frame-p95', inQuick: true, timing: true, run: () => frameP95() },
  { label: 'gpu-match', inQuick: true, run: () => gpuMatch() },
  { label: 'local-match', inQuick: true, run: (mode, args) => localMatch(mode, args) },
  { label: 'play-doc', inQuick: true, run: () => playDoc() },
]

const proofArgs = parseProofArgs(process.argv.slice(2))
if (!proofArgs.child && proofArgs.rest.includes('--local-case')) {
  const bots = Number(proofArgs.rest[proofArgs.rest.indexOf('--local-case') + 1])
  const ok = await runLocalCase(bots)
  console.log(`[local-match-${bots}] done+rematch=${ok ? 'true' : 'false'}`)
  process.exitCode = ok ? 0 : 1
} else {
  if (!proofArgs.child) ensureRaaRelease()
  await runProof('m11-playable', import.meta.url, checks)
}
report('m11-playable', { wallMs: Math.round(performance.now() - started) })
process.exit(process.exitCode ?? 0)
