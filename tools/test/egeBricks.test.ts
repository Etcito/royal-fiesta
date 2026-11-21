import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test, { afterEach } from 'node:test'
import { engineBricksMissing, main } from '../egeBricks.ts'

const CORE_BRICKS = [
  'dist/bricks/game-engine/package.json',
  'dist/bricks/game-engine/wasm/ege.wasm',
  'dist/bricks/game-engine/dist/index.js',
]
const COMPILE_BRICKS = [
  'dist/bricks/game-engine-compile/package.json',
  'dist/bricks/game-engine-compile/dist/index.js',
  'dist/bricks/game-engine-compile/sdk.json',
  'dist/bricks/game-engine-compile/asc/entry.json',
]
const BRICKS = [...CORE_BRICKS, ...COMPILE_BRICKS]

const temps: string[] = []
const savedEngineDir = process.env.RF_ENGINE_DIR

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rf-ege-bricks-'))
  temps.push(dir)
  return dir
}

function provide(dir: string, bricks: readonly string[]): void {
  for (const brick of bricks) {
    const file = join(dir, brick)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, '')
  }
}

function engineWithScripts(dir: string): void {
  for (const [script, marker] of [['build-bricks.sh', 'core.marker'], ['build-compile-brick.sh', 'compile.marker']]) {
    const file = join(dir, 'scripts', script)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `#!/usr/bin/env bash\nset -e\ntouch ${marker}\n`)
    chmodSync(file, 0o755)
  }
}

afterEach(() => {
  if (savedEngineDir === undefined) delete process.env.RF_ENGINE_DIR
  else process.env.RF_ENGINE_DIR = savedEngineDir
  while (temps.length > 0) rmSync(temps.pop() as string, { recursive: true, force: true })
})

test('engineBricksMissing lists every brick of an empty directory in order', () => {
  assert.deepEqual(engineBricksMissing(temp()), BRICKS)
})

test('engineBricksMissing is empty once the seven bricks exist', () => {
  const dir = temp()
  provide(dir, BRICKS)
  assert.deepEqual(engineBricksMissing(dir), [])
})

test('engineBricksMissing scopes to the core or compile brick when asked', () => {
  const dir = temp()
  provide(dir, CORE_BRICKS)
  assert.deepEqual(engineBricksMissing(dir, 'core'), [])
  assert.deepEqual(engineBricksMissing(dir, 'compile'), COMPILE_BRICKS)
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

test('build core and build compile run only their own brick script', async () => {
  const dir = temp()
  process.env.RF_ENGINE_DIR = dir
  engineWithScripts(dir)
  assert.equal(await main(['build', 'core']), 0)
  assert.equal(existsSync(join(dir, 'core.marker')), true)
  assert.equal(existsSync(join(dir, 'compile.marker')), false)
  assert.equal(await main(['build', 'compile']), 0)
  assert.equal(existsSync(join(dir, 'compile.marker')), true)
})

test('a read-only engine consumes its provided bricks instead of building', { skip: (process.getuid?.() ?? 1) === 0 }, async () => {
  const dir = temp()
  process.env.RF_ENGINE_DIR = dir
  provide(dir, BRICKS)
  chmodSync(dir, 0o555)
  try {
    assert.equal(await main(['build']), 0)
    assert.equal(await main(['build', 'compile']), 0)
  } finally {
    chmodSync(dir, 0o755)
  }
})
