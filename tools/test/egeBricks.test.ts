import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test, { afterEach } from 'node:test'
import { engineBricksMissing, main } from '../egeBricks.ts'

const BRICKS = [
  'dist/bricks/game-engine/wasm/ege.wasm',
  'dist/bricks/game-engine/dist/index.js',
  'dist/bricks/game-engine-compile/package.json',
  'dist/bricks/game-engine-compile/sdk.json',
  'dist/bricks/game-engine-compile/asc/entry.json',
]

const temps: string[] = []
const savedEngineDir = process.env.RF_ENGINE_DIR

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rf-ege-bricks-'))
  temps.push(dir)
  return dir
}

afterEach(() => {
  if (savedEngineDir === undefined) delete process.env.RF_ENGINE_DIR
  else process.env.RF_ENGINE_DIR = savedEngineDir
  while (temps.length > 0) rmSync(temps.pop() as string, { recursive: true, force: true })
})

test('engineBricksMissing lists every brick of an empty directory in order', () => {
  assert.deepEqual(engineBricksMissing(temp()), BRICKS)
})

test('engineBricksMissing is empty once the five bricks exist', () => {
  const dir = temp()
  for (const brick of BRICKS) {
    const file = join(dir, brick)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, '')
  }
  assert.deepEqual(engineBricksMissing(dir), [])
})

test('where prints the RF_ENGINE_DIR override', async () => {
  const dir = temp()
  process.env.RF_ENGINE_DIR = dir
  const lines: string[] = []
  const original = console.log
  console.log = (...args: unknown[]): void => {
    lines.push(args.map((value) => String(value)).join(' '))
  }
  try {
    assert.equal(await main(['where']), 0)
  } finally {
    console.log = original
  }
  assert.deepEqual(lines, [dir])
})
