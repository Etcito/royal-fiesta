import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, posix, win32 } from 'node:path'
import test from 'node:test'
import { leakScan } from '../guard.ts'
import { relativeProofText, writeProofLog } from '../proofLog.ts'

const home = posix.join('/', 'home', 'proof-user')
const root = posix.join(home, 'worktrees', '81', '6030')

test('judge, probe and build logs preserve evidence while making paths relative', () => {
  const evidence = [
    'JUDGE PASS: 7.0/10 (minimum 6.0) on proofs/m2/candy-assets/view.png by judge (median of [7.0, 7.0, 8.0])',
    '{"job_id":"abc123","output":"out/candy-assets-one"}',
    'baked 9 families into apps/web/public/audio in 7.4 s',
    'Module "node:url", imported by "../raa/dist/bricks/raa-anim/index.js".',
    'Module "node:module", imported by "../MAMA/node_modules/highs/build/highs.mjs".',
  ].join('\n') + '\n'
  const raw = evidence
    .replace('on proofs/', `on ${root}/proofs/`)
    .replace('"out/', `"${root}/out/`)
    .replace('into apps/', `into ${root}/apps/`)
    .replaceAll('"../', `"${posix.dirname(root)}/`)
  const clean = relativeProofText(raw, root, home)
  assert.equal(clean, evidence)
  assert.deepEqual(leakScan(clean), [])
})

test('home paths outside the worktree remain resolvable relative paths', () => {
  assert.equal(relativeProofText(`"${home}/.cache/tool"`, root, home), '"../../../.cache/tool"')
  assert.equal(relativeProofText(`"${root}"`, root, home), '"."')
  assert.equal(relativeProofText(`"${root}-other/file"`, root, home), '"../6030-other/file"')
})

test('relative paths, scores, ANSI formatting and URLs are unchanged', () => {
  const text = '\x1b[33mJUDGE FAIL: 5.0/10 (minimum 6.0)\x1b[0m\r\n./dist/file.js 105 kB https://vite.dev/guide/\n'
  assert.equal(relativeProofText(text, root, home), text)
})

test('Windows paths in plain text and JSON keep their relative suffixes', () => {
  const home = win32.join('C:\\', 'Users', 'proof-user')
  const root = win32.join(home, 'repo')
  const output = win32.join(root, 'out', 'probe')
  assert.equal(relativeProofText(`on ${output}\n`, root, home), 'on out\\probe\n')
  assert.deepEqual(JSON.parse(relativeProofText(JSON.stringify({ output }), root, home)), { output: 'out\\probe' })
  assert.equal(relativeProofText(output.replaceAll('\\', '/'), root, home), 'out/probe')
})

test('the proof writer cleans the combined log before writing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rf-proof-log-'))
  try {
    const file = join(dir, 'judge.txt')
    const chunks = [`JUDGE PASS: 8.0/10 on ${dir.slice(0, 5)}`, `${dir.slice(5)}/capture.png\n`]
    writeProofLog(file, chunks.join(''), dir)
    assert.equal(readFileSync(file, 'utf8'), 'JUDGE PASS: 8.0/10 on capture.png\n')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
