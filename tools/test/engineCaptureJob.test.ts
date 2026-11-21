import assert from 'node:assert/strict'
import { deflateSync } from 'node:zlib'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { runEngineCaptureJob, type CaptureExecution, type CaptureJobConfig, type CaptureResult, type CaptureRow } from '../engineCaptureJob.ts'
import { judgeImages, renderOrder, type InventoryRow } from '../engineRoundCapture.ts'

type Args = { seed: number }

/** Writes a structurally valid 1920x1080 RGBA PNG; the shared job validates structure, not picture content. */
function lifecyclePng(): Buffer {
  const width = 1920
  const height = 1080
  const chunk = (type: string, body: Buffer) => {
    const head = Buffer.alloc(8)
    head.writeUInt32BE(body.length, 0)
    head.write(type, 4, 'ascii')
    const tail = Buffer.alloc(4)
    tail.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), body])), 0)
    return Buffer.concat([head, body, tail])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 6
  const raw = Buffer.alloc(height * (width * 4 + 1))
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
  }
  return (crc ^ 0xffffffff) >>> 0
}

const PNG = lifecyclePng().toString('base64')

function item(id: string, overrides: Record<string, unknown> = {}) {
  return { id, stage: 's1', filename: `${id}-one.png`, args: { seed: 1 }, require: ['seed eq 1'], description: `Row ${id}`, held_constant: [], ...overrides }
}

type Env = { dir: string; inventory: string; out: string; store: string; rows: unknown[]; runs: string[]; judged: string[][] }

/** Shared configuration with injected rendering, publishing and judging; no GPU or python3 runs. */
function config(env: Env, failing: readonly string[] = []): CaptureJobConfig<Args> {
  return {
    topic: 'lifecycle-test-',
    inventory: env.inventory,
    page: join(env.dir, 'page'),
    parseArgs: value => {
      if (!value || typeof value !== 'object' || typeof (value as Args).seed !== 'number') throw new Error('args.seed must be a number')
      return value as Args
    },
    validateSelection: async () => {},
    run: async (row: CaptureRow<Args>): Promise<CaptureResult> => {
      env.runs.push(row.id)
      if (failing.includes(row.id)) throw new Error(`${row.id} failed on purpose`)
      return { facts: { seed: row.args.seed }, capture: { name: row.filename, width: 1920, height: 1080, mime: 'image/png', base64: PNG } }
    },
  }
}

function execution(env: Env, answer: (count: number) => string = () => 'score: 7'): CaptureExecution {
  let count = 0
  return {
    waitForGpu: async () => {},
    publish: async () => 'page-ref',
    judge: async (image, description, held) => {
      env.judged.push([image, description, ...held])
      count++
      return answer(count)
    },
    clock: () => 0,
  }
}

function setup(rows: unknown[]): Env {
  const dir = mkdtempSync(join(tmpdir(), 'capture-job-'))
  const inventory = join(dir, 'inventory.json')
  writeFileSync(inventory, JSON.stringify(rows))
  const out = join(dir, 'delivery')
  mkdirSync(out, { recursive: true })
  return { dir, inventory, out, store: join(dir, 'cache/lifecycle-test-s1'), rows, runs: [], judged: [] }
}

function withCache<T>(env: Env, run: () => Promise<T>): Promise<T> {
  const previous = process.env.NMC_CACHE_DIR
  process.env.NMC_CACHE_DIR = join(env.dir, 'cache')
  return run().finally(() => {
    if (previous === undefined) delete process.env.NMC_CACHE_DIR
    else process.env.NMC_CACHE_DIR = previous
  })
}

function writeInventory(env: Env, rows: unknown[]): void {
  writeFileSync(env.inventory, JSON.stringify(rows))
}

test('dispatcher refuses invalid selections with usage status or a functional failure', async () => {
  const env = setup([item('a')])
  try {
    await withCache(env, async () => {
      const cfg = config(env)
      assert.equal(await runEngineCaptureJob(cfg, []), 2)
      assert.equal(await runEngineCaptureJob(cfg, ['check']), 2)
      assert.equal(await runEngineCaptureJob(cfg, ['bogus', '--stage', 's1', '--page', 'p', '--out', env.out]), 2)
      assert.equal(await runEngineCaptureJob(cfg, ['check', '--stage', 's1', '--page', 'p', '--out', env.out, '--budget-s', '-1']), 2)
      assert.equal(await runEngineCaptureJob(cfg, ['check', '--stage', 'missing', '--page', 'p', '--out', env.out], execution(env)), 1)
      assert.equal(await runEngineCaptureJob(cfg, ['render', '--stage', 's1', '--page', 'p', '--out', env.out], execution(env)), 1)
      assert.equal(await runEngineCaptureJob(cfg, ['clean', '--stage', 's1', '--page', 'p', '--out', env.out], execution(env)), 1)
    })
  } finally { rmSync(env.dir, { recursive: true, force: true }) }
})

test('all five stages run in order and deliver a judged image', async () => {
  const env = setup([item('a'), item('b')])
  try {
    await withCache(env, async () => {
      const cfg = config(env)
      const args = (operation: string, extra: string[] = []) => [operation, '--stage', 's1', '--page', join(env.dir, 'page'), '--out', env.out, ...extra]
      assert.equal(await runEngineCaptureJob(cfg, args('check'), execution(env)), 0)
      assert.equal(await runEngineCaptureJob(cfg, args('clean'), execution(env)), 0)
      assert.equal(await runEngineCaptureJob(cfg, args('render'), execution(env)), 0)
      assert.equal(await runEngineCaptureJob(cfg, args('fresh'), execution(env)), 0)
      assert.equal(await runEngineCaptureJob(cfg, args('judge'), execution(env)), 0)
    })
    assert.deepEqual(env.runs, ['a', 'b'])
    assert.ok(existsSync(join(env.out, 'a-one.png')))
    assert.ok(existsSync(join(env.store, 'verdicts/a-one.png.json')))
    assert.equal(JSON.parse(readFileSync(join(env.store, 'verdicts/b-one.png.json'), 'utf8')).pass, true)
  } finally { rmSync(env.dir, { recursive: true, force: true }) }
})

test('a failing row keeps the successful rows and reports functional failure', async () => {
  const env = setup([item('a'), item('b')])
  try {
    await withCache(env, async () => {
      const args = (operation: string) => [operation, '--stage', 's1', '--page', join(env.dir, 'page'), '--out', env.out]
      assert.equal(await runEngineCaptureJob(config(env), args('check'), execution(env)), 0)
      assert.equal(await runEngineCaptureJob(config(env), args('clean'), execution(env)), 0)
      assert.equal(await runEngineCaptureJob(config(env, ['b']), args('render'), execution(env)), 1)
      const run = JSON.parse(readFileSync(join(env.out, 'run.json'), 'utf8'))
      assert.deepEqual(run.rendered, ['a'])
      assert.deepEqual(run.failed.map((failure: { id: string }) => failure.id), ['b'])
      assert.ok(existsSync(join(env.out, 'a-one.png')))
      assert.equal(existsSync(join(env.out, 'b-one.png')), false)
      assert.deepEqual(renderOrder([item('a'), item('b')] as unknown as InventoryRow[], ['b'], ['a']).map(row => row.id), ['b', 'a'])
    })
  } finally { rmSync(env.dir, { recursive: true, force: true }) }
})

test('current-build reuse skips rows whose image and job records are intact', async () => {
  const env = setup([item('a'), item('b')])
  try {
    await withCache(env, async () => {
      const args = (operation: string) => [operation, '--stage', 's1', '--page', join(env.dir, 'page'), '--out', env.out]
      await runEngineCaptureJob(config(env), args('check'), execution(env))
      await runEngineCaptureJob(config(env), args('clean'), execution(env))
      assert.equal(await runEngineCaptureJob(config(env), args('render'), execution(env)), 0)
      await runEngineCaptureJob(config(env), args('clean'), execution(env))
      env.runs.length = 0
      assert.equal(await runEngineCaptureJob(config(env), args('render'), execution(env)), 0)
      assert.deepEqual(env.runs, [])
      assert.equal(await runEngineCaptureJob(config(env), args('fresh'), execution(env)), 0)
    })
  } finally { rmSync(env.dir, { recursive: true, force: true }) }
})

test('a changed description renders only that row again', async () => {
  const env = setup([item('a'), item('b')])
  try {
    await withCache(env, async () => {
      const args = (operation: string) => [operation, '--stage', 's1', '--page', join(env.dir, 'page'), '--out', env.out]
      await runEngineCaptureJob(config(env), args('check'), execution(env))
      await runEngineCaptureJob(config(env), args('clean'), execution(env))
      await runEngineCaptureJob(config(env), args('render'), execution(env))
      writeInventory(env, [item('a', { description: 'Changed' }), item('b')])
      await runEngineCaptureJob(config(env), args('check'), execution(env))
      await runEngineCaptureJob(config(env), args('clean'), execution(env))
      env.runs.length = 0
      assert.equal(await runEngineCaptureJob(config(env), args('render'), execution(env)), 0)
      assert.deepEqual(env.runs, ['a'])
    })
  } finally { rmSync(env.dir, { recursive: true, force: true }) }
})

test('judge stores each verdict before a later failure and reuses passing verdicts', async () => {
  const env = setup([item('a'), item('b')])
  try {
    await withCache(env, async () => {
      const args = (operation: string, extra: string[] = []) => [operation, '--stage', 's1', '--page', join(env.dir, 'page'), '--out', env.out, ...extra]
      await runEngineCaptureJob(config(env), args('check'), execution(env))
      await runEngineCaptureJob(config(env), args('clean'), execution(env))
      await runEngineCaptureJob(config(env), args('render'), execution(env))
      const failing = execution(env, count => { if (count === 2) throw new Error('judge crashed'); return 'score: 7' })
      assert.equal(await runEngineCaptureJob(config(env), args('judge'), failing), 1)
      assert.ok(existsSync(join(env.store, 'verdicts/a-one.png.json')))
      assert.equal(existsSync(join(env.store, 'verdicts/b-one.png.json')), false)
      env.judged.length = 0
      assert.equal(await runEngineCaptureJob(config(env), args('judge'), execution(env)), 0)
      assert.equal(env.judged.length, 1)
    })
  } finally { rmSync(env.dir, { recursive: true, force: true }) }
})

test('judge budget exhaustion keeps the run incomplete and judges nothing', async () => {
  const env = setup([item('a')])
  try {
    await withCache(env, async () => {
      const args = (operation: string, extra: string[] = []) => [operation, '--stage', 's1', '--page', join(env.dir, 'page'), '--out', env.out, ...extra]
      await runEngineCaptureJob(config(env), args('check'), execution(env))
      await runEngineCaptureJob(config(env), args('clean'), execution(env))
      await runEngineCaptureJob(config(env), args('render'), execution(env))
      let now = 0
      const budgeted: CaptureExecution = { ...execution(env), clock: () => { now += 1000; return now } }
      assert.equal(await runEngineCaptureJob(config(env), args('judge', ['--budget-s', '0']), budgeted), 1)
      assert.equal(env.judged.length, 0)
    })
  } finally { rmSync(env.dir, { recursive: true, force: true }) }
})

test('changed held constants are handed to the judge and re-judged', async () => {
  const env = setup([item('a', { held_constant: ['the light'] })])
  try {
    await withCache(env, async () => {
      const args = (operation: string) => [operation, '--stage', 's1', '--page', join(env.dir, 'page'), '--out', env.out]
      await runEngineCaptureJob(config(env), args('check'), execution(env))
      await runEngineCaptureJob(config(env), args('clean'), execution(env))
      await runEngineCaptureJob(config(env), args('render'), execution(env))
      assert.equal(await runEngineCaptureJob(config(env), args('judge'), execution(env)), 0)
      assert.equal(await runEngineCaptureJob(config(env), args('judge'), execution(env)), 0)
      assert.deepEqual(env.judged.map(entry => entry.slice(2)), [['the light']])
      writeInventory(env, [item('a', { held_constant: ['the light', 'the ground'] })])
      await runEngineCaptureJob(config(env), args('check'), execution(env))
      await runEngineCaptureJob(config(env), args('clean'), execution(env))
      await runEngineCaptureJob(config(env), args('render'), execution(env))
      assert.equal(await runEngineCaptureJob(config(env), args('judge'), execution(env)), 0)
      assert.deepEqual(env.judged[1].slice(2), ['the light', 'the ground'])
    })
  } finally { rmSync(env.dir, { recursive: true, force: true }) }
})

test('fresh fails when a delivered image no longer matches its attempt', async () => {
  const env = setup([item('a')])
  try {
    await withCache(env, async () => {
      const args = (operation: string) => [operation, '--stage', 's1', '--page', join(env.dir, 'page'), '--out', env.out]
      await runEngineCaptureJob(config(env), args('check'), execution(env))
      await runEngineCaptureJob(config(env), args('clean'), execution(env))
      await runEngineCaptureJob(config(env), args('render'), execution(env))
      writeFileSync(join(env.out, 'a-one.png'), 'changed')
      assert.equal(await runEngineCaptureJob(config(env), args('fresh'), execution(env)), 1)
    })
  } finally { rmSync(env.dir, { recursive: true, force: true }) }
})

test('legacy judge forwarding stores verdicts under the verdicts folder per filename', async () => {
  const env = setup([])
  try {
    const delivery = join(env.dir, 'delivery')
    const attempt = join(env.dir, 'attempts/1')
    mkdirSync(delivery, { recursive: true })
    mkdirSync(attempt, { recursive: true })
    const row = { id: 'x', milestone: 'm2', filename: 'x-one.png', args: { seed: 1 }, require: [], description: 'X', held_constant: [] } as unknown as InventoryRow
    writeFileSync(join(delivery, 'x-one.png'), 'x')
    writeFileSync(join(attempt, 'x-one.png'), 'x')
    assert.equal(await judgeImages(env.dir, delivery, 1, [row], 10, async () => 'score: 6', () => 0), 0)
    assert.ok(existsSync(join(env.dir, 'verdicts/x-one.png.json')))
  } finally { rmSync(env.dir, { recursive: true, force: true }) }
})
