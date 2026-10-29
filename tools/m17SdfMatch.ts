// Check the prerequisite cards before spending a build and a GPU job on the SDF tour.
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { RefusalError } from '../packages/sim/src/refusal.ts'
import { raaBricks, raaSource, readPins } from './bricks.ts'

const root = new URL('../', import.meta.url)
const RAA_SDFM_DEPENDENCY = 'file:../../../raa/dist/bricks/raa-sdfm'

async function main(): Promise<number> {
  const manifest = JSON.parse(readFileSync(new URL('apps/web/package.json', root), 'utf8')) as {
    dependencies?: Record<string, string>
  }
  const missing: string[] = []
  const dependency = manifest.dependencies?.['@etcito/raa-sdfm']
  if (dependency !== RAA_SDFM_DEPENDENCY) {
    missing.push(`pinned local RAA: apps/web/package.json must declare "@etcito/raa-sdfm": "${RAA_SDFM_DEPENDENCY}", got ${JSON.stringify(dependency)}`)
  }
  const pin = readPins().RAA.commit
  const source = raaSource()
  if (source.kind === 'absent') {
    missing.push(`pinned local RAA: ${source.reason}`)
  } else {
    if (source.commit !== pin) {
      missing.push(`pinned local RAA: ${source.dir} is at ${source.commit ?? 'unknown'}, expected the pin ${pin}; check out the pinned commit or run npm run bricks -- fetch raa`)
    }
    const bricks = raaBricks(source.dir)
    if (bricks.commit === null) {
      missing.push(`pinned local RAA: ${bricks.manifest} is missing or records no commit; run npm run bricks -- fetch raa`)
    } else if (bricks.commit !== pin) {
      missing.push(`pinned local RAA: ${bricks.manifest} records commit ${bricks.commit}, expected the pin ${pin}; run npm run bricks -- fetch raa`)
    }
  }
  for (const [card, path] of [
    ['5129', 'apps/web/src/sdf/sdfPort.ts'],
    ['5131', 'apps/web/src/content/providers/sdf.ts'],
  ]) {
    if (!existsSync(new URL(path, root))) missing.push(`card ${card}: supply ${path}`)
  }
  if (missing.length > 0) {
    throw new RefusalError('content', 'm17-sdf-match',
      `SDF prerequisites are missing; ${missing.join('; ')}; complete those cards in order, run npm run bricks -- fetch raa and retry the GPU tour (decision Q5)`)
  }
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      '--experimental-strip-types', 'apps/headless/proofs/m17-sdf-runtime.ts', '--render',
    ], { cwd: fileURLToPath(root), stdio: 'inherit' })
    child.once('error', reject)
    child.once('close', code => resolve(code ?? 1))
  })
}

try {
  process.exitCode = await main()
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
