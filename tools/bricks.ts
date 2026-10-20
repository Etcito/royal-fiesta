import { createRequire } from 'node:module'
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { refuse } from '../packages/sim/src/refusal.ts'

// The GameSaloon rollback bricks (@gamesaloon/rollback, @gamesaloon/rollback-rapier) are installed
// from their GitHub release tarballs like any dependency; nothing here locates them.
// RAA (@etcito/raa) is a release dependency of apps/web too. gamesaloon-public is the only brick
// still located by directory, and only the optional local-server test needs it.
export type BrickName = 'gamesaloon-public' | 'raa-assets-tools'

const names: BrickName[] = ['gamesaloon-public', 'raa-assets-tools']
const pathHere = dirname(fileURLToPath(import.meta.url))

export function repoRoot(): string {
  let dir = pathHere
  while (true) {
    const manifest = join(dir, 'package.json')
    if (existsSync(manifest)) {
      try {
        if (JSON.parse(readFileSync(manifest, 'utf8')).name === 'royal-fiesta') return realpathSync(dir)
      } catch {}
    }
    const parent = dirname(dir)
    if (parent === dir) refuse('bricks', manifest, 'could not find package.json named royal-fiesta; run this tool from the royal-fiesta repository')
    dir = parent
  }
}

// Directory of a local brick checkout. Lookup order: the env override, then a folder named after
// the brick next to this repository (RF_BRICKS_DIR overrides the parent folder).
export function brickDir(name: BrickName): string | null {
  const root = repoRoot()
  const override = name === 'gamesaloon-public' ? process.env.GAMESALOON_DIR : undefined
  const candidates = [
    ...(override ? [override] : []),
    ...(process.env.RF_BRICKS_DIR ? [join(process.env.RF_BRICKS_DIR, name)] : []),
    join(dirname(root), name),
  ]
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate) && lstatSync(candidate).isDirectory()) return realpathSync(candidate)
    } catch {}
  }
  refuse('bricks', name, `brick is missing; set ${name === 'gamesaloon-public' ? 'GAMESALOON_DIR' : 'RF_BRICKS_DIR'} or clone it next to this repository`)
}

export interface BrickCheck { ok: boolean; lines: string[] }

// Checks the installed GameSaloon packages: they resolve from the repository, and the Rapier WASM
// initialises. A failure names the install command that fixes it.
export async function checkBricks(): Promise<BrickCheck> {
  const lines: string[] = []
  const fail = (path: string, what: string, fix: string): void => { lines.push(`FAIL [bricks] ${path}: ${what}; ${fix}`) }
  const require = createRequire(join(repoRoot(), 'package.json'))
  const fix = 'run the install (npm install or kong rules + kong use) in the repository root'
  for (const pkg of ['@gamesaloon/rollback', '@gamesaloon/rollback-rapier', '@dimforge/rapier3d-deterministic-compat']) {
    try {
      lines.push(`PASS ${pkg} resolves to ${realpathSync(require.resolve(pkg))}`)
    } catch {
      fail(pkg, 'package does not resolve', fix)
    }
  }
  try {
    const rapier = await import('@gamesaloon/rollback-rapier')
    await rapier.initRapier()
    lines.push('PASS @gamesaloon/rollback-rapier initRapier()')
  } catch (error) {
    fail('@gamesaloon/rollback-rapier', `initRapier() failed: ${error instanceof Error ? error.message : String(error)}`, fix)
  }
  return { ok: lines.every((line) => line.startsWith('PASS ')), lines }
}

export async function main(argv: string[]): Promise<number> {
  const [command, name] = argv
  if (command === 'check') {
    const result = await checkBricks()
    for (const line of result.lines) console.log(line)
    return result.ok ? 0 : 1
  }
  if (command === 'where' && name && names.includes(name as BrickName)) {
    const dir = brickDir(name as BrickName)
    console.log(dir ?? 'not found')
    return dir === null ? 1 : 0
  }
  console.error('usage: npm run bricks -- check | where <gamesaloon-public|raa-assets-tools>')
  return 1
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (import.meta.url === entry) process.exitCode = await main(process.argv.slice(2))
