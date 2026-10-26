import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { isRefusal } from '../../packages/sim/src/refusal.ts'
import { buildCaptureRecord, capturesProblems, runCaptureInputs, sourcesOf } from '../contentCapture.ts'
import type { CaptureInput } from '../contentCapture.ts'

const INPUT: CaptureInput = {
  content: 'sdf',
  course: 'race-hammer-hill',
  flow: 'match',
  clients: 1,
  width: 1920,
  height: 1080,
  captureAt: ['match-8s'],
}
const CAPTURE = { name: 'race-match-8s', width: 1920, height: 1080, sha256: 'a'.repeat(64), bytes: 2048, nonEmpty: true }
const EXPECTED = ['race-match-8s']

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'content-capture-'))
}

function writeInput(root: string, name: string, input: unknown): string {
  const rel = `proofs/c5/${name}.input.json`
  mkdirSync(join(root, 'proofs/c5'), { recursive: true })
  writeFileSync(join(root, rel), JSON.stringify(input, null, 2) + '\n')
  return rel
}

async function goodRecord(root: string): Promise<Record<string, unknown>> {
  const input = writeInput(root, 'race', INPUT)
  return {
    renderer: 'raa',
    content: 'sdf',
    inputs: [input],
    sources: await sourcesOf([input], root),
    captures: [structuredClone(CAPTURE)],
  }
}

function writeRecord(root: string, record: unknown): void {
  mkdirSync(join(root, 'proofs/c5'), { recursive: true })
  writeFileSync(join(root, 'proofs/c5/captures.json'), JSON.stringify(record, null, 2) + '\n')
}

test('an input with an unknown key is refused with its path', async () => {
  const root = tempRoot()
  const rel = writeInput(root, 'x', { ...INPUT, reload: true })
  await assert.rejects(sourcesOf([rel], root), (e: unknown) => {
    assert.ok(isRefusal(e))
    assert.match(e.message, /^\[content-capture\] proofs\/c5\/x\.input\.json#\/reload:/)
    return true
  })
})

test('a wrong value is refused with the field path', async () => {
  const root = tempRoot()
  const rel = writeInput(root, 'x', { ...INPUT, flow: 'race' })
  await assert.rejects(sourcesOf([rel], root), (e: unknown) => {
    assert.ok(isRefusal(e))
    assert.match(e.message, /proofs\/c5\/x\.input\.json#\/flow: flow is "race"/)
    return true
  })
})

test('sourcesOf hashes the course, its candy assets and the common penguin files', async () => {
  const root = tempRoot()
  const rel = writeInput(root, 'race', INPUT)
  const sources = await sourcesOf([rel], root)
  const keys = Object.keys(sources)
  assert.deepEqual(keys, [...keys].sort())
  assert.ok(keys.includes('courses/race-hammer-hill.course.json'))
  assert.ok(keys.includes('assets/candy/candy.pendulum-hammer.asset.json'))
  assert.ok(keys.some(k => k.startsWith('assets/candy/')))
  assert.ok(keys.includes('assets/common/penguin.body.asset.json'))
  assert.ok(keys.includes('assets/common/costume.propeller-hat.asset.json'))
  assert.ok(keys.includes('assets/common/costume.fish-scarf.asset.json'))
  assert.ok(keys.includes('assets/common/costume.pineapple-suit.asset.json'))
  for (const hash of Object.values(sources)) assert.match(hash, /^[0-9a-f]{64}$/)
})

test('a good record has no problems', async () => {
  const root = tempRoot()
  writeRecord(root, await goodRecord(root))
  assert.deepEqual(await capturesProblems('c5', EXPECTED, root), [])
})

test('a 960x540 capture is a size problem', async () => {
  const root = tempRoot()
  const record = await goodRecord(root)
  const capture = (record.captures as Record<string, unknown>[])[0]
  capture.width = 960
  capture.height = 540
  writeRecord(root, record)
  const problems = await capturesProblems('c5', EXPECTED, root)
  assert.ok(problems.some(p => p.includes('960x540, not 1920x1080')))
})

test('a capture with nonEmpty false is a problem', async () => {
  const root = tempRoot()
  const record = await goodRecord(root)
  ;(record.captures as Record<string, unknown>[])[0].nonEmpty = false
  writeRecord(root, record)
  const problems = await capturesProblems('c5', EXPECTED, root)
  assert.ok(problems.some(p => p.includes('nonEmpty false')))
})

test('a changed source hash is exactly one stale problem', async () => {
  const root = tempRoot()
  const record = await goodRecord(root)
  record.sources = { ...(record.sources as Record<string, string>), 'assets/common/penguin.body.asset.json': '0'.repeat(64) }
  writeRecord(root, record)
  const problems = await capturesProblems('c5', EXPECTED, root)
  const stale = problems.filter(p => p.startsWith('stale record; re-render: '))
  assert.equal(stale.length, 1)
  assert.match(stale[0], /penguin\.body\.asset\.json/)
})

test('a missing expected capture is a problem', async () => {
  const root = tempRoot()
  writeRecord(root, await goodRecord(root))
  const problems = await capturesProblems('c5', [...EXPECTED, 'race-hub'], root)
  assert.ok(problems.some(p => p === "missing capture 'race-hub'; re-run the --gpu-run producer"))
})

test('a missing record names the producer', async () => {
  const root = tempRoot()
  assert.deepEqual(await capturesProblems('c5', EXPECTED, root), ['proofs/c5/captures.json is missing: run the --gpu-run producer'])
})

test('runCaptureInputs refuses a missing dist with the build fix', async () => {
  const root = tempRoot()
  const cwd = process.cwd()
  try {
    await assert.rejects(runCaptureInputs('c5', [], root), (e: unknown) => {
      assert.ok(isRefusal(e))
      assert.match(e.message, /^\[content-capture\] apps\/web\/dist:/)
      assert.match(e.message, /npm run build/)
      return true
    })
  } finally {
    process.chdir(cwd)
  }
})

const ADAPTER = { vendor: 'nvidia', architecture: 'ampere', description: 'NVIDIA GeForce RTX 3090', software: false }

function fakeResult(json: Record<string, unknown> = {}): { file: string; json: Record<string, unknown> } {
  return {
    file: 'out/c5/race/result.json',
    json: {
      renderer: 'raa',
      adapter: ADAPTER,
      software: false,
      pageRef: 'page-ref-1',
      captures: [{ ...CAPTURE, name: 'match-8s' }],
      frameTiming: null,
      content: 'sdf',
      courses: ['race-hammer-hill'],
      events: [{ t: 0, what: 'run' }],
      ...json,
    },
  }
}

test('buildCaptureRecord renames op moments to <case>-<moment>', () => {
  const record = buildCaptureRecord([{ name: 'race', input: INPUT, result: fakeResult() }], ['proofs/c5/race.input.json'], 'page-ref-1', {
    'courses/race-hammer-hill.course.json': 'a'.repeat(64),
  })
  assert.equal(record.renderer, 'raa')
  assert.equal(record.content, 'sdf')
  assert.equal(record.frameTiming, null)
  assert.deepEqual(record.captures, [{ ...CAPTURE, name: 'race-match-8s' }])
  assert.deepEqual(record.courses, { race: ['race-hammer-hill'] })
  assert.deepEqual(record.events, { race: [{ t: 0, what: 'run' }] })
  assert.deepEqual(record.inputs, ['proofs/c5/race.input.json'])
  assert.deepEqual(record.sources, { 'courses/race-hammer-hill.course.json': 'a'.repeat(64) })
})

test('buildCaptureRecord refuses a non-raa renderer', () => {
  assert.throws(
    () => buildCaptureRecord([{ name: 'race', input: INPUT, result: fakeResult({ renderer: 'v0' }) }], ['proofs/c5/race.input.json'], 'page-ref-1', {}),
    (e: unknown) => {
      assert.ok(isRefusal(e))
      assert.match(e.message, /renderer/)
      return true
    },
  )
})

test('buildCaptureRecord refuses captures that do not match captureAt', () => {
  assert.throws(
    () => buildCaptureRecord(
      [{ name: 'race', input: INPUT, result: fakeResult({ captures: [{ ...CAPTURE, name: 'match-9s' }] }) }],
      ['proofs/c5/race.input.json'],
      'page-ref-1',
      {},
    ),
    (e: unknown) => {
      assert.ok(isRefusal(e))
      assert.match(e.message, /match-9s/)
      assert.match(e.message, /match-8s/)
      return true
    },
  )
})
