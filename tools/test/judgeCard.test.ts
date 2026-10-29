import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { isRefusal } from '../../packages/sim/src/refusal.ts'
import { judgeCommands, pageRefOf, parseJudgeInput } from '../judgeCard.ts'
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
    flow: 'match',
    clients: 4,
    width: 960,
    height: 540,
    captureAt: ['match-5s'],
  })
  assert.deepEqual(input.judge.map(item => item.capture), ['match-5s'])
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
  assert.equal(commands.length, 5)

  assert.deepEqual(commands[0], ['npm', 'run', 'build'])
  assert.deepEqual(commands[1], ['npm', 'run', 'content:pack', '--', 'apps/web/dist/content'])
  assert.deepEqual(commands[2], ['node', '$NMC_GPU_CLIENT', 'publish', 'apps/web/dist/'])

  const render = commands[3]!
  assert.deepEqual(render.slice(0, 3), ['node', '$NMC_GPU_CLIENT', 'gameCapture'])
  assert.ok(render.includes('out/judge/m1/input.json'))
  assert.equal(render[render.indexOf('--page-ref') + 1], '$PAGE_REF')
  assert.equal(render[render.indexOf('-o') + 1], 'out/judge/m1/')

  const judge = commands[4]!
  assert.equal(judge[0], 'python3')
  assert.equal(judge[1], '$NMC_JUDGE_CLIENT')
  assert.equal(judge[2], 'out/judge/m1/match-5s.png')
  assert.equal(judge[judge.indexOf('--description') + 1], m1().judge[0]!.description)
  assert.deepEqual(judge.slice(-2), ['--min-score', '6'])
})

test('judgeCommands normalises an out dir that has no trailing slash', () => {
  const commands = judgeCommands(m1(), 'out/judge/m1', 'out/judge/m1/input.json')
  assert.equal(commands[3]![commands[3]!.indexOf('-o') + 1], 'out/judge/m1/')
  assert.equal(commands[4]![2], 'out/judge/m1/match-5s.png')
})

test('pageRefOf takes the page_ref publish printed and refuses a response without one', () => {
  assert.equal(pageRefOf('{"page_ref":"exec-9640-3a5d"}\n'), 'exec-9640-3a5d')
  refusedWith(() => pageRefOf('{"ok":true}'), /^\[judge\] publish: response has no page_ref; .*$/)
  refusedWith(() => pageRefOf('not json'), /^\[judge\] publish: printed invalid JSON; .*$/)
})

test('parseJudgeInput accepts playing+8s and judgeCommands keeps it in the PNG path', () => {
  const json = m1Json()
  const item = (json.judge as Record<string, unknown>[])[0]!
  item.capture = 'playing+8s'
  const input = parseJudgeInput(json, M1_PATH)
  assert.deepEqual(input.judge.map(i => i.capture), ['playing+8s'])
  const commands = judgeCommands(input, 'out/judge/m2', 'out/judge/m2/input.json')
  assert.equal(commands.at(-1)![2], 'out/judge/m2/playing+8s.png')
})

test('parseJudgeInput refuses a capture with a space', () => {
  const json = m1Json()
  const item = (json.judge as Record<string, unknown>[])[0]!
  item.capture = 'a b'
  refusedWith(
    () => parseJudgeInput(json, M1_PATH),
    /^\[judge\] \.nmc\/judge\/m1\.json#\/judge\/0\/capture: capture "a b" is not a file-safe capture name; fix .*$/,
  )
})
