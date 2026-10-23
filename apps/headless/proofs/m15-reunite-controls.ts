import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { cameraBasis } from '@royal-fiesta/game/client/cameraBasis'
import { controlsToInput, emptyControls } from '@royal-fiesta/game/client/inputMap'
import type { RawControls } from '@royal-fiesta/game/client/inputMap'
import { OrbitCamera } from '@royal-fiesta/game/render/orbitCamera'
import type { CameraPose, Vec3T } from '@royal-fiesta/game/render/port'
import { neutralInput } from '@royal-fiesta/sim/input'
import { report, runProof } from '@royal-fiesta/headless/proofkit'
import type { CheckResult, ProofCheck } from '@royal-fiesta/headless/proofkit'
import { repoRoot } from '../../../tools/bricks.ts'
import { leakScan } from '../../../tools/guard.ts'

// QB10 (left/right follow the screen) and QB13 (clean clone), all offline: the GPU and clone
// runs are programmatic cards whose committed records are checked here.

const WIDTH = 1280
const HEIGHT = 720
const YAWS = 8
const MIN_SHIFT_PX = 20
// Same per-frame look steps as the controlsProbe op (apps/web/src/game/ops.ts).
const MOUSE_PX = 8
const RIGHT_STICK_X = 0.5
const SENSITIVITY = 5
const MARKER_BEYOND_M = 4
const PLAYER = { x: 2, y: 0.5, z: -3 }
const DIST_PAGES = ['game.html', 'play.html', 'client.html', 'nmc.gpu.json']
const DIST_OPS = ['controlsProbe', 'gameCapture']
const CONTROLS_FILE = 'proofs/m15/controls.json'
const CLEAN_CLONE_FILE = 'proofs/m15/clean-clone.json'

type MoveInput = 'KeyD' | 'ArrowRight' | 'stickRight' | 'KeyA' | 'ArrowLeft' | 'stickLeft'
type TurnInput = 'mouseRight' | 'rightStickRight'
type ControlInput = MoveInput | TurnInput

const MOVES: readonly { input: MoveInput; side: 1 | -1; raw: Partial<RawControls> }[] = [
  { input: 'KeyD', side: 1, raw: { right: true } },
  { input: 'ArrowRight', side: 1, raw: { right: true } },
  { input: 'stickRight', side: 1, raw: { stickX: 1 } },
  { input: 'KeyA', side: -1, raw: { left: true } },
  { input: 'ArrowLeft', side: -1, raw: { left: true } },
  { input: 'stickLeft', side: -1, raw: { stickX: -1 } },
]

const TURNS: readonly { input: TurnInput; step(c: OrbitCamera): void }[] = [
  { input: 'mouseRight', step: c => c.mouse(MOUSE_PX, 0, SENSITIVITY, false) },
  { input: 'rightStickRight', step: c => c.stick(RIGHT_STICK_X, 0, 1 / 60, SENSITIVITY, false) },
]

const RIGHT_INPUTS: readonly ControlInput[] = ['KeyD', 'ArrowRight', 'stickRight']
const LEFT_INPUTS: readonly ControlInput[] = ['KeyA', 'ArrowLeft', 'stickLeft']
const VIEW_INPUTS: readonly ControlInput[] = ['mouseRight', 'rightStickRight']
const ALL_INPUTS: readonly ControlInput[] = [...RIGHT_INPUTS, ...LEFT_INPUTS, ...VIEW_INPUTS]

// ---- CPU projection (same maths as raa-math look_at_rh + an RH perspective, as in cameraBasis.test) ----

type V3 = [number, number, number]
const sub = (a: Vec3T, b: Vec3T): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const dot = (a: Vec3T, b: Vec3T) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a: Vec3T, b: Vec3T): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const norm = (a: Vec3T): V3 => { const l = Math.sqrt(dot(a, a)); return [a[0] / l, a[1] / l, a[2] / l] }

// View rows s, u, -f with translation -dot(row, eye); returns screen x in pixels, or NaN off the depth range.
function screenX(p: CameraPose, w: Vec3T): number {
  const f = norm(sub(p.target, p.eye))
  const s = norm(cross(f, [0, 1, 0]))
  const vx = dot(s, w) - dot(s, p.eye)
  const vz = -dot(f, w) + dot(f, p.eye)
  if (!(-vz > p.near && -vz < p.far)) return Number.NaN
  const fy = 1 / Math.tan((p.fovYDeg * Math.PI / 180) / 2)
  const ndc = (fy / (WIDTH / HEIGHT)) * vx / -vz
  return ((ndc + 1) / 2) * WIDTH
}

async function checkBasis(): Promise<CheckResult> {
  const notes: string[] = []
  let wrong = 0
  let cases = 0
  const input = neutralInput()
  for (let k = 0; k < YAWS; k++) {
    const deg = k * 45
    for (const m of MOVES) {
      const cam = new OrbitCamera()
      cam.reset(deg * Math.PI / 180)
      const pose = cam.pose(PLAYER)
      const facing = cameraBasis(pose.eye, pose.target).forward
      controlsToInput({ ...emptyControls(), ...m.raw }, facing, input)
      const player: Vec3T = [PLAYER.x, PLAYER.y, PLAYER.z]
      const moved: Vec3T = [PLAYER.x + input.moveX, PLAYER.y, PLAYER.z + input.moveZ]
      const px = screenX(pose, player)
      const mx = screenX(pose, moved)
      cases++
      const ok = m.side > 0 ? mx > px : mx < px
      if (!ok) {
        wrong++
        notes.push(`yaw ${deg} ${m.input}: player x=${px.toFixed(1)} moved x=${mx.toFixed(1)}, expected ${m.side > 0 ? 'right' : 'left'}`)
      }
    }
    for (const t of TURNS) {
      const cam = new OrbitCamera()
      cam.reset(deg * Math.PI / 180)
      const before = cam.pose(PLAYER)
      // A fixed world marker on the view ray beyond the target starts at screen centre.
      const ray = norm(sub(before.target, before.eye))
      const marker: Vec3T = [0, 1, 2].map(i => before.target[i]! + ray[i]! * MARKER_BEYOND_M) as unknown as Vec3T
      const bx = screenX(before, marker)
      t.step(cam)
      const ax = screenX(cam.pose(PLAYER), marker)
      cases++
      if (!(ax < bx)) {
        wrong++
        notes.push(`yaw ${deg} ${t.input}: marker x ${bx.toFixed(1)} -> ${ax.toFixed(1)}, expected it to move left`)
      }
    }
  }
  report('basis', { cases, yaws: YAWS, moves: MOVES.length, turns: TURNS.length })
  return { value: String(wrong), threshold: '0', pass: wrong === 0 && cases === YAWS * (MOVES.length + TURNS.length), notes }
}

// ---- web-build -----------------------------------------------------------------------------------------

async function readJson(abs: string): Promise<unknown> {
  return JSON.parse(await readFile(abs, 'utf8')) as unknown
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

async function checkWebBuild(): Promise<CheckResult> {
  const dist = join(repoRoot(), 'apps/web/dist')
  if (!existsSync(dist)) {
    return { value: 'no-dist', threshold: 'dist present', pass: false, notes: ['apps/web/dist is missing: run npm run build'] }
  }
  const missing = DIST_PAGES.filter(f => !existsSync(join(dist, f)))
  const notes = missing.map(f => `apps/web/dist/${f} is missing: run npm run build`)
  // The GPU client serves dist under a sub-path: a root-absolute script URL never loads and no op is defined.
  if (!missing.includes('game.html') && /(?:src|href)="\//.test(await readFile(join(dist, 'game.html'), 'utf8'))) {
    missing.push('relative-urls')
    notes.push(`apps/web/dist/game.html loads assets from /: set base './' in apps/web/vite.config.ts, then run npm run build`)
  }
  if (!missing.includes('nmc.gpu.json')) {
    let ops: string[] = []
    try {
      const gpu = await readJson(join(dist, 'nmc.gpu.json'))
      const raw = isObject(gpu) ? gpu.ops : undefined
      // The ops are an object keyed by name (or a plain list of names).
      if (Array.isArray(raw)) ops = raw.filter((o): o is string => typeof o === 'string')
      else if (isObject(raw)) ops = Object.keys(raw)
    } catch (e) {
      notes.push(`apps/web/dist/nmc.gpu.json does not parse: ${(e as Error).message}`)
    }
    for (const op of DIST_OPS) {
      if (!ops.includes(op)) {
        missing.push(`op:${op}`)
        notes.push(`apps/web/dist/nmc.gpu.json does not declare ${op}: check apps/web/public/nmc.gpu.json, then run npm run build`)
      }
    }
  }
  const value = missing.length === 0 && notes.length === 0 ? 'complete' : `missing=[${missing.join(',')}]`
  return { value, threshold: `[${[...DIST_PAGES, ...DIST_OPS.map(o => 'op:' + o)].join(',')}]`, pass: value === 'complete', notes }
}

// ---- controls-gpu (S17 record of the controlsProbe op) ---------------------------------------------------

function adapterLabelled(rec: Record<string, unknown>): boolean {
  if (typeof rec.software !== 'boolean') return false
  const a = rec.adapter
  if (typeof a === 'string') return a.trim().length > 0
  if (!isObject(a)) return false
  return ['vendor', 'architecture', 'description'].some(k => typeof a[k] === 'string' && (a[k] as string).trim().length > 0)
}

function caseProblem(c: Record<string, unknown>): string | null {
  const input = c.input as ControlInput
  const before = c.beforeX
  const after = c.afterX
  if (typeof before !== 'number' || typeof after !== 'number' || !Number.isFinite(before) || !Number.isFinite(after)) {
    return `beforeX/afterX are not finite numbers (${JSON.stringify(before)}, ${JSON.stringify(after)})`
  }
  const view = VIEW_INPUTS.includes(input)
  if (c.subject !== (view ? 'view' : 'character')) return `subject is ${JSON.stringify(c.subject)}, expected ${view ? 'view' : 'character'}`
  const shift = `afterX ${after.toFixed(1)} vs beforeX ${before.toFixed(1)}`
  if (RIGHT_INPUTS.includes(input) && !(after > before + MIN_SHIFT_PX)) return `${shift}: the character must move > ${MIN_SHIFT_PX} px right`
  if (LEFT_INPUTS.includes(input) && !(after < before - MIN_SHIFT_PX)) return `${shift}: the character must move > ${MIN_SHIFT_PX} px left`
  if (view && !(after < before - MIN_SHIFT_PX)) return `${shift}: the centre marker must move > ${MIN_SHIFT_PX} px left (view turns right)`
  const captures = Array.isArray(c.captures) ? c.captures : []
  if (captures.length === 0) return 'no captures'
  const empty = captures.filter(k => !isObject(k) || k.nonEmpty !== true).map(k => (isObject(k) ? String(k.name) : '?'))
  if (empty.length > 0) return `empty captures: ${empty.join(', ')}`
  return null
}

async function checkControlsGpu(): Promise<CheckResult> {
  const threshold = `0 wrong cases (${ALL_INPUTS.length} inputs, shift > ${MIN_SHIFT_PX} px, non-empty captures, labelled adapter)`
  const abs = join(repoRoot(), CONTROLS_FILE)
  if (!existsSync(abs)) return { value: 'no-record', threshold, pass: false, notes: [`${CONTROLS_FILE} is missing: run the GPU card (controlsProbe)`] }
  const rec = await readJson(abs)
  if (!isObject(rec) || !Array.isArray(rec.cases)) {
    return { value: 'bad-record', threshold, pass: false, notes: [`${CONTROLS_FILE}: no cases array; rerun the GPU card`] }
  }
  const notes: string[] = []
  let wrong = 0
  if (!adapterLabelled(rec)) {
    wrong++
    notes.push(`${CONTROLS_FILE}: the adapter is not labelled (adapter name and software flag)`)
  }
  const seen = new Set<string>()
  for (const c of rec.cases) {
    if (!isObject(c) || !ALL_INPUTS.includes(c.input as ControlInput)) {
      wrong++
      notes.push(`unknown case ${JSON.stringify(isObject(c) ? c.input : c)}`)
      continue
    }
    seen.add(c.input as string)
    const problem = caseProblem(c)
    if (problem !== null) {
      wrong++
      notes.push(`${String(c.name)} (${String(c.input)}): ${problem}`)
    }
  }
  for (const input of ALL_INPUTS) {
    if (!seen.has(input)) {
      wrong++
      notes.push(`no case for ${input}: add it to proofs/m15/controls.input.json and rerun the GPU card`)
    }
  }
  report('controls-gpu', { cases: rec.cases.length, software: String(rec.software) })
  return { value: String(wrong), threshold, pass: wrong === 0, notes }
}

// ---- clean-clone (S17 record of tools/cleanClone.ts) --------------------------------------------------

async function checkCleanClone(): Promise<CheckResult> {
  const threshold = '0 problems (every step exit 0, httpStatus 200, leakScan clean)'
  const abs = join(repoRoot(), CLEAN_CLONE_FILE)
  if (!existsSync(abs)) {
    return { value: 'no-record', threshold, pass: false, notes: [`${CLEAN_CLONE_FILE} is missing: run the clean-clone card (tools/cleanClone.ts --out ${CLEAN_CLONE_FILE})`] }
  }
  const text = await readFile(abs, 'utf8')
  const rec = JSON.parse(text) as unknown
  const notes: string[] = []
  if (!isObject(rec) || !Array.isArray(rec.steps) || rec.steps.length === 0) {
    return { value: 'bad-record', threshold, pass: false, notes: [`${CLEAN_CLONE_FILE}: no steps; rerun the clean-clone card`] }
  }
  for (const s of rec.steps) {
    if (!isObject(s) || s.exit !== 0) notes.push(`step ${JSON.stringify(isObject(s) ? s.cmd : s)} exited ${JSON.stringify(isObject(s) ? s.exit : null)}`)
  }
  if (rec.httpStatus !== 200) notes.push(`httpStatus is ${JSON.stringify(rec.httpStatus)}, expected 200`)
  // The hit excerpts are masked, so printing them never repeats the leak.
  for (const hit of leakScan(text)) notes.push(`leak ${hit.pattern} at ${hit.index}: ${hit.excerpt}`)
  report('clean-clone', { steps: rec.steps.length, httpStatus: String(rec.httpStatus) })
  return { value: String(notes.length), threshold, pass: notes.length === 0, notes }
}

const checks: ProofCheck[] = [
  { label: 'basis', inQuick: true, run: checkBasis },
  { label: 'web-build', inQuick: true, run: checkWebBuild },
  { label: 'controls-gpu', inQuick: true, run: checkControlsGpu },
  { label: 'clean-clone', inQuick: true, run: checkCleanClone },
]

await runProof('m15-reunite-controls', import.meta.url, checks)
