// Ported V0 M13 proof (docs/v0-port.md): Royal Fiesta packaged for Wavedash, local mode only. V0 also had a
// playtest mode (published-pair) behind owner and playtest gates; those gates are dropped on main, so every
// record here says mode 'local', published false. Rewritten for main:
// - local-relay-round: two headless clients play a match over the real relay protocol on a local
//   GameSaloon (runRealCase). V0 ran apps/web/src/online/pairOp.ts (not on main) and wrote
//   local-relay.json (dropped: it carried the server's local directory);
// - local-pair-gpu: V0's onlinePairCapture op is not on main; the gameCapture op plays 2 in-page clients
//   over the LoopbackRelay on game.html, with RAA the @etcito/raa release (no RAA build step);
// - wavedash-check: V0 ran tools/wavedashCheck.ts on the package:wavedash bundle. Here the web build is
//   packed with packWavedash (tools/wavedash.ts) and checked against the sourced requirements of
//   docs/wavedash.md, plus B1 (no secret in the bundle) and relay-url-not-committed: V0's relay-url-set
//   read a committed relay URL (packages/game/src/deploy.ts); main takes it from ?server= (ARCHITECTURE 1.6).
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { arch, cpus, platform } from 'node:os'
import { join, relative } from 'node:path'
import { raaLocal, repoRoot } from '../../../tools/bricks.ts'
import { leakScan } from '../../../tools/guard.ts'
import { BUILD_STAMP, CONFIG_NAME, DEFAULT_OUT, ENTRY, EXCLUDED, packWavedash, UPLOAD_DIR } from '../../../tools/wavedash.ts'
import { startGameSaloon } from '../src/gamesaloon.ts'
import { publishDist, renderOp } from '../src/gpuClient.ts'
import { unwrapOp } from '../src/gpuRecord.ts'
import { outDir, parseProofArgs, report, runProof } from '../src/proofkit.ts'
import type { CheckResult, ProofCheck } from '../src/proofkit.ts'
import { runRealCase } from '../src/realMatch.ts'

const root = repoRoot()
const proofsDir = join(root, 'proofs/m13')
const dist = join(root, 'apps/web/dist')
const raaPackage = join(root, 'node_modules/@etcito/raa/package.json')
const started = performance.now()
const DOC = 'docs/wavedash.md'
const MAX_BUNDLE_BYTES = 1024 ** 3
const PAIR_MOMENTS = ['loading', 'match-10s', 'podium']
const LOCAL_GPU_SOURCE = 'GPU client op gameCapture on game.html of apps/web/dist (npm run build with the @etcito/raa release): 2 in-page clients over the LoopbackRelay, v0 content, flow match'
const machine = { platform: platform(), arch: arch(), cpu: cpus()[0]?.model ?? 'unknown', node: process.version }

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
}

// nmc.gpu.json lists op names; an object keyed by op is still accepted.
function opNames(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((o): o is string => typeof o === 'string')
  return Object.keys(object(raw) ?? {})
}

function writeRecord(name: string, record: unknown): string {
  mkdirSync(proofsDir, { recursive: true })
  const file = join(proofsDir, name)
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`)
  return relative(root, file)
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

async function webBuild(): Promise<{ code: number; tail: string }> {
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

// Real relay protocol on a local GameSaloon, paced to real time (relay rates): no record (V0's carried a path).
async function localRelayRound(): Promise<CheckResult> {
  const threshold = 'a 2-client sprint match on the local GameSaloon relay: compared > 0, mismatches 0, same winner >= 0, logs equal'
  const server = await startGameSaloon()
  try {
    const r = await runRealCase(server, { label: 'relay-2', transport: 'relay', clients: 2, profile: 'sprint' })
    report('local-relay-cost', {
      frames: r.ticks, p99Ms: r.frameMsP99.toFixed(3), meanMs: r.frameMsMean.toFixed(3), wallS: (r.wallMs / 1000).toFixed(1), mode: 'local-relay',
    })
    const w = r.winners[0]
    const same = r.winners.every(x => x === w)
    return {
      value: `compared=${r.ticksCompared} mismatches=${r.mismatches} winner=${same ? w : r.winners.join('/')} logsEqual=${r.logsEqual}`,
      threshold,
      pass: r.ticksCompared > 0 && r.mismatches === 0 && same && w >= 0 && r.logsEqual,
      notes: [`seed=${r.seed} stalls=${r.stalls} maxDelay=${r.maxDelay} firstMismatch=${r.firstMismatch}`, 'mode local, not a playtest proof'],
    }
  } finally {
    await server.stop()
  }
}

// GPU op gameCapture with 2 in-page clients: the local stand-in for V0's onlinePairCapture.
async function localPairGpu(): Promise<CheckResult> {
  const threshold = `mode local; renderer raa; 2 clients; ${PAIR_MOMENTS.join(', ')} captured, non-empty`
  const built = await webBuild()
  if (built.code !== 0) return { value: `web-build=${built.code}`, threshold: 'web build succeeds', pass: false, notes: built.tail.trim().split('\n').slice(-10) }
  const ops = opNames(object(JSON.parse(readFileSync(join(dist, 'nmc.gpu.json'), 'utf8')) as unknown)?.ops)
  if (!ops.includes('gameCapture')) return { value: 'gameCapture undeclared', threshold: 'apps/web/dist/nmc.gpu.json declares gameCapture', pass: false }
  const pageRef = await publishDist(dist)
  const out = join(outDir('m13'), 'local-pair')
  const input = { content: 'v0', flow: 'match', clients: 2, width: 1920, height: 1080, captureAt: PAIR_MOMENTS }
  const result = await renderOp('gameCapture', input, out, 'local-pair', pageRef)
  const got = unwrapOp(result, 'captures').out
  const captures = Array.isArray(got.captures) ? got.captures.map(object) : []
  const notes: string[] = []
  for (const m of PAIR_MOMENTS) {
    const c = captures.find(k => k?.name === m) ?? null
    if (c === null) notes.push(`${m}: no capture in the op output`)
    else if (c.nonEmpty !== true) notes.push(`${m}: empty capture`)
    else if (!existsSync(join(out, `${m}.png`))) notes.push(`${m}: ${m}.png not returned`)
  }
  if (got.renderer !== 'raa') notes.push(`renderer=${String(got.renderer)}; expected raa`)
  const file = writeRecord('local-pair.json', {
    format: 'royal-fiesta.m13-run', version: 0, mode: 'local', published: false, source: LOCAL_GPU_SOURCE, machine, pageRef,
    result: relative(root, result.file), op: got,
  })
  report('local-pair', { captures: captures.length, software: String(got.software), mode: 'local-gpu' })
  return {
    value: `renderer=${String(got.renderer)} captures=${captures.length} software=${String(got.software)}`,
    threshold, pass: notes.length === 0,
    notes: [...notes, `record: ${file} (mode local, not a playtest proof)`, `captures: ${relative(root, out)}`],
  }
}

// ---- wavedash-check: the packWavedash bundle against docs/wavedash.md --------------------------------------

interface Item { id: string; statement: string; status: 'pass' | 'fail' | 'info'; detail: string }
interface Requirement extends Item { source: string; unverified: string | null; check: string | null }

const TEXT_FILE = /\.(?:html|js|mjs|css|json|toml|txt|map|svg|webmanifest)$/

function walk(dir: string, rel = ''): string[] {
  return readdirSync(dir).sort().flatMap(name => {
    const childRel = rel === '' ? name : `${rel}/${name}`
    return statSync(join(dir, name)).isDirectory() ? walk(join(dir, name), childRel) : [childRel]
  })
}

const sha256 = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex')

// "- **R<n>** <statement> - source: <url> (retrieved <date>)", one per line of the Requirements section.
function docRequirements(text: string): { id: string; statement: string; source: string }[] {
  return [...text.matchAll(/^- \*\*(R\d+)\*\* (.+) - source: (\S+) \(retrieved ([0-9-]+)\)$/gm)]
    .map(m => ({ id: m[1], statement: m[2], source: `${m[3]} (retrieved ${m[4]} via ${DOC})` }))
}

// The automatic checks a local bundle can answer; every other requirement is reported as info.
function requirementCheck(id: string, upload: string, files: string[], bytes: number, toml: string): Pick<Requirement, 'check' | 'status' | 'detail'> | null {
  if (id === 'R2') {
    const ok = files.includes(ENTRY) && toml.includes(`entrypoint = ${JSON.stringify(ENTRY)}`)
    return { check: 'entrypoint', status: ok ? 'pass' : 'fail', detail: `${CONFIG_NAME} entrypoint ${ENTRY}; ${relative(root, join(upload, ENTRY))} ${files.includes(ENTRY) ? 'present' : 'missing'}` }
  }
  if (id === 'R4') {
    return { check: 'bundle-size', status: bytes <= MAX_BUNDLE_BYTES ? 'pass' : 'fail', detail: `${bytes} bytes uncompressed in ${files.length} files (limit ${MAX_BUNDLE_BYTES})` }
  }
  if (id === 'R6') {
    const ok = toml.includes(`upload_dir = ${JSON.stringify(`./${UPLOAD_DIR}`)}`) && !/^\s*game_id\s*=/m.test(toml)
    return { check: 'wavedash-toml', status: ok ? 'pass' : 'fail', detail: `${CONFIG_NAME}: upload_dir ./${UPLOAD_DIR}, no game_id (the push run sets it)` }
  }
  return null
}

function builtins(upload: string, files: string[]): Item[] {
  const secretFiles = files.filter(f => EXCLUDED.includes(f.split('/')[0]) || /(^|\/)\.env/.test(f) || f.endsWith('.pem') || f.endsWith('.key'))
  const leaks: string[] = []
  const relays: string[] = []
  let scanned = 0
  for (const f of files.filter(f => TEXT_FILE.test(f))) {
    const text = readFileSync(join(upload, f), 'utf8')
    scanned++
    for (const hit of leakScan(text)) leaks.push(`${f}: ${hit.pattern}`)
    for (const m of text.matchAll(/wss?:\/\/[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g)) relays.push(`${f}: ${m[0]}`)
  }
  const manifest = object(JSON.parse(readFileSync(join(upload, BUILD_STAMP), 'utf8')) as unknown) ?? {}
  const mama = object(manifest.mama)
  const stampOk = manifest.format === 'royal-fiesta.build' && manifest.version === 1 && manifest.entry === ENTRY &&
    (manifest.commit === null || /^[0-9a-f]{40}$/.test(String(manifest.commit))) && mama !== null && ['sibling', 'cloned', 'absent'].includes(String(mama.source))
  return [
    {
      id: 'B1', statement: 'no secret in the bundle (nmc.gpu.json, store/, .env*, *.pem, *.key, leakScan patterns)',
      status: secretFiles.length + leaks.length === 0 ? 'pass' : 'fail',
      detail: secretFiles.length + leaks.length === 0 ? `${files.length} files, ${scanned} text files scanned` : [...secretFiles, ...leaks].slice(0, 10).join('; '),
    },
    {
      id: 'relay-url-not-committed', statement: 'the bundle names no relay URL: the GameSaloon server comes from ?server= (ARCHITECTURE 1.6)',
      status: relays.length === 0 ? 'pass' : 'fail', detail: relays.length === 0 ? `no ws/wss host in ${scanned} text files` : relays.slice(0, 5).join('; '),
    },
    {
      id: 'build-manifest', statement: `${BUILD_STAMP} follows ${DOC} (format, version 1, commit, entry, mama kind and commit only)`,
      status: stampOk ? 'pass' : 'fail', detail: JSON.stringify({ format: manifest.format, version: manifest.version, entry: manifest.entry, raa: manifest.raa, mama: mama?.source }),
    },
  ]
}

async function wavedashCheck(_mode: string, args: { rest: string[] }): Promise<CheckResult> {
  const threshold = `${DOC} requirements (automatic: R2, R4, R6) + builtins (B1 secrets, relay-url-not-committed, build-manifest): no fail`
  if (!args.rest.includes('--skip-build')) {
    const built = await webBuild()
    if (built.code !== 0) return { value: `web-build=${built.code}`, threshold: 'web build succeeds', pass: false, notes: built.tail.trim().split('\n').slice(-10) }
  }
  const outRoot = join(root, DEFAULT_OUT)
  const { files } = await packWavedash({ outDir: outRoot })
  const upload = join(outRoot, UPLOAD_DIR)
  const toml = readFileSync(join(outRoot, CONFIG_NAME), 'utf8')
  const bytes = files.reduce((n, f) => n + statSync(join(upload, f)).size, 0)
  report('wavedash-bundle', { files: files.length, bytes, uploadDir: relative(root, upload) })
  const docText = readFileSync(join(root, DOC), 'utf8')
  const requirements: Requirement[] = docRequirements(docText).map(r => ({
    ...r, unverified: null, check: null, status: 'info', detail: 'no automatic check',
    ...requirementCheck(r.id, upload, files, bytes, toml),
  }))
  const items = builtins(upload, files)
  // The build stamp carries the commit: the content hash covers the game files only.
  const content = files.filter(f => f !== BUILD_STAMP).map(f => `${sha256(readFileSync(join(upload, f)))}  ${f}\n`).join('')
  const all = [...requirements, ...items]
  const pass = requirements.length > 0 && all.every(i => i.status !== 'fail')
  const file = writeRecord('wavedash-check.json', {
    doc: DOC, docSha256: sha256(docText), bundle: relative(root, upload), contentSha256: sha256(content), requirements, builtins: items, pass,
  })
  const fails = all.filter(i => i.status === 'fail').map(i => `FAIL ${i.id}: ${i.detail}`)
  const count = (s: Item['status']): number => all.filter(i => i.status === s).length
  return {
    value: `requirements=${requirements.length} pass=${count('pass')} info=${count('info')} fail=${count('fail')}`,
    threshold, pass,
    notes: [...fails, `record: ${file} (bundle ${relative(root, upload)}, ${files.length} files)`],
  }
}

// Local checks only: V0's published-pair (owner and playtest gates) is dropped.
const checks: ProofCheck[] = [
  { label: 'local-relay-round', inQuick: true, run: localRelayRound },
  { label: 'local-pair-gpu', inQuick: true, run: localPairGpu },
  { label: 'wavedash-check', inQuick: true, run: wavedashCheck },
]
const proofArgs = parseProofArgs(process.argv.slice(2))
if (!proofArgs.child) ensureRaaRelease()
try { await runProof('m13-wavedash', import.meta.url, checks) }
finally { report('m13-wavedash', { wallMs: Math.round(performance.now() - started) }) }
process.exit(process.exitCode ?? 0)
