import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { isRefusal } from '../../packages/sim/src/refusal.ts'
import { judgeLoop, parseScore } from '../judgeLoop.ts'
import type { JudgeOptions } from '../judgeLoop.ts'

type Run = NonNullable<JudgeOptions['run']>

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'rf-judge-loop-'))
}

function scriptedRun(results: { code: number; out: string }[], calls: string[][]): Run {
  return async args => {
    calls.push(args)
    const result = results[calls.length - 1]
    assert.ok(result, `unexpected attempt ${calls.length}`)
    return result
  }
}

test('pass on the first attempt makes one call', async () => {
  const root = tempRoot()
  try {
    const calls: string[][] = []
    const outcome = await judgeLoop('walk', 'walk.png', 'a penguin walking', {
      root,
      run: scriptedRun([{ code: 0, out: 'JUDGE PASS: 8.0/10 (minimum 6.0)' }], calls),
    })
    assert.equal(calls.length, 1)
    assert.equal(outcome.accepted, 'pass')
    assert.deepEqual(outcome.attempts, [{ score: 8, pass: true, output: 'JUDGE PASS: 8.0/10 (minimum 6.0)' }])
    assert.deepEqual(calls[0], ['walk.png', '--description', 'a penguin walking', '--min-score', '6'])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('red, red, pass stops on the third attempt with pass', async () => {
  const root = tempRoot()
  try {
    const calls: string[][] = []
    const outcome = await judgeLoop('walk', 'walk.png', 'a penguin walking', {
      root,
      aspect: 'design',
      minScore: 7,
      run: scriptedRun([
        { code: 1, out: 'JUDGE FAIL: 4.0/10 (minimum 7.0)' },
        { code: 1, out: 'JUDGE FAIL: 5.0/10 (minimum 7.0)' },
        { code: 0, out: 'JUDGE PASS: 7.5/10 (minimum 7.0)' },
      ], calls),
    })
    assert.equal(calls.length, 3)
    assert.equal(outcome.accepted, 'pass')
    assert.deepEqual(outcome.attempts.map(a => a.score), [4, 5, 7.5])
    assert.deepEqual(outcome.attempts.map(a => a.pass), [false, false, true])
    assert.deepEqual(calls[0], ['walk.png', '--description', 'a penguin walking', '--aspect', 'design', '--min-score', '7'])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('three reds are accepted after 3 red', async () => {
  const root = tempRoot()
  try {
    const calls: string[][] = []
    const outcome = await judgeLoop('walk', 'walk.png', 'a penguin walking', {
      root,
      run: scriptedRun([
        { code: 1, out: 'JUDGE FAIL: 3.0/10' },
        { code: 1, out: 'JUDGE FAIL: 3.5/10' },
        { code: 1, out: 'JUDGE FAIL: 4.0/10' },
      ], calls),
    })
    assert.equal(calls.length, 3)
    assert.equal(outcome.accepted, 'accepted-after-3-red')
    assert.deepEqual(outcome.attempts.map(a => a.score), [3, 3.5, 4])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a missing picture refuses before any run', async () => {
  const root = tempRoot()
  try {
    let called = false
    const run: Run = async () => {
      called = true
      return { code: 0, out: '' }
    }
    await assert.rejects(judgeLoop('walk', '', 'a penguin walking', { root, run }), (e: unknown) => {
      assert.ok(isRefusal(e))
      assert.match(e.message, /^\[judge\] picture: is missing or empty/)
      return true
    })
    assert.equal(called, false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('an unset judge client refuses when no run is injected', async () => {
  const root = tempRoot()
  const saved = process.env.NMC_JUDGE_CLIENT
  try {
    delete process.env.NMC_JUDGE_CLIENT
    await assert.rejects(judgeLoop('walk', 'walk.png', 'a penguin walking', { root }), (e: unknown) => {
      assert.ok(isRefusal(e))
      assert.match(e.message, /^\[judge\] NMC_JUDGE_CLIENT: is unset/)
      return true
    })
  } finally {
    if (saved === undefined) delete process.env.NMC_JUDGE_CLIENT
    else process.env.NMC_JUDGE_CLIENT = saved
    rmSync(root, { recursive: true, force: true })
  }
})

test('the JSON record is written under the temporary root', async () => {
  const root = tempRoot()
  try {
    const calls: string[][] = []
    const outcome = await judgeLoop('walk', 'walk.png', 'a penguin walking', {
      root,
      run: scriptedRun([
        { code: 1, out: 'JUDGE FAIL: 4.0/10' },
        { code: 0, out: 'JUDGE PASS: 6.0/10' },
      ], calls),
    })
    const text = readFileSync(join(root, 'out', 's3', 'judge', 'walk.json'), 'utf8')
    assert.ok(text.endsWith('\n'))
    assert.match(text, /^\{\n  "name": "walk",/)
    assert.deepEqual(JSON.parse(text), outcome)
    assert.equal(outcome.attempts.length, 2)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('parseScore returns null when the output has no score', () => {
  assert.equal(parseScore('no verdict here'), null)
  assert.equal(parseScore('score: 7'), 7)
  assert.equal(parseScore('JUDGE PASS: 9.0/10'), 9)
})
