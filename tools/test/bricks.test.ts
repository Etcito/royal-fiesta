import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { brickDir, checkBricks, repoRoot } from '../bricks.ts'
import { RefusalError } from '../../packages/sim/src/refusal.ts'

test('repoRoot is the royal-fiesta package root', () => {
  const root = repoRoot()
  assert.equal(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).name, 'royal-fiesta')
})

test('brick overrides take precedence in the documented order', () => {
  const temp = mkdtempSync(join(tmpdir(), 'rf-bricks-'))
  const oldRf = process.env.RF_BRICKS_DIR
  const oldGamesaloon = process.env.GAMESALOON_DIR
  try {
    const envDir = join(temp, 'override')
    const rfDir = join(temp, 'rf', 'gamesaloon-public')
    mkdirSync(envDir, { recursive: true })
    mkdirSync(rfDir, { recursive: true })
    process.env.GAMESALOON_DIR = envDir
    process.env.RF_BRICKS_DIR = join(temp, 'rf')
    assert.equal(brickDir('gamesaloon-public'), realpathSync(envDir))
    delete process.env.GAMESALOON_DIR
    assert.equal(brickDir('gamesaloon-public'), realpathSync(rfDir))
  } finally {
    if (oldRf === undefined) delete process.env.RF_BRICKS_DIR
    else process.env.RF_BRICKS_DIR = oldRf
    if (oldGamesaloon === undefined) delete process.env.GAMESALOON_DIR
    else process.env.GAMESALOON_DIR = oldGamesaloon
    rmSync(temp, { recursive: true, force: true })
  }
})

test('a missing brick is refused with a useful message', () => {
  const oldRf = process.env.RF_BRICKS_DIR
  const empty = mkdtempSync(join(tmpdir(), 'rf-bricks-empty-'))
  try {
    process.env.RF_BRICKS_DIR = empty
    assert.throws(() => brickDir('missing-brick' as 'raa'), (error: unknown) =>
      error instanceof RefusalError && error.message.includes('missing-brick'),
    )
  } finally {
    if (oldRf === undefined) delete process.env.RF_BRICKS_DIR
    else process.env.RF_BRICKS_DIR = oldRf
    rmSync(empty, { recursive: true, force: true })
  }
})

test('checkBricks succeeds when the released GameSaloon packages are installed', async () => {
  const result = await checkBricks()
  assert.equal(result.ok, true, result.lines.join('\n'))
})
