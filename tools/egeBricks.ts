import { spawnSync } from 'node:child_process'
import { accessSync, constants, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { repoRoot } from './bricks.ts'

// The staged engine bricks the round scripts and the compiler load (E1).
const BRICKS = [
  'dist/bricks/game-engine/wasm/ege.wasm',
  'dist/bricks/game-engine/dist/index.js',
  'dist/bricks/game-engine-compile/package.json',
  'dist/bricks/game-engine-compile/sdk.json',
  'dist/bricks/game-engine-compile/asc/entry.json',
]

// The engine checkout: the env override, else the sibling folder of this repository.
export function engineDir(): string {
  const override = process.env.RF_ENGINE_DIR
  if (override !== undefined && override !== '') return override
  return join(dirname(repoRoot()), 'etcito-game-engine')
}

export function engineBricksMissing(dir: string): string[] {
  return BRICKS.filter((path) => !existsSync(join(dir, path)))
}

function writable(dir: string): boolean {
  try {
    accessSync(dir, constants.W_OK)
    return true
  } catch {
    return false
  }
}

function runBuildScript(dir: string, script: string): number {
  const result = spawnSync('bash', [script], { cwd: dir, stdio: 'inherit' })
  return result.status ?? 1
}

export async function main(argv: string[]): Promise<number> {
  const [command] = argv
  if (command === 'where') {
    console.log(engineDir())
    return 0
  }
  if (command === 'build') {
    const dir = engineDir()
    if (writable(dir)) {
      for (const script of ['scripts/build-bricks.sh', 'scripts/build-compile-brick.sh']) {
        const status = runBuildScript(dir, script)
        if (status !== 0) {
          console.error(`ege-bricks: ${script} failed (exit ${status})`)
          return 1
        }
      }
      return 0
    }
    const missing = engineBricksMissing(dir)
    if (missing.length === 0) {
      console.log('ege-bricks: read-only engine, using its provided build')
      return 0
    }
    console.error(`ege-bricks: read-only engine at ${dir} lacks ${missing.join(', ')}`)
    return 1
  }
  console.error('usage: node --experimental-strip-types tools/egeBricks.ts where | build')
  return 2
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2))
