import { existsSync } from 'node:fs'
import { cpus } from 'node:os'
import { writeFile } from 'node:fs/promises'
import type { SnapReader, SnapWriter } from '@gamesaloon/rollback'
import { initRapier } from '@gamesaloon/rollback-rapier'
import type { RapierModule } from '@gamesaloon/rollback-rapier'
import { CharacterSystem } from '@royal-fiesta/sim/character/system'
import type { CharState } from '@royal-fiesta/sim/character/system'
import { NEUTRAL_CODE, decodeInput, encodeInput, neutralInput } from '@royal-fiesta/sim/input'
import type { PlayerInput } from '@royal-fiesta/sim/input'
import { ObstacleSystem } from '@royal-fiesta/sim/obstacles/system'
import type { ResolvedCourse } from '@royal-fiesta/sim/course'
import { FiestaWorld } from '@royal-fiesta/sim/world'
import type { SimSystem, WorldCtx } from '@royal-fiesta/sim/world'
import { REPLAY_SCRIPTS, REPLAY_TICKS, behaviourScenarios, codeAt } from '../src/scripts.ts'
import type { BehaviourScenario } from '../src/scripts.ts'
import { loadCourseFile, readRepoText, repoPath } from '../src/files.ts'
import { hex8, parseProofArgs, percentile, report, runProof } from '../src/proofkit.ts'
import type { CheckResult, ProofArgs, ProofCheck, ProofMode } from '../src/proofkit.ts'

const GALLERY = 'fixtures/courses/obstacle-gallery.course.json'
const SPINNER_1 = 13
const CONVEYOR_2 = 30
const BOUNCE_1 = 33
const PLATFORM_2 = 37
const SETUP_MARKER = 0x4d334348
const GOLDEN = 'fixtures/golden/m3-replay.json'
const TICKS = 3600
const RESTORE_EVERY = 61
const ALL_SPAWNS = [0, 1, 2, 3, 4, 5, 6, 7]
const REGENERATE = 'node --experimental-strip-types apps/headless/proofs/m3-character.ts --only replay-golden --write-golden'

let rapier: Promise<RapierModule> | null = null
function getRapier(): Promise<RapierModule> {
  if (rapier === null) rapier = initRapier()
  return rapier
}

class SetupSystem implements SimSystem<PlayerInput> {
  readonly name = 'setup'
  readonly obstacles: ObstacleSystem
  readonly characters: CharacterSystem
  readonly course: ResolvedCourse
  readonly spawns: number[]

  constructor(obstacles: ObstacleSystem, characters: CharacterSystem, course: ResolvedCourse, spawns: number[]) {
    this.obstacles = obstacles
    this.characters = characters
    this.course = course
    this.spawns = spawns
  }

  init(ctx: WorldCtx<PlayerInput>): void {
    this.obstacles.load(ctx, 0)
    for (let p = 0; p < this.spawns.length; p++) this.characters.place(ctx, p, this.course.spawns[this.spawns[p]])
  }
  preStep(_ctx: WorldCtx<PlayerInput>, _inputs: readonly PlayerInput[]): void {}
  postStep(_ctx: WorldCtx<PlayerInput>): void {}
  snapshot(w: SnapWriter): void { w.u32(SETUP_MARKER) }
  restore(r: SnapReader, _ctx: WorldCtx<PlayerInput>): void {
    if (r.u32() !== SETUP_MARKER) throw new Error('m3 setup snapshot marker mismatch')
  }
}

function createGalleryWorld(R: RapierModule, course: ResolvedCourse, spawns: number[]): { world: FiestaWorld<PlayerInput>; characters: CharacterSystem } {
  const obstacles = new ObstacleSystem([course])
  const characters = new CharacterSystem({ playerCount: spawns.length })
  const setup = new SetupSystem(obstacles, characters, course, spawns)
  const world = new FiestaWorld<PlayerInput>(R, { playerCount: spawns.length, systems: [obstacles, characters, setup] })
  return { world, characters }
}

function blankState(): CharState {
  return { pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, facing: { x: 0, z: 1 }, mode: 0, grounded: false, groundObstacle: -1, knockbacks: 0, teleportTick: 0 }
}

function sample(characters: CharacterSystem, ctx: WorldCtx<PlayerInput>, p: number): CharState {
  const out = blankState()
  characters.state(ctx, p, out)
  return out
}

function reached(scenario: BehaviourScenario, samples: CharState[]): boolean | null {
  const obstacle = scenario.label === 'spinner-bump' ? SPINNER_1 : scenario.label === 'bounce-apex' ? BOUNCE_1 : scenario.label === 'conveyor' ? CONVEYOR_2 : scenario.label === 'platform' ? PLATFORM_2 : -1
  if (scenario.label === 'spinner-bump') return samples.some((s) => s.mode === 4 && s.knockbacks > 0)
  if (obstacle < 0) return null
  return samples.some((s) => s.grounded && s.groundObstacle === obstacle)
}

async function checkBehaviours(): Promise<CheckResult> {
  const R = await getRapier()
  const course = await loadCourseFile(GALLERY)
  const belt = course.obstacles[CONVEYOR_2].motion
  const bounce = course.obstacles[BOUNCE_1].motion
  const platform = course.obstacles[PLATFORM_2].motion
  const beltSpeed = belt.kind === 'conveyor' ? Math.abs(belt.velocity.z) : 0
  const bounceSpeed = bounce.kind === 'bouncePad' ? bounce.speed : 0
  const platformPeriod = platform.kind === 'movingPlatform' ? platform.periodTicks : 0
  const scenarios = behaviourScenarios()
  const notes: string[] = []
  let passed = 0

  for (const scenario of scenarios) {
    const spawns = [scenario.spawn, ...scenario.others.map((actor) => actor.spawn)]
    const { world, characters } = createGalleryWorld(R, course, spawns)
    const inputs = spawns.map(() => neutralInput())
    const samples: CharState[] = [sample(characters, world.ctx, 0)]
    try {
      for (let tick = 0; tick < scenario.ticks; tick++) {
        decodeInput(codeAt(scenario.script, tick), inputs[0])
        for (let p = 1; p < inputs.length; p++) decodeInput(codeAt(scenario.others[p - 1].script, tick), inputs[p])
        world.step(inputs)
        samples.push(sample(characters, world.ctx, 0))
      }
    } finally {
      world.free()
    }
    const result = scenario.measure(samples)
    const obstacleReached = reached(scenario, samples)
    const pass = result.pass && obstacleReached !== false
    if (pass) passed++
    const value = Number.isFinite(result.value) ? result.value.toFixed(3) : String(result.value)
    const grabCount = scenario.label === 'grab' ? samples.filter((s, i) => i >= 40 && Math.hypot(s.vel.x, s.vel.z) > 0.01 && Math.hypot(s.vel.x, s.vel.z) <= 4.8 + 1e-6).length : 0
    const reachedNote = scenario.label === 'grab'
      ? grabCount >= 30 ? ' grabbed' : ' grab not established'
      : obstacleReached === false ? ' obstacle not reached' : obstacleReached === true ? ' obstacle reached' : ''
    const detail = scenario.label === 'grab' ? ` grabbedSamples=${grabCount}` : ''
    notes.push(`${scenario.label} value=${value} threshold=${result.threshold} ${pass ? 'PASS' : 'FAIL'}${reachedNote}${detail}`)
  }
  // These fixture values anchor the fixed scenario thresholds to the gallery data.
  if (beltSpeed !== 3 || bounceSpeed !== 14 || platformPeriod !== 180) {
    notes.push(`gallery constants: belt=${beltSpeed} bounce=${bounceSpeed} platformPeriodTicks=${platformPeriod}`)
  }
  return { value: `${passed}/8`, threshold: '8/8', pass: passed === 8, notes }
}

interface GoldenRow { tick: number; entity: string; values: number[] }
interface Golden { format: string; version: number; name: string; regenerate: string; ticks: number[]; rows: GoldenRow[]; hash: string }

async function checkReplayGolden(args: ProofArgs): Promise<CheckResult> {
  const R = await getRapier()
  const course = await loadCourseFile(GALLERY)
  const spawns = [0, 1, 2, 3, 4, 5, 6, 7]
  const { world, characters } = createGalleryWorld(R, course, spawns)
  const inputs = spawns.map(() => neutralInput())
  const s = blankState()
  const rows: GoldenRow[] = []
  let hash = ''
  try {
    for (const T of REPLAY_TICKS) {
      while (world.tick < T) {
        for (let p = 0; p < inputs.length; p++) decodeInput(codeAt(REPLAY_SCRIPTS[p], world.tick), inputs[p])
        world.step(inputs)
      }
      for (let p = 0; p < spawns.length; p++) {
        characters.state(world.ctx, p, s)
        rows.push({ tick: T, entity: `char-${p}`, values: [s.pos.x, s.pos.y, s.pos.z, s.vel.x, s.vel.y, s.vel.z] })
      }
    }
    hash = hex8(world.stateHash())
  } finally {
    world.free()
  }
  const g: Golden = { format: 'royal-fiesta.golden', version: 0, name: 'm3-replay', regenerate: REGENERATE, ticks: [...REPLAY_TICKS], rows, hash }
  const notes = [`regenerate: ${REGENERATE}`]
  const threshold = 'mismatches=0'
  if (args.writeGolden) {
    await writeFile(repoPath(GOLDEN), JSON.stringify(g, null, 2) + '\n')
    return { value: `rows=${rows.length} mismatches=0 hash=${hash}`, threshold, pass: true, notes: [...notes, 'golden written'] }
  }
  if (!existsSync(repoPath(GOLDEN))) {
    return { value: `rows=${rows.length} golden=missing hash=${hash}`, threshold, pass: false, notes: [...notes, `${GOLDEN} is missing; run the command above`] }
  }
  const want = JSON.parse(await readRepoText(GOLDEN)) as Golden
  let mismatches = 0
  const n = Math.max(rows.length, want.rows.length)
  for (let k = 0; k < n; k++) {
    const a = rows[k]
    const b = want.rows[k]
    let same = a !== undefined && b !== undefined && a.tick === b.tick && a.entity === b.entity && a.values.length === b.values.length
    if (same) for (let j = 0; j < a.values.length; j++) if (a.values[j] !== b.values[j]) same = false
    if (!same) {
      mismatches++
      if (mismatches <= 5) notes.push(`row ${k}: got ${JSON.stringify(a ?? null)} want ${JSON.stringify(b ?? null)}`)
    }
  }
  if (hash !== want.hash) {
    mismatches++
    notes.push(`hash: got ${hash} want ${want.hash}`)
  }
  return { value: `rows=${rows.length} mismatches=${mismatches} hash=${hash}`, threshold, pass: mismatches === 0, notes }
}

function scriptInputs(inputs: PlayerInput[], tick: number): PlayerInput[] {
  for (let p = 0; p < inputs.length; p++) decodeInput(codeAt(REPLAY_SCRIPTS[p], tick), inputs[p])
  return inputs
}

function sameInput(x: PlayerInput, y: PlayerInput): boolean {
  return x.moveX === y.moveX && x.moveZ === y.moveZ && x.jump === y.jump && x.dive === y.dive && x.grab === y.grab
}

function checkCodec(): CheckResult {
  const codes = 1 << 19
  const a = neutralInput()
  const b = neutralInput()
  const notes: string[] = []
  let mismatches = 0
  for (let c = 0; c < codes; c++) {
    decodeInput(c, a)
    const c2 = encodeInput(a)
    decodeInput(c2, b)
    if (!sameInput(a, b) || encodeInput(b) !== c2) {
      mismatches++
      if (notes.length < 5) notes.push(`code ${c}: re-encoded ${c2}`)
    }
  }
  const n = neutralInput()
  if (!sameInput(decodeInput(NEUTRAL_CODE, a), n)) {
    mismatches++
    notes.push('decode(NEUTRAL_CODE) is not neutral')
  }
  if (encodeInput(n) !== NEUTRAL_CODE) {
    mismatches++
    notes.push(`encode(neutralInput()) = ${encodeInput(n)}, not ${NEUTRAL_CODE}`)
  }
  return { value: `mismatches=${mismatches} codes=${codes}`, threshold: 'mismatches=0', pass: mismatches === 0, notes }
}

async function checkDeterminism(): Promise<CheckResult> {
  const R = await getRapier()
  const course = await loadCourseFile(GALLERY)
  const a = createGalleryWorld(R, course, ALL_SPAWNS).world
  const b = createGalleryWorld(R, course, ALL_SPAWNS).world
  const inputs = ALL_SPAWNS.map(() => neutralInput())
  const notes: string[] = []
  let mismatches = 0
  let restores = 0
  try {
    // hashes[t] = A's hash at tick t; restore points keep A's bytes at tick k.
    const hashes: number[] = [a.stateHash()]
    const saved: { k: number; bytes: Uint8Array }[] = []
    for (let t = 0; t < TICKS; t++) {
      if (t > 0 && t % RESTORE_EVERY === 0) saved.push({ k: t, bytes: a.takeSnapshotBytes() })
      scriptInputs(inputs, t)
      a.step(inputs)
      b.step(inputs)
      const ha = a.stateHash()
      hashes.push(ha)
      if (ha !== b.stateHash()) {
        mismatches++
        if (notes.length < 5) notes.push(`A/B differ at tick ${t + 1}`)
      }
    }
    for (const s of saved) {
      const c = createGalleryWorld(R, course, ALL_SPAWNS).world
      try {
        c.restoreSnapshotBytes(s.bytes)
        const n = Math.min(RESTORE_EVERY, TICKS - s.k)
        for (let i = 0; i < n; i++) c.step(scriptInputs(inputs, s.k + i))
        restores++
        if (c.tick !== s.k + n || c.stateHash() !== hashes[s.k + n]) {
          mismatches++
          if (notes.length < 5) notes.push(`restore at ${s.k} differs after ${n} ticks`)
        }
      } finally {
        c.free()
      }
    }
  } finally {
    a.free()
    b.free()
  }
  return { value: `mismatches=${mismatches} ticks=${TICKS} restores=${restores}`, threshold: 'mismatches=0', pass: mismatches === 0, notes }
}

// QB9: real per-tick cost, measured alone in the parent before any check runs.
async function reportCost(mode: ProofMode): Promise<void> {
  const R = await getRapier()
  const course = await loadCourseFile(GALLERY)
  const world = createGalleryWorld(R, course, ALL_SPAWNS).world
  const inputs = ALL_SPAWNS.map(() => neutralInput())
  const stepMs: number[] = []
  const snapMs: number[] = []
  const restoreMs: number[] = []
  let snapshotBytes = 0
  try {
    for (let t = 0; t < TICKS; t++) {
      scriptInputs(inputs, world.tick)
      const t0 = performance.now()
      world.step(inputs)
      const t1 = performance.now()
      const bytes = world.takeSnapshotBytes()
      const t2 = performance.now()
      world.restoreSnapshotBytes(bytes)
      const t3 = performance.now()
      stepMs.push(t1 - t0)
      snapMs.push(t2 - t1)
      restoreMs.push(t3 - t2)
      snapshotBytes = bytes.length
    }
  } finally {
    world.free()
  }
  const mean = (v: number[]): string => (v.reduce((s, x) => s + x, 0) / v.length).toFixed(4)
  const p99 = (v: number[]): string => percentile(v, 99).toFixed(4)
  report('cost', {
    stepMeanMs: mean(stepMs),
    stepP99Ms: p99(stepMs),
    snapshotMeanMs: mean(snapMs),
    snapshotP99Ms: p99(snapMs),
    restoreMeanMs: mean(restoreMs),
    restoreP99Ms: p99(restoreMs),
    snapshotBytes,
    characters: ALL_SPAWNS.length,
    obstacles: course.obstacles.length,
    ticks: TICKS,
    machine: cpus()[0]?.model ?? 'unknown',
    mode,
  })
}

const checks: ProofCheck[] = [
  { label: 'codec', inQuick: true, run: async () => checkCodec() },
  { label: 'behaviours', inQuick: true, run: () => checkBehaviours() },
  { label: 'replay-golden', inQuick: true, run: (_mode, args) => checkReplayGolden(args) },
  { label: 'determinism', inQuick: true, run: () => checkDeterminism() },
]

const parsed = parseProofArgs(process.argv.slice(2))
if (!parsed.child && (parsed.only === null || parsed.only.test('cost'))) await reportCost(parsed.mode)
await runProof('m3-character', import.meta.url, checks)
