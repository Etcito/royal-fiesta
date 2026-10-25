import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { initRapier } from '@gamesaloon/rollback-rapier'
import type { RapierModule } from '@gamesaloon/rollback-rapier'
import { parseGameAsset } from '@royal-fiesta/game/gameAsset'
import type { GameAsset } from '@royal-fiesta/game/gameAsset'
import { runMatchOffline } from '@royal-fiesta/sim/match/offline'
import type { MatchSetup } from '@royal-fiesta/sim/match/setup'
import { isRefusal, refuse } from '@royal-fiesta/sim/refusal'
import { loadAllCoursesV1, v1Playlist } from '@royal-fiesta/headless/contentFiles'
import { readRepoText, repoPath } from '@royal-fiesta/headless/files'
import { hex8, parseProofArgs, report, runProof } from '@royal-fiesta/headless/proofkit'
import type { CheckResult, ProofCheck } from '@royal-fiesta/headless/proofkit'
import { MAMA_ABSENT_PREFIX, mamaSource, repoRoot } from '../../../tools/bricks.ts'

import { publishDist, renderOp } from '@royal-fiesta/headless/gpuClient'
import type { OpResult } from '@royal-fiesta/headless/gpuClient'
import { secretsFromEnv } from '@royal-fiesta/headless/controlsGpu'
import { leakScan, redact } from '../../../tools/guard.ts'

// M3 SDF runtime. QB1: a headless v1 sprint match hashes the same with MAMA present and with the facade
// stubbed. QB11: every assets/*/ asset meshes through MAMA's declared mesher in Node. QB7: a refusal
// names the asset and group. The mesh-node threshold is full: MAMA's quad gap (docs/brick-gaps.md)
// keeps it failing until a pin bump or a content re-save, and is never lowered or skipped.

const MESH_TIMEOUT_MS = 300000
const SEED = 17
const PLAYERS = 8
const SIM_CASE_FLAG = '--sim-case'
const SIM_CASE = 'child'
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const PROOF_FILE = fileURLToPath(import.meta.url)
const MESH_NODE_URL = new URL('../src/mama/meshNode.ts', import.meta.url).href

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function tail(out: string, n: number): string[] {
  return out.split('\n').map(l => l.trimEnd()).filter(l => l.length > 0).slice(-n)
}

// Exit code and full output of a shell-free child at the repository root.
function runChild(cmd: string, args: string[], env: NodeJS.ProcessEnv = process.env): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    let out = ''
    const child = spawn(cmd, args, { cwd: repoRoot(), env, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (d: string) => { out += d })
    child.stderr.on('data', (d: string) => { out += d })
    child.on('error', (e) => resolve({ code: 1, out: out + e.message }))
    child.on('close', (code) => resolve({ code: code ?? 1, out }))
  })
}

// ---- sim-independence (first: the sim must never see MAMA) ---------------------------------------------

let rapier: Promise<RapierModule> | null = null
function getRapier(): Promise<RapierModule> {
  if (rapier === null) rapier = initRapier()
  return rapier
}

async function sprintSetup(): Promise<MatchSetup> {
  const humans: boolean[] = []
  for (let p = 0; p < PLAYERS; p++) humans.push(false)
  return { seed: SEED, playerCount: PLAYERS, humans, profile: 'sprint', courses: await v1Playlist('sprint') }
}

interface SimRun { finalHash: string; ticks: number; mama: string; stub: boolean }

// disabled = RF_MAMA_DISABLE=1: the facade is the typed stub, and the match must still hash the same.
async function simRun(disabled: boolean): Promise<SimRun> {
  let mama: string
  let stub = false
  if (disabled) {
    const absent = await import('../../web/src/mamaAbsent.ts')
    try {
      await absent.loadMama()
    } catch (e) {
      stub = isRefusal(e) && e.reason.startsWith(MAMA_ABSENT_PREFIX)
    }
    mama = 'disabled'
  } else {
    const source = mamaSource()
    mama = source.kind === 'absent' ? 'absent' : `${source.kind}:${source.commit ?? 'no-commit'}`
  }
  const result = runMatchOffline(await getRapier(), await sprintSetup())
  return { finalHash: hex8(result.finalHash), ticks: result.ticks, mama, stub }
}

async function runSimCase(): Promise<void> {
  const run = await simRun(process.env.RF_MAMA_DISABLE === '1')
  console.log(`[sim-independence] finalHash=${run.finalHash} ticks=${run.ticks} mama=${run.mama} stub=${run.stub ? 'ok' : 'none'}`)
}

async function checkSimIndependence(): Promise<CheckResult> {
  const notes: string[] = []
  const own = await simRun(false)
  const source = mamaSource()
  if (source.kind === 'absent') notes.push(`${MAMA_ABSENT_PREFIX}${source.reason}`)
  const child = await runChild(
    process.execPath,
    ['--experimental-strip-types', PROOF_FILE, SIM_CASE_FLAG, SIM_CASE],
    { ...process.env, RF_MAMA_DISABLE: '1' },
  )
  const m = /^\[sim-independence\] finalHash=([0-9a-f]{8}) ticks=(\d+) mama=(\S+) stub=(ok|none)$/m.exec(child.out)
  let childHash = 'none'
  let stubOk = false
  let disabledOk = false
  if (child.code !== 0 || m === null) {
    notes.push(`the RF_MAMA_DISABLE=1 child failed (exit ${child.code}): ${tail(child.out, 3).join(' | ')}`)
  } else {
    childHash = m[1]
    stubOk = m[4] === 'ok'
    disabledOk = m[3] === 'disabled'
    if (!stubOk) notes.push('the typed stub did not refuse in the RF_MAMA_DISABLE=1 child')
    if (!disabledOk) notes.push(`the child reports mama=${m[3]}, expected disabled`)
  }
  const same = childHash !== 'none' && own.finalHash === childHash
  if (!same) notes.push(`finalHash with MAMA (${own.finalHash}) differs from the stubbed child (${childHash})`)
  report('sim-independence', { parentHash: own.finalHash, childHash, ticks: own.ticks, mama: own.mama })
  return {
    value: `${own.finalHash} = ${childHash}`,
    threshold: 'equal finalHash and the typed stub refuses',
    pass: stubOk && disabledOk && same,
    notes,
  }
}

// ---- mama ----------------------------------------------------------------------------------------------

async function checkMama(): Promise<CheckResult> {
  const source = mamaSource()
  const threshold = 'MAMA resolved and npm run typecheck:mama exit 0'
  if (source.kind === 'absent') {
    report('mama', { source: 'absent', typecheck: 'not-run' })
    return { value: 'absent', threshold, pass: false, notes: [`${MAMA_ABSENT_PREFIX}${source.reason}`] }
  }
  const commit = source.commit ?? 'no-commit'
  const { code, out } = await runChild(NPM, ['run', 'typecheck:mama'])
  const notes = code === 0 ? [] : tail(out, 10)
  if (code !== 0 && !existsSync(repoPath('.bricks/MAMA'))) {
    notes.push('run npm run bricks -- fetch mama to link .bricks/MAMA (tsconfig.mama.json resolves @etcito/mama there)')
  }
  if (source.kind === 'sibling' && !source.matchesPin) {
    notes.push(`sibling HEAD ${commit} differs from the pinned commit in bricks.pins.json; WARN only`)
  }
  report('mama', { source: source.kind, commit, typecheck: code })
  return { value: `${source.kind} ${commit}; typecheck exit ${code}`, threshold, pass: code === 0, notes }
}

// ---- mesh-node -----------------------------------------------------------------------------------------

interface MeshNodeModule {
  meshGameAsset(asset: GameAsset, options?: { timeoutMs?: number }): Promise<{ parts: number; triangles: number }>
}

const ASSET_SUFFIX = '.asset.json'

async function assetFiles(): Promise<string[]> {
  const files: string[] = []
  for (const world of await readdir(repoPath('assets'), { withFileTypes: true })) {
    if (!world.isDirectory()) continue
    for (const file of await readdir(repoPath(`assets/${world.name}`), { withFileTypes: true })) {
      if (file.isFile() && file.name.endsWith(ASSET_SUFFIX)) files.push(`assets/${world.name}/${file.name}`)
    }
  }
  return files.sort()
}

async function checkMeshNode(): Promise<CheckResult> {
  const files = await assetFiles()
  const notes: string[] = []
  let meshed = 0
  let meshNode: MeshNodeModule | null = null
  try {
    // The root tsconfig excludes mama/ (it imports MAMA); the proof loads it by URL, as its test does.
    meshNode = (await import(MESH_NODE_URL)) as unknown as MeshNodeModule
  } catch (e) {
    notes.push(`apps/headless/src/mama/meshNode.ts did not load: ${messageOf(e)}`)
  }
  for (const path of files) {
    const id = path.slice(path.lastIndexOf('/') + 1, -ASSET_SUFFIX.length)
    if (meshNode === null) continue
    try {
      const asset = await parseGameAsset(JSON.parse(await readRepoText(path)) as unknown, path)
      const result = await meshNode.meshGameAsset(asset, { timeoutMs: MESH_TIMEOUT_MS })
      if (result.parts >= 1 && result.triangles > 0) meshed++
      else notes.push(`${id}: parts=${result.parts} triangles=${result.triangles}; every mesh needs parts >= 1 and triangles > 0`)
    } catch (e) {
      // A mesh refusal carries '<asset id>#<group id>' and MAMA's own reason, or 'timed out after <n> s'.
      notes.push(`${id}: ${messageOf(e)}`)
    }
  }
  report('mesh-node', { assets: files.length, meshed, timeoutMs: MESH_TIMEOUT_MS })
  return {
    value: `${meshed}/${files.length}`,
    threshold: `${files.length}/${files.length}`,
    pass: files.length > 0 && meshed === files.length,
    notes,
  }
}

// ---- GPU record verification (offline) -----------------------------------------------------------------

const CAPTURES_FILE = 'proofs/m17/sdf-match.json'
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
interface MeshedEntry { assetId: string; mesher: string; parts: number; triangles: number; cache: 'miss' | 'memory' | 'idb' }

function parseMeshed(report: unknown, where: string): MeshedEntry[] {
  if (!isObject(report) || !Array.isArray(report.meshed) || report.meshed.length === 0) {
    return refuse(GPU_AREA, where, 'has no meshed entries; rerun the SDF tour with reload')
  }
  const seen = new Set<string>()
  return report.meshed.map((line: unknown): MeshedEntry => {
    if (typeof line !== 'string') return refuse(GPU_AREA, where, 'meshed entry is not a string; pass the unmodified report')
    const fields = line.split('|')
    const [assetId, mesher, partsText, trianglesText, cache] = fields
    const parts = Number(partsText)
    const triangles = Number(trianglesText)
    if (fields.length !== 5 || !assetId || !mesher || seen.has(assetId)
      || !Number.isSafeInteger(parts) || parts < 1 || !Number.isSafeInteger(triangles) || triangles < 1
      || (cache !== 'miss' && cache !== 'memory' && cache !== 'idb')) {
      return refuse(GPU_AREA, where, 'invalid or duplicate meshed entry; expected id|mesher|parts|triangles|cache with positive counts')
    }
    seen.add(assetId)
    return { assetId, mesher, parts, triangles, cache }
  })
}

async function checkGpuMatch(): Promise<CheckResult> {
  const threshold = 'SDF tour and reload non-empty, all course assets meshed, cached reload, podium, no leaks'
  if (!existsSync(repoPath(CAPTURES_FILE))) {
    return { value: 'no record', threshold, pass: false, notes: [
      `${CAPTURES_FILE}: no record; run GPU card 5133 (game.html content sdf tour with reload, judged) after the SDF dependencies land`,
    ] }
  }
  const notes: string[] = []
  const text = await readRepoText(CAPTURES_FILE)
  const deny = (process.env.RF_GUARD_DENY ?? '').split(',').map(s => s.trim()).filter(Boolean)
  for (const hit of leakScan(text, [...secretsFromEnv(), ...deny])) notes.push(`leakScan ${hit.pattern} at ${hit.index}: ${hit.excerpt}`)
  let rec: unknown
  try { rec = JSON.parse(text) as unknown } catch {
    return { value: 'invalid JSON', threshold, pass: false, notes: ['sdf-match.json must be a valid GPU record'] }
  }
  if (!isObject(rec)) return { value: 'not an object', threshold, pass: false }
  if (rec.content !== 'sdf') notes.push("content must be 'sdf'")
  if (rec.renderer !== 'raa' || rec.frameTiming !== null) notes.push('expected RAA captures with frameTiming null')
  if (typeof rec.pageRef !== 'string' || !rec.pageRef.trim()) notes.push('pageRef is empty')
  if (!isObject(rec.adapter) || typeof rec.software !== 'boolean' || rec.adapter.software !== rec.software) notes.push('adapter and software must be labelled')
  const captures = Array.isArray(rec.captures) ? rec.captures.filter(isObject) : []
  for (const prefix of ['', 'reload-']) {
    for (const moment of ['loading', 'hub', 'match-5s', 'podium']) {
      const name = `${prefix}${moment}`
      const matches = captures.filter(c => c.name === name)
      if (matches.length !== 1 || matches[0].nonEmpty !== true || typeof matches[0].bytes !== 'number' || !(matches[0].bytes > 0)) {
        notes.push(`${name}: missing or empty capture`)
      }
    }
  }
  const expected = new Set<string>(['penguin.body'])
  const courses = await loadAllCoursesV1()
  for (const c of courses) {
    if (c.kind === 'hub' || c.kind === 'podium' || ((c.kind === 'race' || c.kind === 'survival') && c.sim?.profiles.includes('sprint'))) {
      for (const id of c.assetIds) expected.add(id)
    }
  }
  const meshed = isObject(rec.meshed) ? rec.meshed : {}
  for (const phase of ['first', 'reload']) {
    const entries = Array.isArray(meshed[phase]) ? meshed[phase] as unknown[] : []
    const seen = new Set<string>()
    for (const entry of entries) {
      if (!isObject(entry) || typeof entry.assetId !== 'string') { notes.push(`${phase}: invalid mesh entry`); continue }
      if (seen.has(entry.assetId)) notes.push(`${phase}: duplicate ${entry.assetId}`)
      seen.add(entry.assetId)
      if (typeof entry.mesher !== 'string' || !entry.mesher || !Number.isSafeInteger(entry.parts) || (entry.parts as number) < 1
        || !Number.isSafeInteger(entry.triangles) || (entry.triangles as number) < 1) notes.push(`${phase}: invalid mesh for ${entry.assetId}`)
      if (phase === 'first' ? entry.cache !== 'miss' : entry.cache !== 'memory' && entry.cache !== 'idb') notes.push(`${phase}: wrong cache for ${entry.assetId}`)
    }
    for (const id of expected) if (!seen.has(id)) notes.push(`${phase}: missing ${id}`)
  }
  const events = Array.isArray(rec.events) ? rec.events : []
  if (!events.some(e => isObject(e) && typeof e.what === 'string' && e.what.startsWith('podium '))) notes.push('no podium event from LocalDriver')
  return { value: String(notes.length), threshold, pass: notes.length === 0, notes }
}

const GPU_FLAG = '--gpu-run'
const GPU_AREA = 'm17-gpu'
const GPU_OP = 'gameCapture'
const CAPTURES_INPUT = 'proofs/m17/sdf-match.input.json'
const DIST_DIR = 'apps/web/dist'
const PNG_DIR = 'out/m17'

interface SizedCapture { name: string; width: number; height: number; sha256: string; bytes: number; nonEmpty: boolean }

function field<T>(ok: (v: unknown) => boolean, o: Record<string, unknown>, k: string, where: string, expect: string): T {
  if (!ok(o[k])) refuse(GPU_AREA, `${where}/${k}`, `${JSON.stringify(o[k])} is not ${expect}; pass the unmodified ${GPU_OP} output`)
  return o[k] as T
}
const isStr = (v: unknown): boolean => typeof v === 'string'
const isPosInt = (v: unknown): boolean => Number.isInteger(v) && (v as number) > 0

// The op output is the result itself, or the single object within 3 levels holding `captures`.
function opOutput(res: OpResult): { out: Record<string, unknown>; where: string } {
  if (isObject(res.json) && 'captures' in res.json) return { out: res.json, where: `${res.file}#` }
  const found: { out: Record<string, unknown>; where: string }[] = []
  const walk = (v: unknown, path: string, depth: number): void => {
    if (typeof v !== 'object' || v === null || depth > 3) return
    if (depth > 0 && isObject(v) && 'captures' in v) found.push({ out: v, where: path })
    for (const k of Object.keys(v)) walk((v as Record<string, unknown>)[k], `${path}/${k}`, depth + 1)
  }
  walk(res.json, `${res.file}#`, 0)
  if (found.length !== 1) refuse(GPU_AREA, `${res.file}#`, `${found.length} objects with "captures" within 3 levels; pass the result of exactly one ${GPU_OP} run`)
  return found[0]
}

// S10 + S17 record; every value is copied from the op output (pageRef is the published page_ref).
function capturesRecord(res: OpResult, input: Record<string, unknown>, pageRef: string): Record<string, unknown> {
  const { out, where } = opOutput(res)
  if (out.renderer !== 'raa') refuse(GPU_AREA, `${where}/renderer`, `${JSON.stringify(out.renderer)} is not 'raa'; record only RAA renders`)
  if (out.content !== input.content) refuse(GPU_AREA, `${where}/content`, `${JSON.stringify(out.content)} is not the input content; rerun with ${CAPTURES_INPUT}`)
  const a = field<Record<string, unknown>>(isObject, out, 'adapter', where, 'an adapter object')
  const aw = `${where}/adapter`
  const adapter = {
    vendor: field<string>(isStr, a, 'vendor', aw, 'a string'),
    architecture: field<string>(isStr, a, 'architecture', aw, 'a string'),
    description: field<string>(isStr, a, 'description', aw, 'a string'),
    software: field<boolean>(v => typeof v === 'boolean', a, 'software', aw, 'a boolean'),
  }
  if (out.software !== adapter.software) refuse(GPU_AREA, `${where}/software`, 'differs from adapter.software; pass the unmodified op output')
  const list = field<unknown[]>(v => Array.isArray(v) && v.length > 0, out, 'captures', where, 'a non-empty array')
  const captures = list.map((c, i): SizedCapture => {
    const cw = `${where}/captures/${i}`
    if (!isObject(c)) return refuse(GPU_AREA, cw, `is not an object; pass the unmodified ${GPU_OP} output`)
    return {
      name: field<string>(v => typeof v === 'string' && /^[A-Za-z0-9._-]{1,80}$/.test(v), c, 'name', cw, 'a file-safe name'),
      width: field<number>(isPosInt, c, 'width', cw, 'a positive integer'),
      height: field<number>(isPosInt, c, 'height', cw, 'a positive integer'),
      sha256: field<string>(v => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v), c, 'sha256', cw, 'a sha256 hex string'),
      bytes: field<number>(v => Number.isInteger(v) && (v as number) >= 0, c, 'bytes', cw, 'a byte count'),
      nonEmpty: field<boolean>(v => typeof v === 'boolean', c, 'nonEmpty', cw, 'a boolean'),
    }
  })
  if (out.frameTiming !== null) refuse(GPU_AREA, `${where}/frameTiming`, 'is not null; gameCapture records no frame timing')
  const courses = field<string[]>(v => Array.isArray(v) && v.every(isStr), out, 'courses', where, 'an array of course ids')
  const events = field<unknown[]>(Array.isArray, out, 'events', where, 'an array').map((e, i) => {
    const ew = `${where}/events/${i}`
    if (!isObject(e)) return refuse(GPU_AREA, ew, 'is not an object; pass the unmodified op output')
    return { t: field<number>(v => typeof v === 'number' && Number.isFinite(v), e, 't', ew, 'a finite number'), what: field<string>(isStr, e, 'what', ew, 'a string') }
  })
  const rep = field<Record<string, unknown>>(isObject, out, 'report', where, 'the content report object')
  const reports = field<unknown[]>(v => Array.isArray(v) && v.length === 2, out, 'reports', where, 'first-load and reload reports')
  const meshed = { first: parseMeshed(reports[0], `${where}/reports/0`), reload: parseMeshed(reports[1], `${where}/reports/1`) }
  return { meshed, renderer: 'raa', adapter, software: adapter.software, pageRef, captures, frameTiming: null, content: out.content, courses, events, report: rep }
}

// The GPU client writes the op's files into the output directory; each capture must be there, byte for byte.
function checkCapturePngs(captures: SizedCapture[]): void {
  for (const c of captures) {
    const file = `${PNG_DIR}/${c.name}.png`
    if (!existsSync(file)) refuse(GPU_AREA, file, `is missing; the ${GPU_OP} result must come with its PNG files`)
    const bytes = readFileSync(file)
    const sha = createHash('sha256').update(bytes).digest('hex')
    if (sha !== c.sha256 || bytes.length !== c.bytes) refuse(GPU_AREA, file, `is ${bytes.length} bytes sha256 ${sha}, the op reported ${c.bytes} bytes sha256 ${c.sha256}; rerun the op`)
  }
}

// Only the programmatic card calls this path. Stop before publishing if a build step fails.
async function gpuStep(label: string, cmd: string, args: string[]): Promise<void> {
  console.log(`[m17-gpu] ${label}`)
  const result = await runChild(cmd, args)
  if (result.code !== 0) {
    const detail = redact(tail(result.out, 10).join('\n'), secretsFromEnv())
    refuse(GPU_AREA, label, `exited ${result.code}: ${detail}; fix this step before rerunning the GPU card`)
  }
}

async function buildGpuDist(): Promise<void> {
  await gpuStep('fetch mama', NPM, ['run', 'bricks', '--', 'fetch', 'mama'])
  // Expand the root build so Vite uses the managed sandbox's supported config loader.
  await gpuStep('audio:bake', NPM, ['run', 'audio:bake'])
  await gpuStep('ui:fonts', NPM, ['run', 'ui:fonts'])
  await gpuStep('web build', NPM, ['run', 'build', '-w', '@royal-fiesta/web', '--', '--configLoader', 'runner'])
}

async function judgeGpuCaptures(): Promise<void> {
  const judge = process.env.NMC_JUDGE_CLIENT
  if (!judge) refuse(GPU_AREA, 'NMC_JUDGE_CLIENT', 'is unset; run this writer on GPU card 5133 with the judge client supplied')
  for (const [name, description] of [
    ['match-5s', 'a 3D candy party obstacle course drawn from SDF meshes with their graph materials (not flat boxes), penguin characters racing'],
    ['loading', 'a game loading screen with a progress bar and the asset being meshed'],
  ]) {
    await gpuStep(`judge ${name}`, 'python3', [judge, `${PNG_DIR}/${name}.png`, '--description', description, '--min-score', '6'])
  }
}

// --record consumes out/m17 without publishing, building, rendering or judging.
// page-ref.json preserves the actual publish response for offline record regeneration.
async function runGpuCaptures(render: boolean): Promise<number> {
  try {
    process.chdir(repoRoot())
    const input = JSON.parse(readFileSync(CAPTURES_INPUT, 'utf8')) as unknown
    if (!isObject(input)) return refuse(GPU_AREA, `${CAPTURES_INPUT}#`, 'is not an object; use the gameCapture input of docs/gpu-ops.md')
    let pageRef: string
    let result: OpResult
    if (render) {
      await buildGpuDist()
      if (!existsSync(`${DIST_DIR}/game.html`) || !existsSync(`${DIST_DIR}/nmc.gpu.json`)) refuse(GPU_AREA, DIST_DIR, 'has no game.html or nmc.gpu.json; fix the web build')
      pageRef = await publishDist(DIST_DIR)
      mkdirSync(PNG_DIR, { recursive: true })
      writeFileSync(`${PNG_DIR}/page-ref.json`, `${JSON.stringify({ pageRef }, null, 2)}\n`)
      console.log(`[m17-gpu] published ${DIST_DIR}; running ${GPU_OP} with ${CAPTURES_INPUT}`)
      result = await renderOp(GPU_OP, input, PNG_DIR, 'captures', pageRef)
    } else {
      const published: unknown = JSON.parse(readFileSync(`${PNG_DIR}/page-ref.json`, 'utf8'))
      if (!isObject(published) || typeof published.pageRef !== 'string' || !published.pageRef.trim()) {
        return refuse(GPU_AREA, PNG_DIR, 'missing pageRef; retain page-ref.json from the published capture')
      }
      pageRef = published.pageRef
      result = { file: `${PNG_DIR}/result.json`, json: JSON.parse(readFileSync(`${PNG_DIR}/result.json`, 'utf8')) as unknown }
    }
    const record = capturesRecord(result, input, pageRef)
    checkCapturePngs(record.captures as SizedCapture[])
    const secrets = secretsFromEnv()
    const deny = (process.env.RF_GUARD_DENY ?? '').split(',').map(s => s.trim()).filter(Boolean)
    const text = redact(`${JSON.stringify(record, null, 2)}\n`, secrets)
    const hits = leakScan(text, [...secrets, ...deny])
    if (hits.length > 0) refuse(GPU_AREA, CAPTURES_FILE, `leakScan found ${hits.map(h => `${h.pattern} (${h.excerpt})`).join(', ')}; the record is not written`)
    writeFileSync(CAPTURES_FILE, text)
    console.log(`[report:m17-gpu] captures=${(record.captures as SizedCapture[]).length} software=${String(record.software)} out=${CAPTURES_FILE}`)
    const checked = await checkGpuMatch()
    for (const note of checked.notes ?? []) console.error(note)
    if (!checked.pass) return 1
    if (render) await judgeGpuCaptures()
    return 0
  } catch (e) {
    console.error(redact(messageOf(e), secretsFromEnv()))
    return 1
  }
}


const checks: ProofCheck[] = [
  { label: 'sim-independence', inQuick: true, run: checkSimIndependence },
  { label: 'mama', inQuick: true, run: checkMama },
  { label: 'mesh-node', inQuick: true, run: checkMeshNode },
  { label: 'gpu-match', inQuick: true, run: checkGpuMatch },
]

const args = parseProofArgs(process.argv.slice(2))
const caseAt = args.rest.indexOf(SIM_CASE_FLAG)
if (!args.child && caseAt >= 0) {
  const name = args.rest[caseAt + 1] ?? ''
  if (name !== SIM_CASE) {
    console.error(`usage: ${SIM_CASE_FLAG} ${SIM_CASE}`)
    process.exitCode = 1
  } else {
    await runSimCase()
  }
} else if (args.rest.includes(GPU_FLAG) || args.rest.includes('--render') || args.rest.includes('--record')) {
  process.exitCode = await runGpuCaptures(!args.rest.includes('--record'))
} else {
  await runProof('m17-sdf-runtime', import.meta.url, checks)
}
