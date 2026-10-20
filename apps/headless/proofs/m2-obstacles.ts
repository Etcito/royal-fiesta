// M2 Course data and parametric obstacles proof: gallery validity, refusals, pose golden, determinism.
import { existsSync } from 'node:fs'
import { readdir, writeFile } from 'node:fs/promises'
import { cpus } from 'node:os'
import type { SnapReader, SnapWriter } from '@gamesaloon/rollback'
import { initRapier } from '@gamesaloon/rollback-rapier'
import type { BodyId, RapierModule } from '@gamesaloon/rollback-rapier'
import { MOTION_KINDS } from '@royal-fiesta/sim/course'
import type { MotionKind, ObstacleSpec, ResolvedCourse } from '@royal-fiesta/sim/course'
import { G, groups } from '@royal-fiesta/sim/groups'
import { ObstacleSystem } from '@royal-fiesta/sim/obstacles/system'
import { isRefusal } from '@royal-fiesta/sim/refusal'
import { FiestaWorld } from '@royal-fiesta/sim/world'
import type { SimSystem, WorldCtx } from '@royal-fiesta/sim/world'
import { loadCourseFile, readRepoText, repoPath } from '../src/files.ts'
import { hex8, report, runProof } from '../src/proofkit.ts'
import type { CheckResult, ProofArgs, ProofCheck, ProofMode } from '../src/proofkit.ts'

const GALLERY = 'fixtures/courses/obstacle-gallery.course.json'
const INVALID_DIR = 'fixtures/courses/invalid'
const OBSTACLES = 40
const MOVING_KINDS: readonly MotionKind[] = MOTION_KINDS.filter((k) => k !== 'static')
const PRIMITIVES: readonly string[] = ['cuboid', 'roundCuboid', 'ball', 'capsule', 'cylinder', 'cone']
const INVALID_COUNT = 4

function errorText(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : `non-error: ${String(e)}`
}

async function checkCourseValid(): Promise<CheckResult> {
  const threshold = `obstacles=${OBSTACLES} movingKinds=${MOVING_KINDS.length}/${MOVING_KINDS.length} nonPrimitive=0`
  try {
    const course = await loadCourseFile(GALLERY)
    const present = new Set<string>()
    let nonPrimitive = 0
    for (let i = 0; i < course.obstacles.length; i++) {
      const o = course.obstacles[i]
      present.add(o.motion.kind)
      for (let j = 0; j < o.colliders.length; j++) {
        if (!PRIMITIVES.includes(o.colliders[j].shape)) nonPrimitive++
      }
    }
    const missing = MOVING_KINDS.filter((k) => !present.has(k))
    const kinds = MOVING_KINDS.length - missing.length
    const n = course.obstacles.length
    return {
      value: `obstacles=${n} movingKinds=${kinds}/${MOVING_KINDS.length} nonPrimitive=${nonPrimitive}`,
      threshold,
      pass: n === OBSTACLES && kinds === MOVING_KINDS.length && nonPrimitive === 0,
      notes: missing.length > 0 ? [`missing kinds: ${missing.join(', ')}`] : [],
    }
  } catch (e) {
    if (!isRefusal(e)) throw e
    return { value: 'refused', threshold, pass: false, notes: [e.message] }
  }
}

async function checkRefusals(): Promise<CheckResult> {
  const names = (await readdir(repoPath(INVALID_DIR))).filter((f) => f.endsWith('.course.json')).sort()
  const notes: string[] = []
  let ok = 0
  let other = 0
  for (const name of names) {
    const rel = `${INVALID_DIR}/${name}`
    try {
      await loadCourseFile(rel)
      other++
      notes.push(`${rel}: resolved; expected a RefusalError`)
    } catch (e) {
      if (isRefusal(e) && e.message.includes(`${rel}#/`)) {
        ok++
        notes.push(e.message)
      } else if (isRefusal(e)) {
        notes.push(`${rel}: refusal lacks ${rel}#/: ${e.message}`)
      } else {
        other++
        notes.push(`${rel}: ${errorText(e)}`)
      }
    }
  }
  const total = names.length
  return {
    value: `${ok}/${total} refused with file#pointer, other=${other}`,
    threshold: `${INVALID_COUNT}/${INVALID_COUNT}, other=0`,
    pass: ok === INVALID_COUNT && total === INVALID_COUNT && other === 0,
    notes,
  }
}

// ---- Gallery world: obstacles plus 12 proof-local debris boxes on the see-saws, conveyors and platforms.

const GOLDEN = 'fixtures/golden/m2-obstacle-poses.json'
const REGENERATE = 'node --experimental-strip-types apps/headless/proofs/m2-obstacles.ts --only poses-golden --write-golden'
const GOLDEN_TICKS = [0, 1, 60, 600, 3600]
const TICKS = 3600
const RESTORE_EVERY = 97
const DEBRIS = 12
const DEBRIS_HALF = 0.3
const DEBRIS_MASS = 30
const DROP_HEIGHT = 1.5
const SEESAW_OFFSET_Z = 2.5
const DROP_IDS = ['seesaw-1', 'seesaw-2', 'seesaw-3', 'seesaw-4', 'conveyor-1', 'conveyor-2', 'conveyor-3', 'conveyor-4',
  'platform-1', 'platform-2', 'platform-3', 'platform-4']
const INPUTS: readonly unknown[] = [0]

// One Rapier init per process, shared by the world checks.
let rapier: Promise<RapierModule> | null = null
function getRapier(): Promise<RapierModule> {
  if (rapier === null) rapier = initRapier()
  return rapier
}

// Highest collider point of an obstacle in world Y (gallery obstacles start unrotated).
function topY(o: ObstacleSpec): number {
  let top = -Infinity
  for (const c of o.colliders) {
    let up = 0
    if (c.shape === 'cuboid') up = c.half.y
    else if (c.shape === 'roundCuboid') up = c.half.y + c.border
    else if (c.shape === 'ball') up = c.radius
    else if (c.shape === 'capsule') up = c.halfHeight + c.radius
    else up = c.halfHeight
    top = Math.max(top, o.t.y + c.t.y + up)
  }
  if (top === -Infinity) throw new Error(`obstacle ${o.id} has no collider to drop debris on`)
  return top
}

class DebrisSystem implements SimSystem<unknown> {
  readonly name = 'debris'
  readonly obstacles: ObstacleSystem
  #bodies: BodyId[] = []
  #seesaws: number[] = []

  constructor(obstacles: ObstacleSystem) {
    this.obstacles = obstacles
  }

  init(ctx: WorldCtx<unknown>): void {
    const obs = this.obstacles
    obs.load(ctx, 0)
    const R = ctx.R
    for (const id of DROP_IDS) {
      let idx = -1
      for (let i = 0; i < obs.count; i++) if (obs.spec(i).id === id) idx = i
      if (idx < 0) throw new Error(`gallery has no obstacle '${id}'`)
      const o = obs.spec(idx)
      const dz = o.motion.kind === 'seesaw' ? SEESAW_OFFSET_Z : 0
      const desc = R.RigidBodyDesc.dynamic().setTranslation(o.t.x, topY(o) + DROP_HEIGHT, o.t.z + dz).setAdditionalMass(DEBRIS_MASS)
      const col = R.ColliderDesc.cuboid(DEBRIS_HALF, DEBRIS_HALF, DEBRIS_HALF)
        .setFriction(0.6)
        .setRestitution(0)
        .setCollisionGroups(groups(G.DEBRIS, G.STATIC | G.MOVING | G.DEBRIS))
      this.#bodies.push(ctx.physics.createBody(desc, [col]))
    }
    for (let i = 0; i < obs.count; i++) if (obs.spec(i).motion.kind === 'seesaw') this.#seesaws.push(i)
  }

  preStep(_ctx: WorldCtx<unknown>, _inputs: readonly unknown[]): void {}

  // Debris resting on a see-saw becomes a load for the next tick's integration.
  postStep(ctx: WorldCtx<unknown>): void {
    const world = ctx.physics.world
    for (let d = 0; d < this.#bodies.length; d++) {
      const rb = ctx.physics.body(this.#bodies[d])
      const dc = rb.collider(0)
      for (let s = 0; s < this.#seesaws.length; s++) {
        const i = this.#seesaws[s]
        const sb = ctx.physics.body(this.obstacles.bodyId(i))
        let touching = false
        for (let k = 0; k < sb.numColliders(); k++) {
          world.contactPair(dc, sb.collider(k), (m) => { if (m.numContacts() > 0) touching = true })
        }
        if (touching) {
          const t = rb.translation()
          this.obstacles.addLoad(i, { x: t.x, y: t.y, z: t.z }, rb.mass())
        }
      }
    }
  }

  snapshot(w: SnapWriter): void {
    w.u32(DEBRIS)
  }

  restore(r: SnapReader, _ctx: WorldCtx<unknown>): void {
    const n = r.u32()
    if (n !== DEBRIS) throw new Error(`debris snapshot has ${n} boxes, expected ${DEBRIS}`)
  }
}

function createGalleryWorld(R: RapierModule, gallery: ResolvedCourse): { world: FiestaWorld<unknown>; obstacles: ObstacleSystem } {
  const obstacles = new ObstacleSystem([gallery])
  const world = new FiestaWorld<unknown>(R, { playerCount: 1, systems: [obstacles, new DebrisSystem(obstacles)] })
  return { world, obstacles }
}

interface GoldenRow { tick: number; entity: string; values: number[] }
interface Golden { format: string; version: number; name: string; regenerate: string; ticks: number[]; rows: GoldenRow[]; hash: string }

async function checkPosesGolden(args: ProofArgs): Promise<CheckResult> {
  const R = await getRapier()
  const gallery = await loadCourseFile(GALLERY)
  const { world, obstacles } = createGalleryWorld(R, gallery)
  const rows: GoldenRow[] = []
  let hash = ''
  try {
    for (const L of GOLDEN_TICKS) {
      while (world.tick < L) world.step(INPUTS)
      for (let i = 0; i < obstacles.count; i++) {
        const rb = world.physics.body(obstacles.bodyId(i))
        const t = rb.translation()
        const r = rb.rotation()
        rows.push({ tick: L, entity: obstacles.spec(i).id, values: [t.x, t.y, t.z, r.x, r.y, r.z, r.w] })
      }
    }
    hash = hex8(world.stateHash())
  } finally {
    world.free()
  }
  const g: Golden = { format: 'royal-fiesta.golden', version: 0, name: 'm2-obstacle-poses', regenerate: REGENERATE, ticks: GOLDEN_TICKS, rows, hash }
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

async function checkDeterminism(mode: ProofMode): Promise<CheckResult> {
  const R = await getRapier()
  const gallery = await loadCourseFile(GALLERY)
  const a = createGalleryWorld(R, gallery).world
  const b = createGalleryWorld(R, gallery).world
  const notes: string[] = []
  let mismatches = 0
  let restores = 0
  let stepSnapMs = 0
  let bytes = 0
  try {
    // hashes[t] = A's hash at tick t; restore points keep A's bytes at tick k.
    const hashes: number[] = [a.stateHash()]
    const saved: { k: number; bytes: Uint8Array }[] = []
    for (let t = 0; t < TICKS; t++) {
      if (t > 0 && t % RESTORE_EVERY === 0) saved.push({ k: t, bytes: a.takeSnapshotBytes() })
      const t0 = performance.now()
      a.step(INPUTS)
      bytes = a.takeSnapshotBytes().length
      stepSnapMs += performance.now() - t0
      b.step(INPUTS)
      const ha = a.stateHash()
      hashes.push(ha)
      if (ha !== b.stateHash()) {
        mismatches++
        if (notes.length < 5) notes.push(`A/B differ at tick ${t + 1}`)
      }
    }
    for (const s of saved) {
      const c = createGalleryWorld(R, gallery).world
      try {
        c.restoreSnapshotBytes(s.bytes)
        const n = Math.min(RESTORE_EVERY, TICKS - s.k)
        for (let i = 0; i < n; i++) c.step(INPUTS)
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
  report('m2-snapshot', {
    bytes,
    meanStepSnapshotMs: (stepSnapMs / TICKS).toFixed(4),
    obstacles: OBSTACLES,
    debris: DEBRIS,
    ticks: TICKS,
    machine: cpus()[0]?.model ?? 'unknown',
    mode,
  })
  return { value: `mismatches=${mismatches} ticks=${TICKS} restores=${restores}`, threshold: 'mismatches=0', pass: mismatches === 0, notes }
}

const checks: ProofCheck[] = [
  { label: 'course-valid', inQuick: true, run: () => checkCourseValid() },
  { label: 'refusals', inQuick: true, run: () => checkRefusals() },
  { label: 'poses-golden', inQuick: true, run: (_mode, args) => checkPosesGolden(args) },
  { label: 'determinism', inQuick: true, run: (mode) => checkDeterminism(mode) },
]

await runProof('m2-obstacles', import.meta.url, checks)
