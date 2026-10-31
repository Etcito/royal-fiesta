// Render every audio/*.haa.json patch through HAA 0.2.0 and measure the WAV output.
// Run: node --experimental-strip-types tools/audioAudit.ts [out/s3/m1/audit]
import { mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { analyse, renderBank, type SoundStats } from '@etcito/haa-spatial/bank'
import { loadModule, writeWav } from '@etcito/haa-spatial/node'
import { repoRoot } from './bricks.ts'

/** One rendered sound in the audit report. */
export interface AuditRow {
  id: string
  engine: 'haa-0.2'
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
/** Render length of every 0.2 patch (s). */
const AUDIT_SECONDS = 2
/** Variants rendered for every 0.2 patch: 0, 1 and 2. */
const PATCH_VARIANTS = 3

/** Packs a patch render into the 0.2 StereoRender shape. */
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

/** Renders and measures every HAA 0.2.0 patch. */
export async function auditAudio(
  outDir: string,
  log: (line: string) => void = console.log,
): Promise<AuditRow[]> {
  mkdirSync(outDir, { recursive: true })
  const rows: AuditRow[] = []

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
