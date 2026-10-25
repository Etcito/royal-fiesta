// Check the prerequisite cards before spending a build and a GPU job on the SDF tour.
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { RefusalError } from '../packages/sim/src/refusal.ts'

const root = new URL('../', import.meta.url)

async function main(): Promise<number> {
  const manifest = JSON.parse(readFileSync(new URL('apps/web/package.json', root), 'utf8')) as {
    dependencies?: Record<string, string>
  }
  const missing: string[] = []
  const pin = manifest.dependencies?.['@etcito/raa-sdfm']
  if (!pin?.startsWith('https://github.com/Etcito/raa/releases/download/') || !pin.endsWith('.tgz')) {
    missing.push('card 5122: pin a published @etcito/raa-sdfm release in apps/web/package.json')
  }
  for (const [card, path] of [
    ['5129', 'apps/web/src/sdf/sdfPort.ts'],
    ['5131', 'apps/web/src/content/providers/sdf.ts'],
  ]) {
    if (!existsSync(new URL(path, root))) missing.push(`card ${card}: supply ${path}`)
  }
  if (missing.length > 0) {
    throw new RefusalError('content', 'm17-sdf-match',
      `SDF prerequisites are missing; ${missing.join('; ')}; complete those cards in order and fix card 5212 before retrying the GPU tour (decision Q5)`)
  }
  if (process.env.RF_RAA_LOCAL === '1') {
    throw new RefusalError('bricks', 'm17-sdf-match', 'RF_RAA_LOCAL=1 is active; use the published release for this proof')
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
