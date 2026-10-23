import { spawn } from 'node:child_process'
import { isRefusal } from '@royal-fiesta/sim/refusal'
import { report, runProof } from '@royal-fiesta/headless/proofkit'
import type { CheckResult, ProofCheck } from '@royal-fiesta/headless/proofkit'
import { AUTHORED_PATH, parseAuthored, readAuthored } from '../../../tools/authored.ts'
import { repoRoot } from '../../../tools/bricks.ts'
import { buildContent } from '../../../tools/placeholders.ts'

// C1 content checks accept authored files: the registry (S20) parses and refuses, placeholders.ts skips
// listed paths, and the existing content checks stay green (QB15).

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

// Exit code and full output of a shell-free child at the repository root; children run one at a time.
function runChild(cmd: string, args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    let out = ''
    const child = spawn(cmd, args, { cwd: repoRoot(), stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (d: string) => { out += d })
    child.stderr.on('data', (d: string) => { out += d })
    child.on('error', (e) => resolve({ code: 1, out: out + e.message }))
    child.on('close', (code) => resolve({ code: code ?? 1, out }))
  })
}

function tail(out: string, n: number): string[] {
  return out.split('\n').map(l => l.trimEnd()).filter(l => l.length > 0).slice(-n)
}

async function nodeScript(script: string, args: string[]): Promise<CheckResult> {
  const { code, out } = await runChild(process.execPath, ['--experimental-strip-types', script, ...args])
  return { value: `exit=${code}`, threshold: 'exit=0', pass: code === 0, notes: code === 0 ? [] : tail(out, 10) }
}

// ---- registry ------------------------------------------------------------------------------------------

const GOOD = { format: 'royal-fiesta.authored', version: 1 }
const ASSET = 'assets/candy/candy.spinner-bar.asset.json'
const COURSE = 'courses/race-hammer-hill.course.json'

const BAD: { name: string; json: unknown; pointer: string }[] = [
  { name: 'unknown top key', json: { ...GOOD, files: [], extra: 1 }, pointer: '#/extra' },
  { name: 'wrong format', json: { ...GOOD, format: 'royal-fiesta.course', files: [] }, pointer: '#/format' },
  { name: 'wrong version', json: { ...GOOD, version: 2, files: [] }, pointer: '#/version' },
  { name: 'path outside the two forms', json: { ...GOOD, files: ['fixtures/assets/spinner-bar.prims.json'] }, pointer: '#/files/0' },
  { name: 'duplicate', json: { ...GOOD, files: [ASSET, ASSET] }, pointer: '#/files/1' },
  { name: 'unsorted', json: { ...GOOD, files: [COURSE, ASSET] }, pointer: '#/files/1' },
]

async function checkRegistry(): Promise<CheckResult> {
  const notes: string[] = []
  const committed = readAuthored(repoRoot())
  let refused = 0
  for (const bad of BAD) {
    try {
      parseAuthored(bad.json, AUTHORED_PATH)
      notes.push(`${bad.name}: accepted`)
    } catch (e) {
      if (isRefusal(e) && e.message.includes(`${AUTHORED_PATH}${bad.pointer}`)) refused++
      else notes.push(`${bad.name}: expected a RefusalError naming ${AUTHORED_PATH}${bad.pointer}, got ${messageOf(e)}`)
    }
  }
  report('registry', { committedFiles: committed.files.length })
  return { value: `${refused}/${BAD.length}`, threshold: `${BAD.length}/${BAD.length}`, pass: refused === BAD.length, notes }
}

// ---- skip ----------------------------------------------------------------------------------------------

async function checkSkip(): Promise<CheckResult> {
  const notes: string[] = []
  const base = await buildContent({ files: [] })
  const keys = [...base.keys()]
  const asset = keys.find(k => k.startsWith('assets/'))
  const course = keys.find(k => k.startsWith('courses/'))
  if (asset === undefined || course === undefined) {
    return { value: `${base.size}->?`, threshold: 'one asset and one course generated', pass: false, notes: ['buildContent produced no asset or no course'] }
  }
  const listed = [asset, course].sort()
  const skipped = await buildContent({ files: listed })
  for (const p of listed) if (skipped.has(p)) notes.push(`${p}: still generated`)
  for (const k of keys) {
    if (listed.includes(k)) continue
    if (!skipped.has(k)) notes.push(`${k}: missing`)
    else if (skipped.get(k) !== base.get(k)) notes.push(`${k}: bytes differ`)
  }
  if (skipped.size !== base.size - listed.length) notes.push(`size ${skipped.size}, expected ${base.size - listed.length}`)
  return { value: `${base.size}->${skipped.size}`, threshold: `${base.size}->${base.size - listed.length} rest identical`, pass: notes.length === 0, notes }
}

// ---- tests ---------------------------------------------------------------------------------------------

async function checkTests(): Promise<CheckResult> {
  const { code, out } = await runChild('npm', ['test'])
  // node:test prints `# fail <n>` (tap) or `ℹ fail <n>` (spec).
  const m = /^(?:#|ℹ)\s*fail (\d+)\s*$/m.exec(out)
  const failures = m === null ? -1 : Number(m[1])
  const pass = code === 0 && failures === 0
  return { value: `failures=${m === null ? '?' : failures}`, threshold: 'failures=0 exit=0', pass, notes: pass ? [] : [`exit=${code}`, ...tail(out, 10)] }
}

const checks: ProofCheck[] = [
  { label: 'registry', inQuick: true, run: checkRegistry },
  { label: 'skip', inQuick: true, run: checkSkip },
  { label: 'generator', inQuick: true, run: () => nodeScript('tools/placeholders.ts', ['--check']) },
  { label: 'm16-migration', inQuick: true, run: () => nodeScript('apps/headless/proofs/m16-course-v1.ts', ['--only', 'migration']) },
  { label: 'tests', inQuick: true, run: checkTests },
]

await runProof('c1-content-checks', import.meta.url, checks)
