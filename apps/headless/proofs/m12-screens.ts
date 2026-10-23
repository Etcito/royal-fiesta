// Ported V0 M12 proof (docs/v0-port.md): the screen graph and its captures. Rewritten for main:
// - nav-graph: docs/screens.md ids = SCREENS (13 on main: V0's 12 plus loading), every screen reachable
//   from and back to title, no dead ends;
// - screens-tour: V0 fetched the asset store, built RAA (raaBuild) and drove a screensTour op on local.html;
//   none of these is on main. RAA is the @etcito/raa release (no RAA build step), the v0 content reads
//   fixtures/assets, and the gameCapture op on game.html runs its tour flow (loading, hub, round, podium,
//   back in the hub). The other docs screens need a screensTour op (not on main): reported, not captured.
// PNGs stay in out/m12 (never committed); the record is proofs/m12/screens/screens.json.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { navGraph, SCREENS } from '@royal-fiesta/game/screens/nav'
import type { Screen } from '@royal-fiesta/game/screens/nav'
import { raaLocal, repoRoot } from '../../../tools/bricks.ts'
import { publishDist, renderOp } from '../src/gpuClient.ts'
import { decodePng, unwrapOp } from '../src/gpuRecord.ts'
import { parseProofArgs, report, runProof } from '../src/proofkit.ts'
import type { CheckResult, ProofCheck } from '../src/proofkit.ts'

const root = repoRoot()
const out = join(root, 'out/m12')
const screensDir = join(root, 'proofs/m12/screens')
const dist = join(root, 'apps/web/dist')
const raaPackage = join(root, 'node_modules/@etcito/raa/package.json')
const started = performance.now()
const WIDTH = 1920
const HEIGHT = 1080
// gameCapture tour moments and the docs screen each one shows.
const TOUR: readonly { moment: string; screen: Screen; how: string }[] = [
  { moment: 'loading', screen: 'loading', how: 'loading: page load' },
  { moment: 'hub', screen: 'hub', how: 'hub: the loaded hub after 120 frames' },
  { moment: 'match-12s', screen: 'round', how: 'round: 12 s into the first round (in-page bots)' },
  { moment: 'podium', screen: 'podium', how: 'podium: the match podium after 60 frames' },
  { moment: 'back-in-hub', screen: 'hub', how: 'hub: back in the hub after the podium, 120 frames' },
]
const docsScreens = (): string[] => [...readFileSync(join(root, 'docs/screens.md'), 'utf8').matchAll(/^\|\s*`([a-z]+)`\s*\|/gm)].map(m => m[1])

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
}

// nmc.gpu.json lists op names; an object keyed by op is still accepted.
function opNames(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((o): o is string => typeof o === 'string')
  return Object.keys(object(raw) ?? {})
}

function npmRun(args: string[]): Promise<{ code: number; tail: string }> {
  return new Promise(resolve => {
    const child = spawn('npm', args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
    let tail = ''
    const keep = (chunk: Buffer) => { tail = (tail + chunk.toString()).slice(-4000) }
    child.stdout.on('data', keep)
    child.stderr.on('data', keep)
    child.on('error', e => resolve({ code: -1, tail: `${tail}\n${e.message}` }))
    child.on('close', code => resolve({ code: code ?? -1, tail }))
  })
}

async function build(): Promise<{ code: number; tail: string }> {
  const primary = await npmRun(['run', 'web:build'])
  if (primary.code === 0 || !primary.tail.includes('node_modules/.vite-temp')) return primary
  // The managed worktree cannot write Vite's bundled config cache under node_modules.
  return await npmRun(['run', 'build', '-w', '@royal-fiesta/web', '--', '--configLoader', 'runner'])
}

// The web build imports the @etcito/raa release installed by npm install (no RAA build step).
function ensureRaaRelease(): void {
  if (!existsSync(raaPackage)) {
    console.error('[raa] @etcito/raa is not installed; run npm install from the repository root and rerun')
    process.exit(1)
  }
  const version = object(JSON.parse(readFileSync(raaPackage, 'utf8')) as unknown)?.version
  const local = raaLocal().active ? ' (RF_RAA_LOCAL=1: local override active)' : ''
  console.log(`[raa] @etcito/raa ${String(version)} release${local}`)
}

async function navCheck(): Promise<CheckResult> {
  const docs = docsScreens()
  const graph = navGraph()
  const reach = (from: Screen): Set<Screen> => {
    const seen = new Set<Screen>([from])
    for (const s of seen) for (const next of graph[s]) seen.add(next)
    return seen
  }
  const reached = reach('title')
  const deadEnds = SCREENS.filter(s => s !== 'title' && graph[s].filter(to => to !== s).length === 0)
  const stranded = SCREENS.filter(s => !reach(s).has('title'))
  const n = SCREENS.length
  const same = docs.length === n && new Set(docs).size === n && SCREENS.every(s => docs.includes(s))
  return {
    value: `screens=${docs.length} reachable=${reached.size} deadEnds=${deadEnds.join(',') || '[]'}`,
    threshold: `${n} docs ids = SCREENS, all reachable from/to title, no dead ends`,
    pass: same && SCREENS.every(s => reached.has(s)) && stranded.length === 0 && deadEnds.length === 0,
    notes: [...(!same ? [`docs=${docs.join(',')} SCREENS=${SCREENS.join(',')}`] : []), ...stranded.map(s => `cannot return to title: ${s}`)],
  }
}

interface Entry { screen: string; capture: string; how: string; sha256: string; width: number; height: number }

async function screensTour(): Promise<CheckResult> {
  const threshold = `the gameCapture tour (${TOUR.map(t => t.moment).join(', ')}): one ${WIDTH}x${HEIGHT} non-empty raa PNG each, distinct sha256`
  const built = await build()
  if (built.code !== 0) return { value: `web-build=${built.code}`, threshold: 'web build succeeds', pass: false, notes: built.tail.trim().split('\n').slice(-10) }
  const missingFiles = ['game.html', 'nmc.gpu.json'].filter(f => !existsSync(join(dist, f)))
  if (missingFiles.length) return { value: 'missing build files', threshold: 'dist/game.html + dist/nmc.gpu.json', pass: false, notes: missingFiles }
  const ops = opNames(object(JSON.parse(await readFile(join(dist, 'nmc.gpu.json'), 'utf8')) as unknown)?.ops)
  if (!ops.includes('gameCapture')) return { value: 'gameCapture undeclared', threshold: 'nmc.gpu.json declares gameCapture', pass: false }
  const pageRef = await publishDist(dist)
  const input = { content: 'v0', flow: 'tour', clients: 1, width: WIDTH, height: HEIGHT, captureAt: TOUR.map(t => t.moment) }
  const result = await renderOp('gameCapture', input, out, 'screens-tour', pageRef)
  await writeFile(join(out, 'screens-tour-result.json'), JSON.stringify(result.json, null, 2) + '\n')
  const { out: got, path } = unwrapOp(result, 'captures')
  const captures = Array.isArray(got.captures) ? got.captures.map(object) : []
  const notes: string[] = []
  const entries: Entry[] = []
  for (const t of TOUR) {
    const c = captures.find(k => k?.name === t.moment) ?? null
    const file = join(out, `${t.moment}.png`)
    if (c === null || !existsSync(file)) {
      notes.push(`${t.moment}: ${c === null ? 'no capture in the op output' : `${t.moment}.png not returned`}`)
      continue
    }
    const bytes = readFileSync(file)
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    if (sha256 !== c.sha256) notes.push(`${t.moment}: file differs from its op entry`)
    const png = decodePng(bytes, WIDTH, HEIGHT, `${result.file}${path}/captures/${t.moment}`)
    if (c.nonEmpty !== true) notes.push(`${t.moment}: empty capture`)
    entries.push({ screen: t.screen, capture: `${t.moment}.png`, how: t.how, sha256, width: png.width, height: png.height })
  }
  const identical: string[] = []
  for (let i = 0; i < entries.length; i++) for (let j = i + 1; j < entries.length; j++) {
    if (entries[i].sha256 === entries[j].sha256) identical.push(`${entries[i].capture}=${entries[j].capture}`)
  }
  if (got.renderer !== 'raa') notes.push(`renderer=${String(got.renderer)}; expected raa`)
  const uncovered = docsScreens().filter(s => !TOUR.some(t => t.screen === s))
  await mkdir(screensDir, { recursive: true })
  await writeFile(join(screensDir, 'screens.json'), JSON.stringify({ pageRef, renderer: got.renderer, adapter: got.adapter, screens: entries }, null, 2) + '\n')
  return {
    value: `screens=${entries.length} distinct=${new Set(entries.map(e => e.sha256)).size} uncovered=${uncovered.length}`,
    threshold,
    pass: entries.length === TOUR.length && identical.length === 0 && notes.length === 0,
    notes: [
      `identical pairs: ${identical.join(', ') || 'none'}`, ...notes,
      `not captured (needs a screensTour op, not on main): ${uncovered.join(', ') || 'none'}`,
      `captures: out/m12; record: proofs/m12/screens/screens.json`,
    ],
  }
}

const checks: ProofCheck[] = [
  { label: 'nav-graph', inQuick: true, run: navCheck },
  { label: 'screens-tour', inQuick: true, run: screensTour },
]
const proofArgs = parseProofArgs(process.argv.slice(2))
if (!proofArgs.child && (proofArgs.only === null || proofArgs.only.test('screens-tour'))) ensureRaaRelease()
try { await runProof('m12-screens', import.meta.url, checks) }
finally { report('m12-screens', { wallMs: Math.round(performance.now() - started) }) }
process.exit(process.exitCode ?? 0)
