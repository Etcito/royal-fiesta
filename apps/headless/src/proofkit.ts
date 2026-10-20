import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { refuse } from '@royal-fiesta/sim/refusal'
import { repoRoot } from '../../../tools/bricks.ts'

export type ProofMode = 'quick' | 'full'
export interface CheckResult { value: string; threshold: string; pass: boolean; notes?: string[] }
export interface ProofCheck { label: string; inQuick: boolean; timing?: boolean; run(mode: ProofMode, args: ProofArgs): Promise<CheckResult> }
export interface ProofArgs { only: RegExp | null; mode: ProofMode; child: boolean; writeGolden: boolean; rest: string[] }
export interface CaseOutcome { label: string; code: number; stdout: string; stderr: string; ms: number }

export function parseProofArgs(argv: string[]): ProofArgs {
  const args: ProofArgs = { only: null, mode: 'quick', child: false, writeGolden: false, rest: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--only' && i + 1 < argv.length) args.only = new RegExp(argv[++i], 'i')
    else if (a === '--quick') args.mode = 'quick'
    else if (a === '--full') args.mode = 'full'
    else if (a === '--child') args.child = true
    else if (a === '--write-golden') args.writeGolden = true
    else args.rest.push(a)
  }
  return args
}

export function cpuBudget(): number {
  const n = parseInt(process.env.NMC_CPUS ?? '', 10)
  return n >= 1 ? n : 1
}

export function printCheck(label: string, r: CheckResult): void {
  console.log(`[${label}] value=${r.value} threshold=${r.threshold} ${r.pass ? 'PASS' : 'FAIL'}`)
  for (const n of r.notes ?? []) console.log('  ' + n)
}

export function report(label: string, fields: Record<string, string | number>): void {
  const kv = Object.keys(fields).map((k) => `${k}=${fields[k]}`)
  console.log(`[report:${label}] ${kv.join(' ')}`)
}

export function outDir(milestone: string): string {
  const dir = join(repoRoot(), 'out', milestone)
  mkdirSync(dir, { recursive: true })
  return dir
}

export function hex8(n: number): string {
  return (n >>> 0).toString(16).padStart(8, '0')
}

export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) refuse('proofkit', 'percentile', 'empty input; pass at least one value')
  const sorted = values.slice().sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[idx]
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function runChild(script: string, label: string, args: string[]): Promise<CaseOutcome> {
  return new Promise((resolve) => {
    const t0 = performance.now()
    let stdout = ''
    let stderr = ''
    let settled = false
    const done = (code: number) => {
      if (settled) return
      settled = true
      resolve({ label, code, stdout, stderr, ms: performance.now() - t0 })
    }
    const child = spawn(process.execPath, ['--experimental-strip-types', script, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (d: string) => { stdout += d })
    child.stderr.on('data', (d: string) => { stderr += d })
    child.on('error', (e) => { stderr += String(e.message) + '\n'; done(1) })
    child.on('close', (code) => done(code ?? 1))
  })
}

// Pool that keeps at most `limit` children running; `stop` halts new launches.
async function runPool(
  script: string,
  cases: { label: string; args: string[] }[],
  limit: number,
  stop: () => boolean,
  onDone: (i: number, o: CaseOutcome) => void,
): Promise<(CaseOutcome | null)[]> {
  const out: (CaseOutcome | null)[] = cases.map(() => null)
  let next = 0
  const worker = async () => {
    while (next < cases.length && !stop()) {
      const i = next++
      const o = await runChild(script, cases[i].label, cases[i].args)
      out[i] = o
      onDone(i, o)
    }
  }
  const workers: Promise<void>[] = []
  for (let w = 0; w < Math.max(1, Math.min(limit, cases.length)); w++) workers.push(worker())
  await Promise.all(workers)
  return out
}

export async function spawnCases(script: string, cases: { label: string; args: string[] }[], limit: number = cpuBudget()): Promise<CaseOutcome[]> {
  const out = await runPool(script, cases, limit, () => false, () => {})
  return out as CaseOutcome[]
}

async function runCheck(check: ProofCheck, args: ProofArgs): Promise<CheckResult> {
  try {
    return await check.run(args.mode, args)
  } catch (e) {
    const err = e as { name?: string; message?: string; stack?: string }
    const isRefusal = err !== null && typeof err === 'object' && err.name === 'RefusalError'
    const notes = isRefusal ? [String(err.message)] : String(err?.stack ?? e).split('\n').slice(0, 6)
    return { value: 'threw', threshold: 'no-throw', pass: false, notes }
  }
}

function lastLines(s: string, n: number): string[] {
  return s.split('\n').map((l) => l.trimEnd()).filter((l) => l.length > 0).slice(-n)
}

function childPassed(o: CaseOutcome): boolean {
  if (o.code !== 0) return false
  return !o.stdout.split('\n').some((l) => l.startsWith(`[${o.label}] value=`) && l.trimEnd().endsWith(' FAIL'))
}

function forwardChild(o: CaseOutcome): void {
  if (o.stdout.length > 0) process.stdout.write(o.stdout.endsWith('\n') ? o.stdout : o.stdout + '\n')
  const printed = o.stdout.split('\n').some((l) => l.startsWith(`[${o.label}] value=`))
  if (o.code !== 0 && !printed) {
    printCheck(o.label, { value: `child-exit-${o.code}`, threshold: 'exit-0', pass: false, notes: lastLines(o.stderr, 10) })
  }
}

export async function runProof(name: string, scriptUrl: string, checks: ProofCheck[], argv: string[] = process.argv.slice(2)): Promise<void> {
  const args = parseProofArgs(argv)
  const selected = checks.filter((c) => (args.only === null || args.only.test(c.label)) && (args.mode === 'full' || c.inQuick))

  if (args.child) {
    for (const c of selected) {
      const r = await runCheck(c, args)
      printCheck(c.label, r)
      if (!r.pass) {
        process.exitCode = 1
        return
      }
    }
    return
  }

  const budget = cpuBudget()
  const t0 = performance.now()
  console.log(`== ${name} (${args.mode}, NMC_CPUS=${budget}) ==`)
  let passed = 0
  let failed = false

  const inProcess = async (list: ProofCheck[]) => {
    for (const c of list) {
      if (failed) return
      const r = await runCheck(c, args)
      printCheck(c.label, r)
      if (r.pass) passed++
      else failed = true
    }
  }

  // Timing checks run first and alone so nothing competes for the CPU.
  await inProcess(selected.filter((c) => c.timing === true))
  const others = selected.filter((c) => c.timing !== true)

  if (!failed && others.length > 0) {
    if (budget === 1) {
      await inProcess(others)
    } else {
      const script = fileURLToPath(scriptUrl)
      const extra = args.writeGolden ? ['--write-golden'] : []
      const cases = others.map((c) => ({
        label: c.label,
        args: ['--child', '--only', '^' + escapeRegex(c.label) + '$', '--' + args.mode, ...extra, ...args.rest],
      }))
      // Forward outputs in check order as soon as every earlier case is in.
      const ready: (CaseOutcome | null)[] = cases.map(() => null)
      let flushed = 0
      const flush = () => {
        while (flushed < ready.length && ready[flushed] !== null) {
          const o = ready[flushed] as CaseOutcome
          forwardChild(o)
          if (childPassed(o)) passed++
          flushed++
        }
      }
      await runPool(script, cases, budget, () => failed, (i, o) => {
        ready[i] = o
        if (!childPassed(o)) failed = true
        flush()
      })
      flush()
    }
  }

  if (failed) process.exitCode = 1
  const s = ((performance.now() - t0) / 1000).toFixed(1)
  console.log(`== ${name}: ${passed}/${selected.length} passed in ${s} s ==`)
}
