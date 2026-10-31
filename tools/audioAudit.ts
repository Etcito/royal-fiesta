// The M1 sound audit: render every existing Royal Fiesta sound to WAV and measure it.
// The v0.1 pack families and the crowd bed go through the HAA 0.1.1 offline API (the same
// createOfflineAudio call as packages/game/test/audio.test.ts); every audio/*.haa.json
// patch goes through HAA 0.2.0's renderBank. Run:
//   node --experimental-strip-types tools/audioAudit.ts [out/s3/m1/audit]
import { mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createOfflineAudio } from '@etcito/haa'
import { analyse, renderBank, type SoundStats } from '@etcito/haa-spatial/bank'
import { loadModule, writeWav } from '@etcito/haa-spatial/node'
import { FIESTA_MIX_ID } from '../packages/game/src/audio/ids.ts'
import { CROWD_BED, FIESTA_FAMILIES, registerRoyalFiesta } from '../packages/game/src/audio/pack/index.ts'
import { repoRoot } from './bricks.ts'

/** One rendered sound in the audit report. */
export interface AuditRow {
  id: string
  engine: 'haa-0.1' | 'haa-0.2'
  file: string
  stats: SoundStats
}

/** The 0.2 StereoRender shape shared by analyse and writeWav. */
interface AuditRender {
  left: Float32Array
  right: Float32Array
  sampleRate: number
  issues: []
}

/** The default output directory of the CLI (`npm`-relative to the repository root). */
export const DEFAULT_AUDIT_OUT = 'out/s3/m1/audit'
/** Render length of the crowd bed and of every 0.2 patch (s). */
const AUDIT_SECONDS = 2
/** Variants rendered for every 0.2 patch: 0, 1 and 2. */
const PATCH_VARIANTS = 3

/** Packs a render from either engine into the 0.2 StereoRender shape. */
function stereo(left: Float32Array, right: Float32Array, sampleRate: number): AuditRender {
  return { left, right, sampleRate, issues: [] }
}

/** Writes one WAV, prints its stats line and returns its row. */
function record(
  outDir: string,
  id: string,
  engine: AuditRow['engine'],
  render: AuditRender,
  log: (line: string) => void,
): AuditRow {
  const file = join(outDir, `${id}.wav`)
  writeWav(file, render)
  const stats = analyse(render)
  log(
    `${id}\t${engine}\tpeak ${stats.peakDbfs.toFixed(2)} dBFS\trms ${stats.rmsDbfs.toFixed(2)} dBFS` +
      `\tnonFinite ${stats.nonFinite}\tsilent ${stats.silent}\tclipped ${stats.clipped}`,
  )
  return { id, engine, file, stats }
}

/** Renders and measures every existing sound: the v0.1 pack and the v0.2 mechanism patches. */
export async function auditAudio(
  outDir: string,
  log: (line: string) => void = console.log,
): Promise<AuditRow[]> {
  mkdirSync(outDir, { recursive: true })
  registerRoyalFiesta()
  const rows: AuditRow[] = []

  for (const family of FIESTA_FAMILIES) {
    for (let variant = 0; variant < family.variants; variant++) {
      // A fresh scene per variant keeps the previous shot out of this take; the family
      // variants themselves are cached by the 0.1 engine after the first play.
      const audio = createOfflineAudio({ mix: FIESTA_MIX_ID, maxListeners: 1 })
      if (!audio.play(family.id, { variant })) {
        throw new Error(`[audio-audit] cannot play ${family.id} variant ${variant}`)
      }
      audio.advance(family.maxSeconds)
      const take = audio.take(family.id)
      rows.push(record(outDir, family.id, 'haa-0.1', stereo(take.left, take.right, take.sampleRate), log))
    }
  }

  const scene = createOfflineAudio({ mix: FIESTA_MIX_ID, maxListeners: 1 })
  if (!scene.startBed(CROWD_BED.id)) throw new Error(`[audio-audit] cannot start bed ${CROWD_BED.id}`)
  scene.advance(AUDIT_SECONDS)
  const bed = scene.take(CROWD_BED.id)
  rows.push(record(outDir, CROWD_BED.id, 'haa-0.1', stereo(bed.left, bed.right, bed.sampleRate), log))

  const module = await loadModule()
  const audioDir = join(repoRoot(), 'audio')
  const patches = readdirSync(audioDir).filter((name) => name.endsWith('.haa.json')).sort()
  for (const name of patches) {
    const text = readFileSync(join(audioDir, name), 'utf8')
    const entries = Array.from({ length: PATCH_VARIANTS }, (_, variant) => ({ variant, seconds: AUDIT_SECONDS }))
    for (const render of renderBank(module, text, entries)) {
      const { left, right, sampleRate } = render.render
      rows.push(record(outDir, render.id, 'haa-0.2', stereo(left, right, sampleRate), log))
    }
  }
  return rows
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const out = process.argv[2] ? resolve(process.argv[2]) : join(repoRoot(), DEFAULT_AUDIT_OUT)
  auditAudio(out).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
