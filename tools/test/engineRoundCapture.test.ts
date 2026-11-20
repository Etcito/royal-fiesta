import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { judgeImages, keptRows, loadInventory, main, renderOrder, requireProblems, selectRows, type InventoryRow } from '../engineRoundCapture.ts'

function row(overrides: Record<string, unknown> = {}) {
  return { id: 'fiesta', milestone: 'm2', filename: 'fiesta-run.png', args: { course: 'fiesta' }, require: [], description: 'A run', held_constant: [], ...overrides }
}

function withInventory(rows: unknown[], run: (path: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'engine-round-'))
  const path = join(dir, 'inventory.json')
  try { writeFileSync(path, JSON.stringify(rows)); run(path) } finally { rmSync(dir, { recursive: true, force: true }) }
}

test('loadInventory validates row fields and args at their pointers', () => {
  withInventory([row()], path => assert.equal(loadInventory(path)[0].milestone, 'm2'))
  const cases: [unknown[], RegExp][] = [
    [[row(), row({ filename: 'second.png' })], /inventory\.json#\/1\/id/],
    [[row(), row({ id: 'second' })], /inventory\.json#\/1\/filename/],
    [[row({ filename: 'Bad.PNG' })], /inventory\.json#\/0\/filename/],
    [[row({ args: { course: 'fiesta', extra: true } })], /inventory\.json#\/0\/args\/extra/],
    [[row({ milestone: 'm9' })], /inventory\.json#\/0\/milestone/],
  ]
  for (const [rows, pointer] of cases) withInventory(rows, path => assert.throws(() => loadInventory(path), pointer))
})

test('requireProblems evaluates E8 operators and nested facts', () => {
  assert.deepEqual(requireProblems({ seats: 8 }, ['seats eq 8']), [])
  assert.match(requireProblems({ seats: 7 }, ['seats eq 8'])[0], /got 7/)
  assert.deepEqual(requireProblems({ bodies: 21 }, ['bodies gt 20']), [])
  assert.deepEqual(requireProblems({ tick: 120 }, ['tick ge 120']), [])
  assert.deepEqual(requireProblems({ faults: 0 }, ['faults lt 1']), [])
  assert.deepEqual(requireProblems({ gpuErrors: [] }, ['gpuErrors empty']), [])
  assert.match(requireProblems({ gpuErrors: ['x'] }, ['gpuErrors empty'])[0], /got \["x"\]/)
  assert.deepEqual(requireProblems({ local: { travelZ: 2 } }, ['local.travelZ gt 1']), [])
  assert.deepEqual(requireProblems({}, ['missing eq 1']), ['missing eq 1: fact missing is absent'])
  assert.deepEqual(requireProblems({}, ['broken']), ["broken: not 'broken'"])
})

test('selectRows preserves file order for the requested milestone', () => {
  const rows = [row({ id: 'a' }), row({ id: 'b', milestone: 'm3' }), row({ id: 'c' })] as unknown as InventoryRow[]
  assert.deepEqual(selectRows(rows, 'm2').map(item => item.id), ['a', 'c'])
})

test('keptRows reuses only rows with the same build, description and nonempty image', () => {
  const dir = mkdtempSync(join(tmpdir(), 'engine-round-store-'))
  try {
    const attempt = join(dir, 'attempts/1')
    mkdirSync(attempt, { recursive: true })
    const current = row() as unknown as InventoryRow
    const prior = { ...current }
    writeFileSync(join(attempt, 'selection.json'), JSON.stringify({ build: { commit: 'abc' }, rows: [prior] }))
    writeFileSync(join(attempt, current.filename), 'png')
    assert.deepEqual(keptRows(dir, [current], { commit: 'abc' }).kept, [{ id: 'fiesta', filename: current.filename, attempt: 1 }])
    assert.equal(keptRows(dir, [{ ...current, description: 'Changed' }], { commit: 'abc' }).render.length, 1)
    assert.equal(keptRows(dir, [current], { commit: 'def' }).render.length, 1)
    rmSync(join(attempt, current.filename))
    assert.equal(keptRows(dir, [current], { commit: 'abc' }).render.length, 1)
    process.env.ENGINE_ROUND_RERENDER_ALL = '1'
    assert.deepEqual(keptRows(dir, [current], { commit: 'abc' }).kept, [])
  } finally {
    delete process.env.ENGINE_ROUND_RERENDER_ALL
    rmSync(dir, { recursive: true, force: true })
  }
})

test('clean allocates the next attempt and preserves prior attempt files', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'engine-round-clean-'))
  const oldCache = process.env.NMC_CACHE_DIR
  try {
    const delivery = join(dir, 'delivery')
    const store = join(dir, 'store/engine-round-m2')
    mkdirSync(join(store, 'attempts/2'), { recursive: true })
    mkdirSync(delivery, { recursive: true })
    writeFileSync(join(store, 'attempts/2/kept.png'), 'old')
    writeFileSync(join(delivery, 'selection.json'), '{}')
    process.env.NMC_CACHE_DIR = join(dir, 'store')
    assert.equal(await main(['clean', '--milestone', 'm2', '--page', 'dist', '--out', delivery]), 0)
    assert.equal(JSON.parse(readFileSync(join(store, 'current.json'), 'utf8')).attempt, 3)
    assert.equal(readFileSync(join(store, 'attempts/2/kept.png'), 'utf8'), 'old')
    assert.ok(existsSync(join(store, 'attempts/3/selection.json')))
  } finally {
    if (oldCache === undefined) delete process.env.NMC_CACHE_DIR
    else process.env.NMC_CACHE_DIR = oldCache
    rmSync(dir, { recursive: true, force: true })
  }
})

test('main returns usage status when check options are missing', async () => {
  assert.equal(await main(['check']), 2)
})

test('renderOrder puts failures before never-rendered rows and prior successes', () => {
  const rows = [row({ id: 'old' }), row({ id: 'new' }), row({ id: 'failed' })] as unknown as InventoryRow[]
  assert.deepEqual(renderOrder(rows, ['failed'], ['old']).map(item => item.id), ['failed', 'new', 'old'])
})

test('judgeImages stops at its budget and reuses identical passing images', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'engine-round-judge-'))
  try {
    const delivery = join(dir, 'delivery')
    const attempt = join(dir, 'attempts/1')
    mkdirSync(delivery, { recursive: true })
    mkdirSync(attempt, { recursive: true })
    const rows = ['a', 'b', 'c'].map(id => row({ id, filename: `${id}.png` })) as unknown as InventoryRow[]
    for (const item of rows) {
      writeFileSync(join(delivery, item.filename), item.id)
      writeFileSync(join(attempt, item.filename), item.id)
    }
    let now = 0
    let calls = 0
    const runner = async () => { calls++; now += 5000; return 'score: 7' }
    assert.equal(await judgeImages(dir, delivery, 1, rows, 10, runner, () => now), 1)
    assert.equal(calls, 2)
    assert.ok(existsSync(join(dir, 'verdicts/a.png.json')))
    assert.ok(existsSync(join(dir, 'verdicts/b.png.json')))
    assert.equal(existsSync(join(dir, 'verdicts/c.png.json')), false)
    assert.equal(await judgeImages(dir, delivery, 1, rows.slice(0, 1), 10, runner, () => now), 0)
    assert.equal(calls, 2)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('judgeImages hands the row held_constant list to the judge and re-judges when it changes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'engine-round-held-'))
  try {
    const delivery = join(dir, 'delivery')
    const attempt = join(dir, 'attempts/1')
    mkdirSync(delivery, { recursive: true })
    mkdirSync(attempt, { recursive: true })
    const first = row({ id: 'a', filename: 'a.png', held_constant: ['the light'] }) as unknown as InventoryRow
    writeFileSync(join(delivery, 'a.png'), 'a')
    writeFileSync(join(attempt, 'a.png'), 'a')
    const seen: string[][] = []
    const runner = async (_image: string, _description: string, held: string[]) => { seen.push(held); return 'score: 7' }
    assert.equal(await judgeImages(dir, delivery, 1, [first], 10, runner, () => 0), 0)
    assert.equal(await judgeImages(dir, delivery, 1, [first], 10, runner, () => 0), 0)
    assert.deepEqual(seen, [['the light']])
    const changed = { ...first, held_constant: ['the light', 'the ground'] } as InventoryRow
    assert.equal(await judgeImages(dir, delivery, 1, [changed], 10, runner, () => 0), 0)
    assert.deepEqual(seen[1], ['the light', 'the ground'])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
