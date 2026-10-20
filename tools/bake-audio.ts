// Bakes the Royal Fiesta sound pack to MP3 strips with HAA's public bake API, next to a manifest.json
// that the browser loads (createAudio manifestUrl). Output: apps/web/public/audio (gitignored), plus
// HAA's prebuilt worklet copied as haa-processors.js. Run by `npm run audio:bake` (and by web:build).
//   node --experimental-strip-types tools/bake-audio.ts [--out <dir>]
import { copyFileSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { bake } from '@etcito/haa/node'
import type { BankManifest } from '@etcito/haa'
import { registerRoyalFiesta, ROYAL_FIESTA_FAMILIES } from '../packages/game/src/audio/pack/index.ts'
import { repoRoot } from './bricks.ts'

export const DEFAULT_AUDIO_OUT = 'apps/web/public/audio'

/** Bakes every family of the Royal Fiesta pack into outDir and returns HAA's manifest. Deterministic. */
export function bakeAudio(outDir: string, log: (line: string) => void = console.log): BankManifest {
  registerRoyalFiesta()
  mkdirSync(outDir, { recursive: true })
  const manifest = bake(ROYAL_FIESTA_FAMILIES, { outDir, log })
  // The page passes this file as processorUrl; it is HAA's own prebuilt worklet bundle.
  const require = createRequire(join(repoRoot(), 'package.json'))
  copyFileSync(require.resolve('@etcito/haa/worklet'), join(outDir, 'haa-processors.js'))
  return manifest
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (import.meta.url === entry) {
  const flag = process.argv.indexOf('--out')
  const out = flag >= 0 && process.argv[flag + 1] ? resolve(process.argv[flag + 1]) : join(repoRoot(), DEFAULT_AUDIO_OUT)
  const started = Date.now()
  const manifest = bakeAudio(out)
  console.log(`baked ${manifest.families.length} families into ${out} in ${((Date.now() - started) / 1000).toFixed(1)} s`)
}
