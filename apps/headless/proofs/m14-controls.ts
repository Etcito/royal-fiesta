// Ported V0 M14 proof (docs/v0-port.md): playable third-person controls. V0 drove a CDP Chrome over
// tools/controlsProbe.ts and judged its record with tools/controlsRecord.ts; neither is on main (no
// CDP Chrome in the sandbox), so:
// - camera-relative-maths: the orbit camera and camera basis unit tests (padMap.test.ts is not on main);
// - cdp-camera-relative: V0's top sequence (KeyW/KeyZ move, mouse turn, KeyW/KeyZ move) replayed on the
//   modules game.html runs (OrbitCamera.mouse, controlsToInput; settings controlsFromKeys has GameInput's
//   key rules, KeyZ included), judged with V0's constants. V0 expected the mouse-right turn at +90 deg
//   (mirrored); ARCHITECTURE 1.6 turns the view toward screen-right r = (-fz, 0, fx), which is -90 deg on
//   V0's angle, so the assertion is -90 +/- 10;
//   [full] the controlsProbe GPU op on the published apps/web/dist judges the same convention on the
//   real page, from the record of THIS run (proofs/m14/controls-gpu.json);
// - frame-pointer-lock: main has no frame probe; the committed V0 record is judged as V0 did (reported).
// The proof never builds: a missing apps/web/dist fails the GPU check with the fix.
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Planar } from '@royal-fiesta/game/client/cameraBasis'
import { controlsToInput } from '@royal-fiesta/game/client/inputMap'
import { OrbitCamera } from '@royal-fiesta/game/render/orbitCamera'
import { controlsFromKeys, DEFAULT_SETTINGS } from '@royal-fiesta/game/screens/settings'
import { neutralInput } from '@royal-fiesta/sim/input'
import { repoRoot } from '../../../tools/bricks.ts'
import { publishDist, renderOp } from '../src/gpuClient.ts'
import { unwrapOp } from '../src/gpuRecord.ts'
import { report, runProof } from '../src/proofkit.ts'
import type { CheckResult, ProofCheck } from '../src/proofkit.ts'

const root = repoRoot()
const started = performance.now()
const out = join(root, 'out/m14')
const dist = join(root, 'apps/web/dist')
const TEST_KILL_MS = 30_000
const TESTS = ['packages/game/test/orbitCamera.test.ts', 'packages/game/test/cameraBasis.test.ts']
const FRAME_RECORD = 'proofs/m14/frame-pointer-lock.json'
const GPU_RECORD = 'proofs/m14/controls-gpu.json'

// V0 tools/controlsRecord.ts constants. TURN_DEG carries the TRUE sign (ARCHITECTURE 1.6); V0 had +90.
const MIN_VECTOR_M = 0.05
const TURN_DEG = -90
const TURN_TOL_DEG = 10
const MOVE_TOL_DEG = 15
const MOUSE_STEP_PX = 20
const MAX_MOUSE_STEPS = 200
const FORWARD_KEYS = ['KeyW', 'KeyZ'] as const

interface Run { code: number | null; killed: boolean; ms: number; out: string }

// One child with a hard kill: no check waits longer than its timeout.
function run(args: string[], killMs: number): Promise<Run> {
  return new Promise(resolve => {
    const t0 = performance.now()
    const child = spawn(process.execPath, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
    let text = ''
    let killed = false
    const keep = (chunk: Buffer) => { text = (text + chunk.toString()).slice(-16_000) }
    child.stdout.on('data', keep)
    child.stderr.on('data', keep)
    const timer = setTimeout(() => { killed = true; child.kill('SIGKILL') }, killMs)
    child.on('error', e => { clearTimeout(timer); resolve({ code: -1, killed, ms: performance.now() - t0, out: `${text}\n${e.message}` }) })
    child.on('close', code => { clearTimeout(timer); resolve({ code, killed, ms: performance.now() - t0, out: text }) })
  })
}

const tail = (text: string, n = 20): string[] => text.trim().split('\n').slice(-n)
const exitText = (r: Run): string => r.killed ? `killed after ${Math.round(r.ms / 1000)} s` : `exit=${r.code}`

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
}

async function cameraRelativeMaths(): Promise<CheckResult> {
  const r = await run(['--experimental-strip-types', '--test', ...TESTS], TEST_KILL_MS)
  // Both the tap ('# pass N') and the spec ('ℹ pass N') reporters print the counts.
  const count = (name: string): string => r.out.match(new RegExp(`^(?:#|ℹ) ${name} (\\d+)`, 'm'))?.[1] ?? '?'
  const pass = r.code === 0 && !r.killed
  return {
    value: `pass=${count('pass')} fail=${count('fail')} ${exitText(r)}`,
    threshold: 'orbitCamera.test.ts + cameraBasis.test.ts exit 0 within 30 s',
    pass,
    notes: [
      'V0 also ran packages/game/test/padMap.test.ts (the gamepad proof); main has no padMap module, the pad cases run in the controlsProbe op',
      ...(pass ? [] : tail(r.out)),
    ],
  }
}

// ---- cdp-camera-relative: V0's top sequence on the game.html modules ----------------------------------------

const wrapDeg = (d: number): number => ((d + 540) % 360) - 180
// V0 angleDeg: positive turns +Z toward +X.
const angleDeg = (a: Planar, b: Planar): number => Math.atan2(a.z * b.x - a.x * b.z, a.x * b.x + a.z * b.z) * 180 / Math.PI

interface Sequence { key: string; turnDeg: number; moveRotDeg: number; move1: Planar; move2: Planar; steps: number }

function moveFor(key: string, orbit: OrbitCamera): Planar {
  const input = controlsToInput(controlsFromKeys(new Set([key]), DEFAULT_SETTINGS), orbit.ground(), neutralInput())
  return { x: input.moveX, z: input.moveZ }
}

// The mouse moves right in V0's 20 px steps until the camera forward has turned 90 deg either way.
function topSequence(key: string): Sequence {
  const orbit = new OrbitCamera()
  orbit.reset(0)
  const move1 = moveFor(key, orbit)
  const f1 = orbit.ground()
  let steps = 0
  let turnDeg = 0
  while (Math.abs(turnDeg) < Math.abs(TURN_DEG) && steps < MAX_MOUSE_STEPS) {
    orbit.mouse(MOUSE_STEP_PX, 0, DEFAULT_SETTINGS.mouseSensitivity, DEFAULT_SETTINGS.invertY)
    steps++
    turnDeg = angleDeg(f1, orbit.ground())
  }
  const move2 = moveFor(key, orbit)
  return { key, turnDeg, moveRotDeg: angleDeg(move1, move2), move1, move2, steps }
}

function judgeSequence(s: Sequence): string[] {
  const problems: string[] = []
  for (const [name, v] of [['move1', s.move1], ['move2', s.move2]] as const) {
    if (Math.hypot(v.x, v.z) < MIN_VECTOR_M) problems.push(`${s.key} ${name} is ${Math.hypot(v.x, v.z).toFixed(3)} long (< ${MIN_VECTOR_M})`)
  }
  if (Math.abs(wrapDeg(s.turnDeg - TURN_DEG)) > TURN_TOL_DEG) {
    problems.push(`${s.key} turn ${s.turnDeg.toFixed(1)} deg is not ${TURN_DEG} +/- ${TURN_TOL_DEG} (mouse right turns the view toward screen-right)`)
  }
  if (Math.abs(wrapDeg(s.moveRotDeg - s.turnDeg)) > MOVE_TOL_DEG) {
    problems.push(`${s.key} move rotated ${s.moveRotDeg.toFixed(1)} deg, not within ${MOVE_TOL_DEG} deg of the ${s.turnDeg.toFixed(1)} deg turn`)
  }
  return problems
}

async function cdpCameraRelative(): Promise<CheckResult> {
  const runs = FORWARD_KEYS.map(topSequence)
  const problems = runs.flatMap(judgeSequence)
  for (const s of runs) {
    report('cdp-camera-relative', { key: s.key, turnDeg: s.turnDeg.toFixed(2), moveRotDeg: s.moveRotDeg.toFixed(2), mouseSteps: s.steps })
  }
  return {
    value: runs.map(s => `${s.key}:turn=${s.turnDeg.toFixed(1)} move=${s.moveRotDeg.toFixed(1)}`).join(' '),
    threshold: `each KeyW/KeyZ mouse-right turn ${TURN_DEG} +/- ${TURN_TOL_DEG} deg (toward screen-right, ARCHITECTURE 1.6); move rotated within ${MOVE_TOL_DEG} deg of the turn`,
    pass: problems.length === 0,
    notes: [
      ...problems,
      'replayed on OrbitCamera.mouse + controlsFromKeys + controlsToInput (the game.html frame); V0 drove CDP Chrome, absent here',
      'V0 asserted +90 deg (the mirrored sign); fixed to -90 deg on the same angle',
    ],
  }
}

// ---- [full] the controlsProbe GPU op on the published build: the same convention on the real page --------

const MIN_SHIFT_PX = 20
const PROBE_COURSE = 'race-bean-dash'
const PROBE_CASES = [
  { input: 'KeyD', expect: 'right' }, { input: 'ArrowRight', expect: 'right' }, { input: 'stickRight', expect: 'right' },
  { input: 'KeyA', expect: 'left' }, { input: 'ArrowLeft', expect: 'left' }, { input: 'stickLeft', expect: 'left' },
  // A view turning right moves the centre marker left on screen.
  { input: 'mouseRight', expect: 'left' }, { input: 'rightStickRight', expect: 'left' },
] as const

function probeProblem(c: Record<string, unknown>, expect: 'right' | 'left'): string | null {
  const before = c.beforeX
  const after = c.afterX
  if (typeof before !== 'number' || typeof after !== 'number' || !Number.isFinite(before) || !Number.isFinite(after)) {
    return `beforeX/afterX are not finite numbers (${JSON.stringify(before)}, ${JSON.stringify(after)})`
  }
  const shift = `afterX ${after.toFixed(1)} vs beforeX ${before.toFixed(1)}`
  if (expect === 'right' && !(after > before + MIN_SHIFT_PX)) return `${shift}: must move > ${MIN_SHIFT_PX} px right`
  if (expect === 'left' && !(after < before - MIN_SHIFT_PX)) return `${shift}: must move > ${MIN_SHIFT_PX} px left`
  const captures = Array.isArray(c.captures) ? c.captures.map(object) : []
  if (captures.length === 0) return 'no captures'
  const empty = captures.filter(k => k?.nonEmpty !== true).map(k => String(k?.name ?? '?'))
  return empty.length > 0 ? `empty captures: ${empty.join(', ')}` : null
}

async function gpuCameraRelative(): Promise<CheckResult> {
  const threshold = `renderer raa; ${PROBE_CASES.length} cases: right inputs > ${MIN_SHIFT_PX} px right, left inputs and view-right turns > ${MIN_SHIFT_PX} px left; non-empty captures`
  const missing = ['game.html', 'nmc.gpu.json'].filter(f => !existsSync(join(dist, f)))
  if (missing.length) {
    return { value: `no apps/web/dist/${missing.join(', ')}`, threshold, pass: false, notes: ['the production build is absent; fix: npm run build (this proof does not build)'] }
  }
  const ops = object(object(JSON.parse(readFileSync(join(dist, 'nmc.gpu.json'), 'utf8')) as unknown)?.ops) ?? {}
  if (!('controlsProbe' in ops)) return { value: 'controlsProbe undeclared', threshold, pass: false, notes: ['apps/web/dist/nmc.gpu.json does not declare controlsProbe; rebuild'] }
  const pageRef = await publishDist(dist)
  const input = { width: 1280, height: 720, content: 'v0', course: PROBE_COURSE, cases: PROBE_CASES.map(c => ({ name: c.input, input: c.input, holdMs: 1000 })) }
  const result = await renderOp('controlsProbe', input, out, 'controls-probe', pageRef)
  const { out: data } = unwrapOp(result, 'cases')
  await mkdir(join(root, 'proofs/m14'), { recursive: true })
  await writeFile(join(root, GPU_RECORD), JSON.stringify({ ...data, pageRef }, null, 2) + '\n')
  const cases = Array.isArray(data.cases) ? data.cases.map(object) : []
  const notes: string[] = []
  for (const want of PROBE_CASES) {
    const c = cases.find(k => k?.input === want.input) ?? null
    const problem = c === null ? 'no case in the op output' : probeProblem(c, want.expect)
    if (problem !== null) notes.push(`${want.input}: ${problem}`)
  }
  if (data.renderer !== 'raa') notes.push(`renderer is ${JSON.stringify(data.renderer)}, not raa`)
  return {
    value: `cases=${cases.length} wrong=${notes.length} software=${String(data.software)}`,
    threshold, pass: notes.length === 0,
    notes: [...notes, `pageRef=${pageRef}`, `record: ${GPU_RECORD}`, `captures: out/m14 (review items)`],
  }
}

// ---- frame-pointer-lock: the V0 local-frame record (main has no frame probe) -----------------------------

async function framePointerLock(): Promise<CheckResult> {
  const threshold = 'a definite pointer-lock result for each local frame variant (reported, not thresholded)'
  const path = join(root, FRAME_RECORD)
  if (!existsSync(path)) return { value: `no ${FRAME_RECORD}`, threshold, pass: false }
  const record = object(JSON.parse(readFileSync(path, 'utf8')) as unknown) ?? {}
  const variants = Array.isArray(record.variants) ? record.variants.map(object) : []
  // V0 judgeFrame: every variant reports a boolean pointerLocked; an empty run is not a result.
  const undecided = variants.filter(v => typeof v?.pointerLocked !== 'boolean').length
  variants.forEach((v, i) => report('frame-pointer-lock', {
    variant: i, sandbox: JSON.stringify(v?.sandbox), pointerLocked: String(v?.pointerLocked), lockError: JSON.stringify(v?.lockError),
  }))
  const notes = ['local emulation only: the real Wavedash frame is not probed (docs/wavedash.md, Pointer lock in the frame)']
  if (typeof record.error === 'string') notes.push(`incomplete: ${record.error}`)
  return { value: `variants=${variants.length} undecided=${undecided}`, threshold, pass: variants.length > 0 && undecided === 0, notes }
}

const checks: ProofCheck[] = [
  { label: 'camera-relative-maths', inQuick: true, run: cameraRelativeMaths },
  { label: 'cdp-camera-relative', inQuick: true, run: cdpCameraRelative },
  { label: 'gpu-camera-relative', inQuick: false, run: gpuCameraRelative },
  { label: 'frame-pointer-lock', inQuick: false, run: framePointerLock },
]
try { await runProof('m14-controls', import.meta.url, checks) }
finally { report('m14-controls', { wallMs: Math.round(performance.now() - started) }) }
process.exit(process.exitCode ?? 0)
