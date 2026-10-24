// UI tour record (M6): turns the GPU client's uiTour output into proofs/ui/screens.json.
// The evidence proof reads only this record; the PNGs stay in out/ui (never committed).
// Run: node --experimental-strip-types tools/uiTourRecord.ts out/ui
// The GPU card also runs it with --render: the command runner cannot pass publish's page_ref to the
// next command, so this tool publishes apps/web/dist and runs the op with the returned ref.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { decodePng, unwrapOp } from '../apps/headless/src/gpuRecord.ts'
import { SCREENS, type Screen } from '../packages/game/src/screens/nav.ts'
import { isRefusal, refuse } from '../packages/sim/src/refusal.ts'

const AREA = 'ui-tour'
const USAGE = 'usage: node --experimental-strip-types tools/uiTourRecord.ts [--render] <out dir>'
const RECORD = 'proofs/ui/screens.json'
const FORMAT = 'royal-fiesta.ui-screens'
const OUT_DIR = 'out/ui'

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

export interface AdapterFacts { vendor: string; architecture: string; description: string; software: boolean }
export interface KeyInput { kind: 'key'; key: string; [k: string]: unknown }
export interface ClickInput { kind: 'click'; x: number; y: number; target: string; [k: string]: unknown }
export type TourInput = KeyInput | ClickInput
export interface ScreenEntry {
  screen: Screen
  inputs: TourInput[]
  capture: string
  sha256: string
  width: number
  height: number
}
export interface ScreensRecord {
  format: typeof FORMAT
  version: 1
  renderer: 'raa'
  adapter: AdapterFacts
  screens: ScreenEntry[]
}

function fail(path: string, reason: string): never {
  refuse(AREA, path, reason)
}

function captureDir(raw: string): string {
  if (isAbsolute(raw)) fail('out', `${JSON.stringify(raw)} is an absolute path; pass the repository-relative ${OUT_DIR}`)
  const dir = raw.replaceAll('\\', '/').replace(/\/+$/, '')
  if (dir === '' || dir === '.' || dir === '..' || dir.startsWith('../') || dir.includes('/../')) {
    fail('out', `${JSON.stringify(raw)} is not a repository-relative directory; pass ${OUT_DIR}`)
  }
  return dir
}

function adapterFacts(out: Obj): AdapterFacts {
  const a = out.adapter
  if (!isObj(a)) fail('adapter', 'the op output has no adapter object; pass the unmodified uiTour result.json')
  const text = (k: string): string => {
    const v = a[k]
    if (typeof v !== 'string' || v.length === 0) fail(`adapter/${k}`, `${JSON.stringify(v)} is not a non-empty string; pass the unmodified uiTour result.json`)
    return v
  }
  // Chrome masks GPUAdapterInfo.description (an empty string) unless unsafe flags are set; vendor and
  // architecture still identify the adapter, so the description only has to be a string.
  if (typeof a.description !== 'string') fail('adapter/description', `${JSON.stringify(a.description)} is not a string; pass the unmodified uiTour result.json`)
  if (typeof a.software !== 'boolean') fail('adapter/software', `${JSON.stringify(a.software)} is not a boolean; pass the unmodified uiTour result.json`)
  return { vendor: text('vendor'), architecture: text('architecture'), description: a.description, software: a.software }
}

function parseInputs(raw: unknown, screen: string): TourInput[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    fail(`screen '${screen}'`, 'has no inputs; the tour must reach it with real keys or clicks')
  }
  return raw.map((input, i) => {
    const where = `screen '${screen}' input ${i}`
    if (!isObj(input)) fail(where, 'is not an event object; use {kind:"key",key} or {kind:"click",x,y,target}')
    if (input.kind === 'key') {
      if (typeof input.key !== 'string' || input.key.trim().length === 0) fail(where, 'is a key event without a key name')
      return input as KeyInput
    }
    if (input.kind === 'click') {
      if (!Number.isFinite(input.x) || !Number.isFinite(input.y)) fail(where, 'is a click without x/y in canvas px')
      if (typeof input.target !== 'string' || input.target.length === 0) fail(where, 'is a click without the target widget id')
      return input as ClickInput
    }
    fail(where, `has kind ${JSON.stringify(input.kind)}; use 'key' or 'click'`)
  })
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function decodeCapture(bytes: Uint8Array, width: number, height: number, screen: string, capture: string): { width: number; height: number } {
  try {
    const png = decodePng(bytes, width, height, capture)
    return { width: png.width, height: png.height }
  } catch (e) {
    if (!isRefusal(e)) throw e
    return fail(`screen '${screen}'`, e.reason)
  }
}

// The record only holds values we copy from the op: refuse a token or an absolute path in any of them.
function assertSafe(record: ScreensRecord): void {
  const token = process.env.NMC_GPU_TOKEN
  if (token !== undefined && token.length > 0 && JSON.stringify(record).includes(token)) {
    fail(RECORD, 'would contain the GPU token; refusing to write it')
  }
  const walk = (v: unknown): void => {
    if (typeof v === 'string') {
      if (/^\/(?!\/)/.test(v) || /^[A-Za-z]:[\\/]/.test(v)) fail(RECORD, `would contain the absolute path ${JSON.stringify(v)}; refusing to write it`)
      return
    }
    if (Array.isArray(v)) { v.forEach(walk); return }
    if (isObj(v)) Object.values(v).forEach(walk)
  }
  walk(record)
}

// Pure: the op output (or the client's {result: ...} wrapper) and the PNG bytes by screen id.
export function buildScreensRecord(raw: unknown, pngs: ReadonlyMap<string, Uint8Array>, outDir: string = OUT_DIR): ScreensRecord {
  const dir = captureDir(outDir)
  const { out } = unwrapOp({ file: 'result.json', json: raw }, 'captures')
  const adapter = adapterFacts(out)
  if (out.renderer !== 'raa') fail('renderer', `${JSON.stringify(out.renderer)} is not 'raa'; capture the tour on the RAA renderer`)
  const list = out.captures
  if (!Array.isArray(list) || list.length === 0) fail('captures', 'the op output has no captures; run the uiTour op')
  const byScreen = new Map<string, ScreenEntry>()
  list.forEach((c, i) => {
    if (!isObj(c)) fail(`captures/${i}`, 'is not an object; pass the unmodified uiTour result.json')
    const screen = c.screen
    if (typeof screen !== 'string' || !(SCREENS as readonly string[]).includes(screen)) {
      fail(`screen ${JSON.stringify(screen)}`, `is not a SCREENS id (${SCREENS.join(', ')}); the tour captured an unknown screen`)
    }
    if (byScreen.has(screen)) fail(`screen '${screen}'`, 'appears twice; the tour captures each screen once')
    if (c.file !== `${screen}.png`) fail(`screen '${screen}'`, `reports file ${JSON.stringify(c.file)}, not '${screen}.png'; the capture file is named after the screen`)
    const inputs = parseInputs(c.inputs, screen)
    if (!Number.isInteger(c.width) || (c.width as number) <= 0 || !Number.isInteger(c.height) || (c.height as number) <= 0) {
      fail(`screen '${screen}'`, `reports ${JSON.stringify(c.width)}x${JSON.stringify(c.height)}, not a positive pixel size`)
    }
    const capture = `${dir}/${screen}.png`
    const bytes = pngs.get(screen)
    if (bytes === undefined) fail(`screen '${screen}'`, `is missing its capture ${capture}; the tour must capture it`)
    const hash = sha256(bytes)
    if (typeof c.sha256 !== 'string' || c.sha256.toLowerCase() !== hash) {
      fail(`screen '${screen}'`, `PNG sha256 ${hash} does not match the tour's ${JSON.stringify(c.sha256)}; re-run the tour or drop the stale capture`)
    }
    const size = decodeCapture(bytes, c.width as number, c.height as number, screen, capture)
    byScreen.set(screen, { screen: screen as Screen, inputs, capture, sha256: hash, width: size.width, height: size.height })
  })
  const missing = SCREENS.filter(s => !byScreen.has(s))
  if (missing.length > 0) fail(`screen '${missing[0]}'`, `has no capture; the tour must reach and capture ${missing.join(', ')}`)
  const record: ScreensRecord = {
    format: FORMAT, version: 1, renderer: 'raa', adapter,
    screens: SCREENS.map(s => byScreen.get(s) as ScreenEntry),
  }
  assertSafe(record)
  return record
}

export function recordFromDir(outDir: string): ScreensRecord {
  const dir = captureDir(outDir)
  const resultFile = join(dir, 'result.json')
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(resultFile, 'utf8')) as unknown
  } catch (e) {
    return fail(resultFile, `cannot be read as JSON (${(e as Error).message}); run the uiTour op with -o ${dir}`)
  }
  const { out } = unwrapOp({ file: resultFile, json: raw }, 'captures')
  const captures = Array.isArray(out.captures) ? out.captures : []
  const pngs = new Map<string, Uint8Array>()
  for (const c of captures) {
    if (isObj(c) && typeof c.screen === 'string' && (SCREENS as readonly string[]).includes(c.screen)) {
      const file = join(dir, `${c.screen}.png`)
      if (existsSync(file)) pngs.set(c.screen, readFileSync(file))
    }
  }
  return buildScreensRecord(raw, pngs, dir)
}

function writeRecord(record: ScreensRecord): void {
  mkdirSync(dirname(RECORD), { recursive: true })
  writeFileSync(RECORD, JSON.stringify(record, null, 2) + '\n')
  for (const e of record.screens) console.log(`[ui-tour] ${e.screen} ${e.width}x${e.height} sha256=${e.sha256} inputs=${e.inputs.length}`)
}

// The GPU card's render step: publish the built dist, then run the op against that page.
async function renderTour(inputPath: string, outDir: string): Promise<void> {
  let input: unknown
  try {
    input = JSON.parse(readFileSync(inputPath, 'utf8')) as unknown
  } catch (e) {
    return fail(inputPath, `cannot be read as JSON (${(e as Error).message}); the uiTour input is {}`)
  }
  if (!isObj(input)) fail(inputPath, 'is not a JSON object; the uiTour input is {}')
  const { publishDist, renderOp } = await import('../apps/headless/src/gpuClient.ts')
  const ref = await publishDist('apps/web/dist')
  await renderOp('uiTour', input, captureDir(outDir), 'tour', ref)
}

export async function main(argv: string[]): Promise<number> {
  try {
    if (argv[0] === '--render') {
      if (argv.length !== 3) fail('argv', `expected --render <input.json> <out dir>; ${USAGE}`)
      await renderTour(argv[1], argv[2])
      return 0
    }
    if (argv.length !== 1) fail('argv', `expected one output directory; ${USAGE}`)
    writeRecord(recordFromDir(argv[0]))
    return 0
  } catch (e) {
    if (!isRefusal(e)) throw e
    console.error(e.message)
    return 1
  }
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (import.meta.url === entry) process.exitCode = await main(process.argv.slice(2))
