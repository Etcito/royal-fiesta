// M1 Foundations proof: tests, git guard, bit-identical world, restore, web build.
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { cpus } from 'node:os'
import { join } from 'node:path'
import { initRapier } from '@gamesaloon/rollback-rapier'
import type { RapierModule } from '@gamesaloon/rollback-rapier'
import { createFlatFloorWorld, flatFloorScript } from '@royal-fiesta/sim/scenarios/flatFloor'
import type { FiestaWorld } from '@royal-fiesta/sim/world'
import { report, runProof } from '../src/proofkit.ts'
import type { CheckResult, ProofCheck, ProofMode } from '../src/proofkit.ts'
import { checkPaths, trackedFiles } from '../../../tools/guard.ts'
import { repoRoot } from '../../../tools/bricks.ts'

const PLAYERS = 8
const SEED = 7
const TICKS = 5000
const HASH_EVERY = 50
const RESTORE_TICKS = [0, 1234, 2500, 4999]

// One Rapier init per process, shared by the world checks.
let rapier: Promise<RapierModule> | null = null
function getRapier(): Promise<RapierModule> {
  if (rapier === null) rapier = initRapier()
  return rapier
}

function runCommand(cmd: string, args: string[]): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    let output = ''
    const child = spawn(cmd, args, { cwd: repoRoot(), stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (d: string) => { output += d })
    child.stderr.on('data', (d: string) => { output += d })
    child.on('error', (e) => { output += e.message + '\n'; resolve({ code: 1, output }) })
    child.on('close', (code) => resolve({ code: code ?? 1, output }))
  })
}

function lastLines(s: string, n: number): string[] {
  return s.split('\n').map((l) => l.trimEnd()).filter((l) => l.length > 0).slice(-n)
}

function summaryCount(output: string, key: string): number | null {
  const m = new RegExp(`^# ${key} (\\d+)$`, 'm').exec(output) ?? new RegExp(`^ℹ ${key} (\\d+)$`, 'm').exec(output)
  return m === null ? null : parseInt(m[1], 10)
}

function stepTo(world: FiestaWorld<number>, inputs: number[], toTick: number): void {
  while (world.tick < toTick) {
    const tick = world.tick
    for (let p = 0; p < PLAYERS; p++) inputs[p] = flatFloorScript(SEED, p, tick)
    world.step(inputs)
  }
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

async function checkTests(): Promise<CheckResult> {
  const { code, output } = await runCommand('npm', ['test'])
  const p = summaryCount(output, 'pass') ?? 0
  const f = summaryCount(output, 'fail') ?? -1
  const pass = code === 0 && f === 0 && p > 0
  return { value: `pass=${p} fail=${f}`, threshold: 'fail=0', pass, notes: pass ? [] : lastLines(output, 20) }
}

async function checkGuard(): Promise<CheckResult> {
  const root = repoRoot()
  const files = trackedFiles(root)
  const violations = checkPaths(root, files)
  return {
    value: `${files.length} files, ${violations.length} violations`,
    threshold: '0 violations',
    pass: violations.length === 0,
    notes: violations.map((v) => `${v.path}: ${v.rule}: ${v.detail}`),
  }
}

async function checkDeterminism(mode: ProofMode): Promise<CheckResult> {
  const R = await getRapier()
  const a = createFlatFloorWorld(R, { players: PLAYERS, seed: SEED })
  const b = createFlatFloorWorld(R, { players: PLAYERS, seed: SEED })
  try {
    const inA = new Array<number>(PLAYERS).fill(0)
    const inB = new Array<number>(PLAYERS).fill(0)
    let mismatches = 0
    let stepSnapMs = 0
    let finalBytes: Uint8Array = new Uint8Array(0)
    for (let t = 0; t < TICKS; t++) {
      for (let p = 0; p < PLAYERS; p++) inA[p] = flatFloorScript(SEED, p, t)
      const t0 = performance.now()
      a.step(inA)
      finalBytes = a.takeSnapshotBytes()
      stepSnapMs += performance.now() - t0
      for (let p = 0; p < PLAYERS; p++) inB[p] = flatFloorScript(SEED, p, t)
      b.step(inB)
      if ((t + 1) % HASH_EVERY === 0 && a.stateHash() !== b.stateHash()) mismatches++
    }
    const equal = bytesEqual(finalBytes, b.takeSnapshotBytes())
    report('m1-snapshot', {
      bytes: finalBytes.length,
      meanStepSnapshotMs: (stepSnapMs / TICKS).toFixed(4),
      players: PLAYERS,
      ticks: TICKS,
      machine: cpus()[0]?.model ?? 'unknown',
      mode,
    })
    return {
      value: `mismatches=${mismatches}/${TICKS / HASH_EVERY} finalBytesEqual=${equal}`,
      threshold: 'mismatches=0 finalBytesEqual=true',
      pass: mismatches === 0 && equal,
    }
  } finally {
    a.free()
    b.free()
  }
}

async function checkRestore(): Promise<CheckResult> {
  const R = await getRapier()
  const inputs = new Array<number>(PLAYERS).fill(0)
  const ref = createFlatFloorWorld(R, { players: PLAYERS, seed: SEED })
  const notes: string[] = []
  let ok = 0
  try {
    const snaps: Uint8Array[] = []
    for (const t of RESTORE_TICKS) {
      stepTo(ref, inputs, t)
      snaps.push(ref.takeSnapshotBytes())
    }
    stepTo(ref, inputs, TICKS)
    const refHash = ref.stateHash()
    for (let i = 0; i < snaps.length; i++) {
      // (a) same instance
      ref.restoreSnapshotBytes(snaps[i])
      stepTo(ref, inputs, TICKS)
      if (ref.stateHash() === refHash) ok++
      else notes.push(`same-instance restore at tick ${RESTORE_TICKS[i]} differs`)
      // (b) fresh instance
      const fresh = createFlatFloorWorld(R, { players: PLAYERS, seed: SEED })
      try {
        fresh.restoreSnapshotBytes(snaps[i])
        stepTo(fresh, inputs, TICKS)
        if (fresh.stateHash() === refHash) ok++
        else notes.push(`fresh-instance restore at tick ${RESTORE_TICKS[i]} differs`)
      } finally {
        fresh.free()
      }
    }
  } finally {
    ref.free()
  }
  const total = RESTORE_TICKS.length * 2
  return { value: `${ok}/${total} restores identical`, threshold: `${total}/${total}`, pass: ok === total, notes }
}

async function checkWebBuild(): Promise<CheckResult> {
  const { code, output } = await runCommand('npm', ['run', 'web:build'])
  const index = existsSync(join(repoRoot(), 'apps/web/dist/index.html'))
  const pass = code === 0 && index
  return { value: `exit=${code} index=${index}`, threshold: 'exit=0 index=true', pass, notes: pass ? [] : lastLines(output, 20) }
}

const checks: ProofCheck[] = [
  { label: 'tests', inQuick: true, run: () => checkTests() },
  { label: 'guard', inQuick: true, run: () => checkGuard() },
  { label: 'determinism-5000', inQuick: true, run: (mode) => checkDeterminism(mode) },
  { label: 'restore', inQuick: true, run: () => checkRestore() },
  { label: 'web-build', inQuick: true, run: () => checkWebBuild() },
]

await runProof('m1-foundations', import.meta.url, checks)
