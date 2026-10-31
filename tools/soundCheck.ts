// Sound check: renders every catalog family entry and every music cue, analyses each render,
// and draws one labelled PNG per SoundGroup (SVG text label + spectrogram strip + waveform strip,
// rows composited vertically). Groups render in worker_threads, at most NMC_CPUS at a time.
//   node --experimental-strip-types tools/soundCheck.ts [outDir]   (default out/s3/m2)
import { mkdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads'
import sharp from 'sharp'
import { analyse, renderBank, spectrogram } from '@etcito/haa-spatial/bank'
import type { SoundStats, Spectrogram } from '@etcito/haa-spatial/bank'
import { renderArrangement } from '@etcito/haa-spatial/arranger'
import { loadModule } from '@etcito/haa-spatial/node'
import type { StereoRender } from '@etcito/haa-spatial/node'
import { SOUND_GROUPS } from '../packages/game/src/audio/catalog.ts'
import type { SoundGroup } from '../packages/game/src/audio/catalog.ts'
import { MOVEMENT_FAMILIES } from '../packages/game/src/audio/sounds/movement.ts'
import type { FamilyRender } from '../packages/game/src/audio/sounds/movement.ts'
import { WORLD_FAMILIES } from '../packages/game/src/audio/sounds/world.ts'
import { FLOW_FAMILIES } from '../packages/game/src/audio/sounds/flow.ts'
import { BED_FAMILIES, MUSIC_CUE_IDS, loadArrangement } from '../packages/game/src/audio/sounds/music.ts'

export const PICTURE_WIDTH = 1400
export const ROW_HEIGHT = 96

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const readText = (path: string): string => readFileSync(join(ROOT, path), 'utf8')

const LABEL_WIDTH = 340
const STRIP_GAP = 8
const SPECTRUM_LEFT = LABEL_WIDTH
const SPECTRUM_WIDTH = 592
const WAVE_LEFT = 940
const WAVE_WIDTH = PICTURE_WIDTH - WAVE_LEFT
const STRIP_TOP = 8
const STRIP_HEIGHT = 80
const FLOOR_DB = -90

export interface SoundCheckResult {
  problems: string[]
  groups: { group: SoundGroup; picture: string }[]
}

interface Row {
  id: string
  variant: number
  inputs: Record<string, number | string>
  render: StereoRender
  stats: SoundStats
}

interface GroupResult {
  group: SoundGroup
  picture: string
  problems: string[]
}

/** dB -90..0 to a dark-blue -> cyan -> yellow -> white ramp, as a 256-entry RGB lookup. */
const RAMP = ((): Uint8Array => {
  const stops: [number, number[]][] = [
    [0, [8, 10, 40]], [0.25, [20, 70, 150]], [0.5, [0, 170, 150]],
    [0.75, [230, 210, 50]], [1, [255, 255, 240]],
  ]
  const lut = new Uint8Array(256 * 3)
  for (let i = 0; i < 256; i++) {
    const t = i / 255
    let a = stops[0]
    let b = stops[stops.length - 1]
    for (let s = 0; s < stops.length - 1; s++) {
      if (t >= stops[s][0] && t <= stops[s + 1][0]) { a = stops[s]; b = stops[s + 1]; break }
    }
    const span = b[0] - a[0]
    const f = span === 0 ? 0 : (t - a[0]) / span
    for (let c = 0; c < 3; c++) lut[i * 3 + c] = Math.round(a[1][c] + (b[1][c] - a[1][c]) * f)
  }
  return lut
})()

/** Keep the spectrogram near 2400 frames so a minute-long cue still draws quickly. */
function hopFor(render: StereoRender): number {
  const target = Math.max(1, Math.ceil(render.left.length / 2400))
  let hop = 256
  while (hop < target) hop *= 2
  return hop
}

function drawSpectrogram(buf: Buffer, top: number, s: Spectrogram): void {
  for (let x = 0; x < SPECTRUM_WIDTH; x++) {
    const frame = Math.min(s.frames - 1, Math.floor(x * s.frames / SPECTRUM_WIDTH))
    const base = frame * s.bins
    for (let y = 0; y < STRIP_HEIGHT; y++) {
      const bin = s.bins - 1 - Math.min(s.bins - 1, Math.floor(y * s.bins / STRIP_HEIGHT))
      const db = s.db[base + bin]
      const level = Math.max(0, Math.min(255, Math.round((db - FLOOR_DB) / -FLOOR_DB * 255)))
      const p = ((top + y) * PICTURE_WIDTH + SPECTRUM_LEFT + x) * 4
      buf[p] = RAMP[level * 3]
      buf[p + 1] = RAMP[level * 3 + 1]
      buf[p + 2] = RAMP[level * 3 + 2]
      buf[p + 3] = 255
    }
  }
}

function drawWaveform(buf: Buffer, top: number, render: StereoRender): void {
  const frames = render.left.length
  const mid = top + STRIP_HEIGHT / 2
  for (let x = 0; x < WAVE_WIDTH; x++) {
    const start = Math.floor(x * frames / WAVE_WIDTH)
    const end = Math.min(frames, Math.max(start + 1, Math.floor((x + 1) * frames / WAVE_WIDTH)))
    let low = 0
    let high = 0
    for (let i = start; i < end; i++) {
      const left = render.left[i]
      const right = render.right[i]
      if (!Number.isFinite(left) || !Number.isFinite(right)) continue
      const mono = (left + right) / 2
      if (mono < low) low = mono
      if (mono > high) high = mono
    }
    const clamp = (v: number): number => Math.max(-1, Math.min(1, v))
    const yLow = Math.round(mid - clamp(low) * STRIP_HEIGHT / 2)
    const yHigh = Math.round(mid - clamp(high) * STRIP_HEIGHT / 2)
    for (let y = Math.min(yLow, yHigh); y <= Math.max(yLow, yHigh); y++) {
      const p = ((top + y) * PICTURE_WIDTH + WAVE_LEFT + x) * 4
      buf[p] = 120
      buf[p + 1] = 210
      buf[p + 2] = 255
      buf[p + 3] = 255
    }
  }
}

function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** One row per render, composited vertically into a single 1400 px wide PNG. */
async function drawPicture(file: string, rows: readonly Row[]): Promise<void> {
  const height = rows.length * ROW_HEIGHT
  const buf = Buffer.alloc(PICTURE_WIDTH * height * 4)
  const background = Buffer.alloc(PICTURE_WIDTH * 4)
  for (let x = 0; x < PICTURE_WIDTH; x++) {
    background[x * 4] = 12
    background[x * 4 + 1] = 12
    background[x * 4 + 2] = 20
    background[x * 4 + 3] = 255
  }
  for (let y = 0; y < height; y++) background.copy(buf, y * PICTURE_WIDTH * 4)

  const labels: string[] = [`<svg xmlns="http://www.w3.org/2000/svg" width="${PICTURE_WIDTH}" height="${height}">`]
  rows.forEach((row, index) => {
    const top = index * ROW_HEIGHT
    drawSpectrogram(buf, top, spectrogram(row.render, { hop: hopFor(row.render) }))
    drawWaveform(buf, top, row.render)
    const separator = (top + ROW_HEIGHT - 1) * PICTURE_WIDTH * 4
    for (let x = 0; x < PICTURE_WIDTH; x++) {
      buf[separator + x * 4] = 40
      buf[separator + x * 4 + 1] = 40
      buf[separator + x * 4 + 2] = 56
    }
    labels.push(
      `<text x="8" y="${top + 26}" font-family="monospace" font-size="14" fill="#f0f0f8">${escapeXml(row.id)} v${row.variant}</text>`,
      `<text x="8" y="${top + 48}" font-family="monospace" font-size="12" fill="#a8b0c8">inputs ${escapeXml(JSON.stringify(row.inputs))}</text>`,
      `<text x="8" y="${top + 70}" font-family="monospace" font-size="12" fill="#a8b0c8">peak ${row.stats.peakDbfs.toFixed(1)} dBFS</text>`,
    )
  })
  labels.push('</svg>')

  await sharp(buf, { raw: { width: PICTURE_WIDTH, height, channels: 4 } })
    .composite([{ input: Buffer.from(labels.join('')) }])
    .png()
    .toFile(file)
}

function renderFamily(module: WebAssembly.Module, family: FamilyRender): Row[] {
  const patch = readText(`audio/${family.id}.haa.json`)
  return renderBank(module, patch, family.entries).map((result, index) => {
    const entry = family.entries[index]
    return {
      id: family.id,
      variant: result.variant,
      inputs: entry.inputs ?? {},
      render: result.render,
      stats: analyse(result.render),
    }
  })
}

function familyList(group: SoundGroup): readonly FamilyRender[] {
  return group === 'movement' ? MOVEMENT_FAMILIES : group === 'world' ? WORLD_FAMILIES : FLOW_FAMILIES
}

function problemsOf(group: SoundGroup, rows: readonly Row[]): string[] {
  const problems: string[] = []
  for (const row of rows) {
    const reasons: string[] = []
    if (row.stats.nonFinite > 0) reasons.push(`nonFinite ${row.stats.nonFinite}`)
    if (row.stats.silent) reasons.push('silent')
    if (row.stats.clipped) reasons.push('clipped')
    if (reasons.length === 0) continue
    problems.push(`${group} ${row.id} v${row.variant} ${JSON.stringify(row.inputs)}: ${reasons.join(', ')}`)
  }
  return problems
}

async function renderGroup(group: SoundGroup, outDir: string): Promise<GroupResult> {
  const module = await loadModule()
  const rows: Row[] = []
  if (group === 'music') {
    for (const id of MUSIC_CUE_IDS) {
      const { arrangement, instruments } = loadArrangement(id, readText)
      const render = renderArrangement(module, arrangement, instruments)
      rows.push({ id, variant: 0, inputs: {}, render, stats: analyse(render) })
    }
    for (const family of BED_FAMILIES) rows.push(...renderFamily(module, family))
  } else {
    for (const family of familyList(group)) rows.push(...renderFamily(module, family))
  }
  const picture = join(outDir, `${group}.png`)
  await drawPicture(picture, rows)
  return { group, picture, problems: problemsOf(group, rows) }
}

function workerCount(): number {
  const raw = Number(process.env.NMC_CPUS)
  if (!Number.isFinite(raw) || raw < 1) return 1
  return Math.max(1, Math.floor(raw))
}

function runInWorker(group: SoundGroup, outDir: string): Promise<GroupResult> {
  return new Promise((done, fail) => {
    const worker = new Worker(new URL(import.meta.url), { workerData: { outDir, group } })
    let settled = false
    worker.once('message', (result: GroupResult) => {
      settled = true
      done(result)
      void worker.terminate()
    })
    worker.once('error', (error: Error) => {
      settled = true
      fail(error)
    })
    worker.once('exit', (code: number) => {
      if (settled) return
      settled = true
      fail(new Error(`soundCheck worker ${group} exited with code ${code}`))
    })
  })
}

/** Render every group (up to NMC_CPUS workers), draw its picture and collect the problem lines. */
export async function soundCheck(outDir: string): Promise<SoundCheckResult> {
  const dir = resolve(outDir)
  mkdirSync(dir, { recursive: true })
  const queue: SoundGroup[] = [...SOUND_GROUPS]
  const results: GroupResult[] = []
  const lanes = Array.from({ length: Math.min(workerCount(), queue.length) }, async () => {
    for (;;) {
      const group = queue.shift()
      if (group === undefined) return
      results.push(await runInWorker(group, dir))
    }
  })
  await Promise.all(lanes)
  results.sort((a, b) => SOUND_GROUPS.indexOf(a.group) - SOUND_GROUPS.indexOf(b.group))
  return {
    problems: results.flatMap(result => result.problems),
    groups: results.map(result => ({ group: result.group, picture: result.picture })),
  }
}

async function main(): Promise<void> {
  const outDir = resolve(process.argv[2] ?? join(ROOT, 'out/s3/m2'))
  const result = await soundCheck(outDir)
  for (const problem of result.problems) console.log(problem)
  for (const { group, picture } of result.groups) console.log(`${group}: ${picture}`)
  process.exitCode = result.problems.length > 0 ? 1 : 0
}

if (!isMainThread) {
  const data = workerData as { outDir: string; group: SoundGroup }
  parentPort?.postMessage(await renderGroup(data.group, data.outDir))
} else if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main()
}
