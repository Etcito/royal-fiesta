import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { initRapier } from '@gamesaloon/rollback-rapier'
import type { RapierModule } from '@gamesaloon/rollback-rapier'
import { parseGameAsset } from '@royal-fiesta/game/gameAsset'
import type { GameAsset } from '@royal-fiesta/game/gameAsset'
import { runMatchOffline } from '@royal-fiesta/sim/match/offline'
import type { MatchSetup } from '@royal-fiesta/sim/match/setup'
import { isRefusal } from '@royal-fiesta/sim/refusal'
import { v1Playlist } from '@royal-fiesta/headless/contentFiles'
import { readRepoText, repoPath } from '@royal-fiesta/headless/files'
import { hex8, parseProofArgs, report, runProof } from '@royal-fiesta/headless/proofkit'
import type { CheckResult, ProofCheck } from '@royal-fiesta/headless/proofkit'
import { MAMA_ABSENT_PREFIX, mamaSource, repoRoot } from '../../../tools/bricks.ts'

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

const checks: ProofCheck[] = [
  { label: 'sim-independence', inQuick: true, run: checkSimIndependence },
  { label: 'mama', inQuick: true, run: checkMama },
  { label: 'mesh-node', inQuick: true, run: checkMeshNode },
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
} else {
  await runProof('m17-sdf-runtime', import.meta.url, checks)
}
