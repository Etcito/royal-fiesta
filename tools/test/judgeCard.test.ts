import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { isRefusal } from '../../packages/sim/src/refusal.ts'
import { judgeCommands, pageRefOf, parseJudgeInput, preflightJudgeInput } from '../judgeCard.ts'
import type { JudgeInput, SingleJudgeInput } from '../judgeCard.ts'

const M1 = fileURLToPath(new URL('../../.nmc/judge/m1.json', import.meta.url))
const M1_PATH = '.nmc/judge/m1.json'

function m1Json(): Record<string, unknown> {
  return JSON.parse(readFileSync(M1, 'utf8')) as Record<string, unknown>
}

function m1(): SingleJudgeInput {
  const input = parseJudgeInput(m1Json(), M1_PATH)
  assert.ok('input' in input)
  return input
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
  assert.ok('input' in input)
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

const M3_PATH = '.nmc/judge/m3.json'
function m3Json() {
  return JSON.parse(readFileSync(new URL('../../.nmc/judge/m3.json', import.meta.url), 'utf8'))
}

test('M3 parses and renders three inputs with one publish and distinct judged PNGs', () => {
  const input = parseJudgeInput(m3Json(), M3_PATH)
  assert.ok('items' in input)
  assert.equal(input.items.length, 3)
  const commands = judgeCommands(input, 'out/judge/m3', 'out/judge/m3/input.json')
  assert.deepEqual(commands.slice(0, 3), [
    ['npm', 'run', 'build'],
    ['npm', 'run', 'content:pack', '--', 'apps/web/dist/content'],
    ['node', '$NMC_GPU_CLIENT', 'publish', 'apps/web/dist/'],
  ])
  assert.equal(commands.filter(c => c[2] === 'publish').length, 1)
  const renders = commands.filter(c => c[2] === 'gameCapture')
  assert.equal(renders.length, 3)
  for (let k = 0; k < 3; k++) {
    assert.deepEqual(renders[k], ['node', '$NMC_GPU_CLIENT', 'gameCapture', `out/judge/m3/input-${k}.json`, '--page-ref', '$PAGE_REF', '-o', `out/judge/m3/item-${k}/`])
  }
  const paths = ['playing', 'touch-playing', 'settings-controls'].map(n => `out/judge/m3/${n}.png`)
  assert.deepEqual(commands.filter(c => c[0] === 'python3').map(c => c[2]), paths)
  assert.deepEqual(commands.filter(c => c[0] === 'cp'), [
    ['cp', 'out/judge/m3/item-0/playing.png', paths[0]],
    ['cp', 'out/judge/m3/item-1/playing.png', paths[1]],
    ['cp', 'out/judge/m3/item-2/settings-controls.png', paths[2]],
  ])
  assert.ok(commands.slice(-3).every(c => c[0] === 'python3'))
})

test('M3 item 1 selects only the touch render, copy and judge', () => {
  const commands = judgeCommands(parseJudgeInput(m3Json(), M3_PATH), 'out/judge/m3/', '', 1)
  assert.equal(commands.length, 6)
  assert.equal(commands.filter(c => c[2] === 'publish').length, 1)
  assert.equal(commands.filter(c => c[2] === 'gameCapture').length, 1)
  assert.equal(commands[3]![3], 'out/judge/m3/input-1.json')
  assert.deepEqual(commands[4], ['cp', 'out/judge/m3/item-1/playing.png', 'out/judge/m3/touch-playing.png'])
  assert.equal(commands.filter(c => c[0] === 'python3').length, 1)
  assert.equal(commands[5]![2], 'out/judge/m3/touch-playing.png')
})

test('M3 duplicate judged names and invalid prefixes name their pointers', () => {
  const duplicate = m3Json()
  duplicate.items[1].prefix = ''
  refusedWith(() => parseJudgeInput(duplicate, M3_PATH), /m3\.json#\/items\/1\/judge\/0\/capture:.*repeats/)
  for (const prefix of ['Touch-', '../', 'a'.repeat(25), null]) {
    const bad = m3Json()
    bad.items[1].prefix = prefix
    refusedWith(() => parseJudgeInput(bad, M3_PATH), /m3\.json#\/items\/1\/prefix:/)
  }
})

test('items validates bounds, optional prefixes, nested pointers and selected index', () => {
  for (const items of [[], Array(9).fill(m3Json().items[0])]) {
    refusedWith(() => parseJudgeInput({ page: 'game', op: 'gameCapture', items }, M3_PATH), /m3\.json#\/items:/)
  }
  const json = m3Json()
  delete json.items[0].prefix
  const input = parseJudgeInput(json, M3_PATH)
  for (const index of [-1, 3, 0.5, NaN]) {
    refusedWith(() => judgeCommands(input, 'out/judge/m3', '', index), /argv\/--item:/)
  }
  delete json.items[2].judge[0].description
  refusedWith(() => parseJudgeInput(json, M3_PATH), /m3\.json#\/items\/2\/judge\/0\/description:/)
})

test('each M3 item independently judges its required image at score 6', () => {
  const input = parseJudgeInput(m3Json(), M3_PATH)
  const captures = ['playing', 'touch-playing', 'settings-controls']
  for (const [k, capture] of captures.entries()) {
    const commands = judgeCommands(input, 'out/judge/m3', '', k)
    assert.equal(commands.length, 6)
    assert.equal(commands[3]![3], `out/judge/m3/input-${k}.json`)
    assert.equal(commands[5]![2], `out/judge/m3/${capture}.png`)
    assert.deepEqual(commands[5]!.slice(-2), ['--min-score', '6'])
  }
})

test('command cards keep the dependency chain', () => {
  const cards = JSON.parse(readFileSync(new URL('../../.nmc/commands.json', import.meta.url), 'utf8'))
  assert.deepEqual(cards.map((c: { name: string }) => c.name), [
    'sdf-port-typecheck', 'sdf-port-build', 'candy-content-pack', 'candy-assets-proof',
    'rf-tests', 'rf-judge-m3', 'rf-judge-m4-candy', 'rf-judge-m4-ice-slide-gates',
    'rf-judge-m4-jungle-crane-crossing', 'rf-judge-m4-neon-piston-alley',
  ])
  assert.equal(cards.length, 10)
  assert.equal(cards.at(-1).command, 'node --experimental-strip-types tools/judgeCard.ts m4 --item 3')
  assert.equal(cards[0].after, undefined)
  assert.deepEqual(cards[1].after, ['sdf-port-typecheck'])
  assert.deepEqual(cards[2].after, ['sdf-port-build'])
  assert.deepEqual(cards[3].after, ['candy-content-pack'])
  assert.deepEqual(cards[4].after, ['sdf-port-build', 'candy-assets-proof'])
  const earlier = new Set<string>()
  for (const card of cards) {
    for (const dependency of card.after ?? []) assert.ok(earlier.has(dependency))
    if (card.name.startsWith('rf-judge-')) assert.deepEqual(card.after, ['rf-tests'])
    earlier.add(card.name)
  }
})

test('M3 inputs match the split, touch and remap capture contract', () => {
  const input = parseJudgeInput(m3Json(), M3_PATH)
  assert.ok('items' in input)
  assert.deepEqual(input.items.map(item => item.input), [
    { content: 'sdf', course: 'race-sprint', flow: 'match', clients: 1, local: 3,
      width: 1920, height: 1080, captureAt: ['playing'] },
    { content: 'sdf', course: 'race-sprint', flow: 'match', clients: 1, local: 1,
      touch: true, width: 844, height: 390, captureAt: ['playing'] },
    { content: 'sdf', flow: 'tour', clients: 1,
      width: 1920, height: 1080, captureAt: ['settings-controls'] },
  ])
})

test('items accepts both size boundaries and a 24-character prefix', () => {
  for (const count of [1, 8]) {
    const items = Array.from({ length: count }, (_, k) => ({
      prefix: `${'a'.repeat(23)}${k}`,
      input: {},
      judge: [{ capture: 'playing', description: 'A course' }],
    }))
    const parsed = parseJudgeInput({ page: 'game', op: 'gameCapture', items }, M3_PATH)
    assert.ok('items' in parsed)
    assert.equal(parsed.items.length, count)
  }
})

test('items refuses mixed formats and collisions formed from different prefixes', () => {
  const mixed = { ...m3Json(), input: {} }
  refusedWith(() => parseJudgeInput(mixed, M3_PATH), /m3\.json#\/input: has unknown key/)
  const json = m3Json()
  json.items[0].prefix = 'touch-'
  json.items[1].prefix = ''
  json.items[1].judge[0].capture = 'touch-playing'
  refusedWith(() => parseJudgeInput(json, M3_PATH), /m3\.json#\/items\/1\/judge\/0\/capture:.*repeats/)
})

test('preflightJudgeInput accepts the M1 judge file', () => {
  preflightJudgeInput(m1(), M1_PATH)
})

test('preflightJudgeInput refuses with the op message: 4 clients with a course', () => {
  const json = m1Json()
  ;(json.input as Record<string, unknown>).course = 'candy'
  refusedWith(() => preflightJudgeInput(parseJudgeInput(json, M1_PATH), M1_PATH), /\.nmc\/judge\/m1\.json#\/input.*4 clients play the in-page hub loop; drop course and net/)
})

test('preflightJudgeInput refuses a moment that is not of the flow', () => {
  const json = m1Json()
  ;(json.input as Record<string, unknown>).captureAt = ['back-in-hub']
  refusedWith(() => preflightJudgeInput(parseJudgeInput(json, M1_PATH), M1_PATH), /"back-in-hub" is not a moment of flow match/)
})
