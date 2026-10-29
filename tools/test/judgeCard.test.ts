import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { isRefusal } from '../../packages/sim/src/refusal.ts'
import { judgeCommands, parseJudgeInput } from '../judgeCard.ts'
import type { JudgeInput } from '../judgeCard.ts'

const M1 = fileURLToPath(new URL('../../.nmc/judge/m1.json', import.meta.url))
const M1_PATH = '.nmc/judge/m1.json'

function m1Json(): Record<string, unknown> {
  return JSON.parse(readFileSync(M1, 'utf8')) as Record<string, unknown>
}

function m1(): JudgeInput {
  return parseJudgeInput(m1Json(), M1_PATH)
}

function refusedWith(fn: () => unknown, pattern: RegExp): void {
  assert.throws(fn, (e: unknown) => {
    assert.ok(isRefusal(e))
    assert.match(e.message, pattern)
    return true
  })
}

test('parseJudgeInput accepts the M1 judge file', () => {
  const input = m1()
  assert.equal(input.page, 'game')
  assert.equal(input.op, 'gameCapture')
  assert.deepEqual(input.input, {
    content: 'sdf',
    course: 'race-bean-dash',
    flow: 'match',
    clients: 4,
    width: 1920,
    height: 1080,
    captureAt: ['playing'],
  })
  assert.deepEqual(input.judge.map(item => item.capture), ['playing'])
  assert.match(input.judge[0]!.description, /Four penguin characters/)
})

test('parseJudgeInput refuses a judge item without a description', () => {
  const json = m1Json()
  const item = (json.judge as Record<string, unknown>[])[0]!
  delete item.description
  refusedWith(
    () => parseJudgeInput(json, M1_PATH),
    /^\[judge\] \.nmc\/judge\/m1\.json#\/judge\/0\/description: description is missing or empty; fix /,
  )
})

test('parseJudgeInput refuses a wrong op with its pointer and a fix', () => {
  const json = m1Json()
  json.op = 'sdfmCapture'
  refusedWith(
    () => parseJudgeInput(json, M1_PATH),
    /^\[judge\] \.nmc\/judge\/m1\.json#\/op: op is "sdfmCapture", not 'gameCapture'; fix .*$/,
  )
})

test('judgeCommands gives build, publish, render and one judge run for M1', () => {
  const commands = judgeCommands(m1(), 'out/judge/m1/', 'out/judge/m1/input.json')
  assert.equal(commands.length, 4)

  assert.deepEqual(commands[0], ['npm', 'run', 'build'])
  assert.deepEqual(commands[1], ['node', '$NMC_GPU_CLIENT', 'publish', 'apps/web/dist/'])

  const render = commands[2]!
  assert.ok(render.includes('out/judge/m1/input.json'))
  assert.equal(render[render.indexOf('--page-ref') + 1], 'game')
  assert.equal(render[render.indexOf('-o') + 1], 'out/judge/m1/')

  const judge = commands[3]!
  assert.equal(judge[0], 'python3')
  assert.equal(judge[1], '$NMC_JUDGE_CLIENT')
  assert.equal(judge[2], 'out/judge/m1/playing.png')
  assert.equal(judge[judge.indexOf('--description') + 1], m1().judge[0]!.description)
  assert.deepEqual(judge.slice(-2), ['--min-score', '6'])
})

test('judgeCommands normalises an out dir that has no trailing slash', () => {
  const commands = judgeCommands(m1(), 'out/judge/m1', 'out/judge/m1/input.json')
  assert.equal(commands[2]![commands[2]!.indexOf('-o') + 1], 'out/judge/m1/')
  assert.equal(commands[3]![2], 'out/judge/m1/playing.png')
})
