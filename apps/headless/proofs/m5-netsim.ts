import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { NETSIM_CASES, runNetSimCase } from '../src/netsimMatch.ts'
import type { NetRunResult, NetSimCase } from '../src/netsimMatch.ts'
import { cpuBudget, report, runProof, spawnCases } from '../src/proofkit.ts'
import type { CheckResult, ProofCheck, ProofMode } from '../src/proofkit.ts'

const FRAME_CASE = 'p8-rtt100'
const FRAME_BUDGET_MS = 16.7
const MAX_LATENCY_TICKS = 3

interface CaseRun { c: NetSimCase; result: NetRunResult | null; notes: string[] }

function lastLines(s: string, n: number): string[] {
  return s.split('\n').map(l => l.trimEnd()).filter(l => l.length > 0).slice(-n)
}

const ms = (x: number): string => x.toFixed(3)

// The frame-budget run, kept so the batch does not pay the 8-peer 100 ms case twice.
let frameRun: NetRunResult | null = null

const batches = new Map<ProofMode, Promise<CaseRun[]>>()

function caseResults(mode: ProofMode): Promise<CaseRun[]> {
  let p = batches.get(mode)
  if (p === undefined) {
    p = runBatch(mode)
    batches.set(mode, p)
  }
  return p
}

async function runBatch(mode: ProofMode): Promise<CaseRun[]> {
  const cases = NETSIM_CASES[mode]
  const reused = frameRun
  const toSpawn = cases.filter(c => !(reused !== null && c.label === reused.label))
  const outcomes = await spawnCases(fileURLToPath(import.meta.url), toSpawn.map(c => ({ label: c.label, args: ['--case', c.label] })))
  const runs: CaseRun[] = []
  for (const c of cases) {
    if (reused !== null && c.label === reused.label) {
      runs.push({ c, result: reused, notes: [] })
      continue
    }
    const o = outcomes[toSpawn.indexOf(c)]
    const line = o.stdout.split('\n').find(l => l.startsWith('NETRUN '))
    if (o.code !== 0 || line === undefined) {
      runs.push({ c, result: null, notes: [`${c.label} exit ${o.code}`, ...lastLines(o.stderr, 6).map(l => `  ${l}`)] })
      continue
    }
    runs.push({ c, result: JSON.parse(line.slice('NETRUN '.length)) as NetRunResult, notes: [] })
  }
  const cpus = cpuBudget()
  const machine = os.cpus()[0]?.model ?? 'unknown'
  for (const r of runs) {
    const x = r.result
    if (x === null) continue
    report(x.label, {
      rollbacks: x.rollbacks, maxRollback: x.maxRollback, resimTicks: x.resimTicks, resimPerTick: x.resimPerTick.toFixed(4),
      frameMsMean: ms(x.frameMsMean), frameMsP99: ms(x.frameMsP99), stalls: x.stalls, ticks: x.ticks,
      wallS: (x.wallMs / 1000).toFixed(1), mode, cpus, node: process.version, machine: JSON.stringify(machine),
    })
  }
  return runs
}

// Failed children make every batch check fail, with their stderr tail as notes.
function failures(runs: CaseRun[]): string[] {
  return runs.filter(r => r.result === null).flatMap(r => r.notes)
}

async function checkFrameBudget(): Promise<CheckResult> {
  const c = NETSIM_CASES.full.find(k => k.label === FRAME_CASE) as NetSimCase
  const r = await runNetSimCase(c)
  frameRun = r
  return {
    value: `p99=${ms(r.frameMsP99)} mean=${ms(r.frameMsMean)} max=${ms(r.frameMsMax)}`,
    threshold: `p99<=${FRAME_BUDGET_MS}`,
    pass: r.frameMsP99 <= FRAME_BUDGET_MS,
    notes: [`${r.label}: ticks=${r.ticks} wall=${(r.wallMs / 1000).toFixed(1)} s`],
  }
}

async function checkHashes(mode: ProofMode): Promise<CheckResult> {
  const runs = await caseResults(mode)
  const notes = failures(runs)
  let mismatches = 0
  const compared: string[] = []
  for (const { c, result: r } of runs) {
    if (r === null) { compared.push(`${c.label}:failed`); continue }
    mismatches += r.mismatches
    compared.push(`${c.label}:${r.ticksCompared}`)
    if (r.firstMismatch !== -1) notes.push(`${c.label}: firstMismatch=${r.firstMismatch} mismatches=${r.mismatches}`)
  }
  return {
    value: `mismatches=${mismatches} ticksCompared=${compared.join(',')}`,
    threshold: 'mismatches=0',
    pass: notes.length === 0 && mismatches === 0,
    notes,
  }
}

async function checkMatchComplete(mode: ProofMode): Promise<CheckResult> {
  const runs = await caseResults(mode)
  const notes = failures(runs)
  const parts: string[] = []
  let pass = notes.length === 0
  for (const { c, result: r } of runs) {
    if (r === null) { parts.push(`${c.label}:failed`); continue }
    const w = r.winners[0]
    const same = r.winners.every(x => x === w)
    parts.push(`${c.label}:${same ? w : r.winners.join('/')}`)
    if (!same || w < 0 || !r.logsEqual) {
      pass = false
      notes.push(`${c.label}: winners=[${r.winners.join(',')}] logsEqual=${r.logsEqual}`)
    }
  }
  return { value: parts.join(' '), threshold: 'done, same winner >= 0, logsEqual on every peer', pass, notes }
}

async function checkLatency(mode: ProofMode): Promise<CheckResult> {
  const runs = await caseResults(mode)
  const notes = failures(runs)
  let worst = 0
  for (const { result: r } of runs) if (r !== null) worst = Math.max(worst, r.maxDelay + 1)
  return {
    value: `${worst}`,
    threshold: `<=${MAX_LATENCY_TICKS}`,
    pass: notes.length === 0 && worst <= MAX_LATENCY_TICKS,
    notes,
  }
}

async function checkSmoothing(mode: ProofMode): Promise<CheckResult> {
  const runs = (await caseResults(mode)).filter(r => r.c.rttMs === 100)
  const notes = failures(runs)
  let snaps = 0
  let maxJump = 0
  for (const { c, result: r } of runs) {
    if (r === null) continue
    snaps += r.visibleSnaps
    maxJump = Math.max(maxJump, r.maxDisplayJump)
    notes.push(`${c.label}: maxDisplayJump=${r.maxDisplayJump.toFixed(4)} visibleSnaps=${r.visibleSnaps}`)
  }
  return {
    value: `visibleSnaps=${snaps} maxDisplayJump=${maxJump.toFixed(4)}`,
    threshold: 'visibleSnaps=0',
    pass: failures(runs).length === 0 && runs.length > 0 && snaps === 0,
    notes,
  }
}

// Checks 2-5 are marked timing too: otherwise runProof runs each one in its own child, and
// every child would re-run every case (or exceed NMC_CPUS when nested). In-process they share
// one memoised batch, and the parallelism lives inside spawnCases.
const checks: ProofCheck[] = [
  { label: 'frame-budget', inQuick: true, timing: true, run: () => checkFrameBudget() },
  { label: 'hashes', inQuick: true, timing: true, run: (mode) => checkHashes(mode) },
  { label: 'match-complete', inQuick: true, timing: true, run: (mode) => checkMatchComplete(mode) },
  { label: 'latency', inQuick: true, timing: true, run: (mode) => checkLatency(mode) },
  { label: 'smoothing', inQuick: true, timing: true, run: (mode) => checkSmoothing(mode) },
]

const caseAt = process.argv.indexOf('--case')
if (caseAt !== -1) {
  const label = process.argv[caseAt + 1]
  const c = NETSIM_CASES.full.find(k => k.label === label)
  if (c === undefined) {
    console.error(`[netsim] --case ${label}: unknown case; use one of ${NETSIM_CASES.full.map(k => k.label).join(', ')}`)
    process.exit(1)
  }
  try {
    console.log(`NETRUN ${JSON.stringify(await runNetSimCase(c))}`)
    process.exit(0)
  } catch (e) {
    const err = e as { name?: string; message?: string; stack?: string }
    console.error(err?.name === 'RefusalError' ? String(err.message) : String(err?.stack ?? e))
    process.exit(1)
  }
} else {
  await runProof('m5-netsim', import.meta.url, checks)
}
