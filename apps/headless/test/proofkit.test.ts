import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cpuBudget, hex8, parseProofArgs, percentile, report, spawnCases } from '../src/proofkit.ts'

test('parseProofArgs defaults to quick with nothing selected', () => {
  const a = parseProofArgs([])
  assert.equal(a.only, null)
  assert.equal(a.mode, 'quick')
  assert.equal(a.child, false)
  assert.equal(a.writeGolden, false)
  assert.deepEqual(a.rest, [])
})

test('parseProofArgs handles every flag and keeps the rest in order', () => {
  const a = parseProofArgs(['x', '--full', '--only', 'Det.*', '--child', '--seed', '7', '--write-golden'])
  assert.ok(a.only instanceof RegExp)
  assert.equal(a.only?.flags, 'i')
  assert.ok(a.only?.test('determinism-5000'))
  assert.equal(a.mode, 'full')
  assert.equal(a.child, true)
  assert.equal(a.writeGolden, true)
  assert.deepEqual(a.rest, ['x', '--seed', '7'])
  assert.equal(parseProofArgs(['--full', '--quick']).mode, 'quick')
})

test('cpuBudget reads NMC_CPUS and falls back to 1', () => {
  const saved = process.env.NMC_CPUS
  try {
    delete process.env.NMC_CPUS
    assert.equal(cpuBudget(), 1)
    process.env.NMC_CPUS = '0'
    assert.equal(cpuBudget(), 1)
    process.env.NMC_CPUS = 'abc'
    assert.equal(cpuBudget(), 1)
    process.env.NMC_CPUS = '3'
    assert.equal(cpuBudget(), 3)
  } finally {
    if (saved === undefined) delete process.env.NMC_CPUS
    else process.env.NMC_CPUS = saved
  }
})

test('hex8 gives 8 lowercase hex digits of the u32', () => {
  assert.equal(hex8(0x1a), '0000001a')
  assert.equal(hex8(-1), 'ffffffff')
})

test('percentile uses nearest rank and refuses an empty input', () => {
  const v: number[] = []
  for (let i = 100; i >= 1; i--) v.push(i)
  assert.equal(percentile(v, 50), 50)
  assert.equal(percentile(v, 99), 99)
  assert.equal(v[0], 100)
  assert.throws(() => percentile([], 50), (e: unknown) => {
    const err = e as Error
    return err.name === 'RefusalError' && err.message === '[proofkit] percentile: empty input; pass at least one value'
  })
})

test('spawnCases runs children with a limit and keeps input order', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'proofkit-'))
  try {
    const script = join(dir, 'echo.ts')
    writeFileSync(script, "const a: string[] = process.argv.slice(2)\nconsole.log(a.join(' '))\n")
    const cases = [
      { label: 'a', args: ['1', 'x'] },
      { label: 'b', args: ['2'] },
      { label: 'c', args: ['3', 'y', 'z'] },
    ]
    const out = await spawnCases(script, cases, 2)
    assert.equal(out.length, 3)
    assert.deepEqual(out.map((o) => o.label), ['a', 'b', 'c'])
    assert.deepEqual(out.map((o) => o.code), [0, 0, 0])
    assert.deepEqual(out.map((o) => o.stdout.trim()), ['1 x', '2', '3 y z'])
    for (const o of out) assert.ok(o.ms > 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('report prints label and k=v fields', () => {
  const lines: string[] = []
  const orig = console.log
  console.log = (...xs: unknown[]) => { lines.push(xs.join(' ')) }
  try {
    report('snapshot', { bytes: 1234, ms: '0.42' })
  } finally {
    console.log = orig
  }
  assert.deepEqual(lines, ['[report:snapshot] bytes=1234 ms=0.42'])
})
