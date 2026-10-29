import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { raaSource, raaBricks, readPins, repoRoot } from '../../../tools/bricks.ts'

export const DET_CASES = [[0, 0], [1, 60], [305419896, 600]] as const
export const ROOT = repoRoot()
const SELF = fileURLToPath(import.meta.url)
const exec = promisify(execFile)
const cpus = Number(process.env.NMC_CPUS ?? 1)
assert(Number.isInteger(cpus) && cpus > 0, 'NMC_CPUS must be a positive integer')
const tokenKeys = ['MAMA_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN', 'NMC_GPU_TOKEN']
export function safe(value: unknown): string {
  let text = String(value)
  for (const key of tokenKeys) for (const secret of [process.env[key], process.env[key]?.trim()]) {
    if (secret) text = text.split(secret).join('[REDACTED]')
  }
  return text
}
export async function run(command: string, args: string[], cwd = ROOT): Promise<string> {
  try {
    return (await exec(command, args, { cwd, timeout: 60000, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024 })).stdout
  } catch (error) { throw new Error(safe(error)) }
}
export function records(value: unknown): void {
  assert(Array.isArray(value) && value.length === DET_CASES.length, 'expected three canonical records')
  value.forEach((r, i) => {
    assert.deepEqual(Object.keys(r).sort(), ['case', 'hash', 'seed', 'ticks'])
    assert.equal(r.case, 'det-selftest')
    assert.equal(r.seed, DET_CASES[i][0]); assert.equal(r.ticks, DET_CASES[i][1])
    assert.equal(typeof r.hash, 'string'); assert.match(r.hash, /^[0-9a-f]{8}$/)
  })
}
export function identity(value: unknown): void {
  assert.deepEqual(value, { name: 'raa-anim', version: '0.5.0' })
}
export function browser(value: any): void {
  identity(value.brickInfo); records(value.records)
  assert.equal(value.renderer, 'raa'); assert.equal(value.content, 'v1')
  assert.equal(value.software, false); assert.equal(value.adapter.software, false)
  const adapter = ['vendor', 'architecture', 'description'].map(k => {
    assert.equal(typeof value.adapter[k], 'string'); return value.adapter[k]
  }).join(' ')
  assert(adapter.trim() && !/swiftshader|llvmpipe|lavapipe|software/i.test(adapter), 'hardware adapter required')
  assert.equal(typeof value.pageRef, 'string'); assert(value.pageRef.length > 0)
  assert.equal(value.nonEmpty, true, `animBrick returned nonEmpty=${value.nonEmpty}; captures=${JSON.stringify(value.captures)}`); assert.equal(value.frameTiming, null)
  assert(Array.isArray(value.courses) && value.courses.length > 0)
  assert(Array.isArray(value.events) && Array.isArray(value.reports) && value.report)
  assert(Array.isArray(value.captures) && value.captures.length > 0)
  for (const c of value.captures) {
    assert.equal(c.nonEmpty, true, `game capture ${c.name} is empty`); assert(c.bytes > 0 && c.width > 0 && c.height > 0)
    assert.match(c.name, /^match-\d+(?:\.\d+)?s$/)
  }
}

async function simPair(seed: number): Promise<void> {
  const { initRapier } = await import('@gamesaloon/rollback-rapier')
  const { runMatchOffline } = await import('@royal-fiesta/sim/match/offline')
  const { MatchSim } = await import('@royal-fiesta/sim/match/matchSim')
  const { v1Playlist } = await import('../src/contentFiles.ts')
  const R = await initRapier()
  const setup = { seed, playerCount: 8, humans: Array(8).fill(false), profile: 'sprint' as const, courses: await v1Playlist('sprint') }
  const states: Uint8Array[] = []
  const free = MatchSim.prototype.free
  // Observe the existing runner at disposal; retain all systems and Rapier state, not its digest/log.
  MatchSim.prototype.free = function () {
    try { assert(this.done); states.push(this.world.takeSnapshotBytes()) } finally { free.call(this) }
  }
  try {
    runMatchOffline(R, setup)
    const { loadAnimBrick } = await import('../../../packages/game/src/anim/brick.ts')
    const brick = await loadAnimBrick()
    identity(brick.brickInfo()); records(DET_CASES.map(([s, t]) => brick.selftest('det-selftest', s, t)))
    runMatchOffline(R, setup)
    assert.equal(states.length, 2); assert(states[0].length > 0)
    assert.deepEqual(states[1], states[0], 'complete final game state differs with the brick loaded')
  } finally { MatchSim.prototype.free = free }
}

function webBuild(): void {
  const dist = join(ROOT, 'apps/web/dist')
  const manifest = JSON.parse(readFileSync(join(dist, 'nmc.gpu.json'), 'utf8'))
  assert.equal(manifest.page, 'game.html'); assert(manifest.ops.includes('animBrick'))
  const html = readFileSync(join(dist, manifest.page), 'utf8')
  const pending = [...html.matchAll(/<script\b[^>]*src="([^"]+)"/g)].map(m => resolve(dist, m[1]))
  const seen = new Set<string>(); const chunks: string[] = []; const wasmFiles = new Set<string>()
  while (pending.length) {
    const file = pending.pop()!
    if (seen.has(file)) continue
    assert(file.startsWith(dist + '/')); seen.add(file)
    const code = readFileSync(file, 'utf8'); chunks.push(code)
    for (const m of code.matchAll(/(?:from\s*|import\s*\(?\s*)["'`](\.[^"'`]+\.js)["'`]/g)) pending.push(resolve(dirname(file), m[1]))
    for (const m of code.matchAll(/new URL\(["'`]([^"'`]*raa_anim_js_bg[^"'`]*\.wasm)["'`],\s*import.meta.url\)/g)) {
      const wasmFile = resolve(dirname(file), m[1]); wasmFiles.add(wasmFile)
      const wasm = readFileSync(wasmFile)
      assert(WebAssembly.validate(wasm), 'emitted animation wasm must be valid')
    }
  }
  const boot = chunks.find(c => c.includes('animBrick') && c.includes('det-selftest'))
  assert(boot?.includes('brickInfo') && boot.includes('selftest'), 'game HTML must import the real brick boot')
  assert(wasmFiles.size > 0, 'boot imports must reach animation wasm')
}

async function proof(): Promise<void> {
  const source = raaSource()
  const checks: [string, string, () => Promise<void> | void][] = [
    ['fetch', 'pin-and-3-package-dirs', () => {
      assert(source.kind !== 'absent', 'run npm run bricks -- fetch raa during provisioning')
      assert.equal(source.commit, readPins().RAA.commit)
      const staged = raaBricks(source.dir)
      assert.equal(staged.commit, readPins().RAA.commit); assert.equal(staged.packages.length, 3)
      for (const name of ['raa', 'raa-sdfm', 'raa-anim']) assert(statSync(join(source.dir, 'dist/bricks', name)).isDirectory())
      assert.equal(realpathSync(fileURLToPath(import.meta.resolve('@etcito/raa-anim'))), realpathSync(join(source.dir, 'dist/bricks/raa-anim/index.js')))
    }],
    ['node', 'native-and-node-3/3-identity', async () => {
      assert(source.kind !== 'absent')
      const temp = mkdtempSync(join(tmpdir(), 'rf-m18-native-'))
      try {
        const crate = join(source.dir, 'crates/raa-det')
        const rustc = process.env.RUSTC || 'rustc'
        await run(rustc, ['--edition=2024', '--crate-name', 'raa_det', '--crate-type=rlib', join(crate, 'src/lib.rs'), '-o', join(temp, 'libraa_det.rlib')])
        await run(rustc, ['--edition=2024', join(crate, 'examples/selftest.rs'), '--extern', `raa_det=${join(temp, 'libraa_det.rlib')}`, '-o', join(temp, 'selftest')])
        records(JSON.parse(await run(join(temp, 'selftest'), [])))
        const { loadAnimBrick } = await import('../../../packages/game/src/anim/brick.ts')
        const brick = await loadAnimBrick()
        identity(brick.brickInfo()); records(DET_CASES.map(([s, t]) => brick.selftest('det-selftest', s, t)))
      } finally { rmSync(temp, { recursive: true, force: true }) }
    }],
    ['sim', '2/2-complete-state-pairs', async () => {
      const seeds = [17, 18]
      await Promise.all(Array.from({ length: Math.min(cpus, seeds.length) }, async () => {
        while (seeds.length) await run(process.execPath, ['--experimental-strip-types', SELF, '--sim-pair', String(seeds.shift()!)])
      }))
    }],
    ['web-build', 'emitted-wasm-and-client-import', webBuild],
    ['browser', 'game-page-3/3-hardware-nonEmpty', () => browser(JSON.parse(readFileSync(join(ROOT, 'proofs/m18/brick-browser.json'), 'utf8')))],
  ]
  const only = process.argv.indexOf('--only')
  for (const [label, threshold, check] of checks) {
    if (only >= 0 && !process.argv[only + 1].split(',').includes(label)) continue
    try { await check(); console.log(`[${label}] value=${threshold} threshold=${threshold} PASS`) }
    catch (error) { console.error(`[${label}] value=${safe(error)} threshold=${threshold} FAIL`); process.exitCode = 1 }
  }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const timer = setTimeout(() => { console.error('m18 proof exceeded 175 seconds'); process.exit(1) }, 175000)
  try {
    if (process.argv[2] === '--sim-pair') await simPair(Number(process.argv[3]))
    else await proof()
  } catch (error) { console.error(safe(error)); process.exitCode = 1 }
  finally { clearTimeout(timer) }
}
