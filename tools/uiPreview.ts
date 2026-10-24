// Previews every state of ui/<id>.ui.json through SDF Modeler and writes out/ui-preview/<id>.<state>.png.
// SDF Modeler is driven in process (like tools/renderViews.ts), so its ui_asset_preview runs in Node and returns
// the PNG bytes; the transparent render is alpha-composited onto ref-1's sky blue for the owner's review.
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { crc32, deflateSync, inflateSync } from 'node:zlib'
import { repoRoot } from './bricks.ts'

const USAGE = 'usage: node --experimental-strip-types tools/uiPreview.ts <id> [state...]'
const STATES = ['normal', 'hover', 'pressed', 'disabled', 'focus'] as const
export type UiState = (typeof STATES)[number]
export const SKY_BLUE = '#8fd3ff'
const SKY_BLUE_RGB: readonly [number, number, number] = [0x8f, 0xd3, 0xff]
export const SCALE = 4
export const OUT_DIR = 'out/ui-preview'
const UI_ID_RE = /^[a-z][a-z0-9]*(\.[a-z0-9-]+)+$/
const SDFM_NAMES = ['sdfm', 'SDF_Modeler_MCP']
// The nomorechat read-only peer is named <card>-ro-sdfm; its dependencies are built from the pinned siblings.
const SDFM_PEER_RE = /^.+-ro-sdfm$/
const SDFM_DEPS = ['MAMA', 'NodeGraph', 'TS_PieMenue']
// What the sdfm Node build needs; the rest of the checkout (fixtures, bench, out) is never read.
const SDFM_COPY = ['src', 'scripts', 'bin', 'package.json', 'tsconfig.node.json']
const SDFM_LINK = ['node_modules', 'vendor']
const BUILD_TIMEOUT_MS = 30 * 60_000
const LOCK_STALE_MS = 10 * 60_000

export interface PreviewArgs {
  id: string
  states: UiState[]
}

export interface RgbaImage {
  width: number
  height: number
  data: Uint8Array
}

export interface ToolResult {
  text: string
  data?: unknown
  images?: { name: string; png: Uint8Array }[]
}

export interface Sdfm {
  call(name: string, input?: unknown): Promise<ToolResult>
  close(): Promise<void>
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isState = (v: string): v is UiState => (STATES as readonly string[]).includes(v)
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** `<id> [state...]`; no state means every state of the file (resolveStates). Unknown states are refused here. */
export function parseArgs(argv: readonly string[]): PreviewArgs {
  const [id, ...rest] = argv
  if (id === undefined || id === '') throw new Error(`missing <id>; ${USAGE}`)
  if (id.startsWith('-')) throw new Error(`unknown option '${id}'; ${USAGE}`)
  if (!UI_ID_RE.test(id)) throw new Error(`invalid id '${id}': lowercase words joined by dots, like button.inflatable; ${USAGE}`)
  const states: UiState[] = []
  for (const state of rest) {
    if (!isState(state)) throw new Error(`unknown state '${state}': use ${STATES.join(', ')}; ${USAGE}`)
    if (!states.includes(state)) states.push(state)
  }
  return { id, states }
}

/** Every state in the file: the keys of render.states (normal first), else normal plus the states overrides. */
export function statesOf(file: unknown): UiState[] {
  const renderStates = isRecord(file) && isRecord(file.render) && isRecord(file.render.states) ? file.render.states : null
  const overrides = isRecord(file) && isRecord(file.states) ? file.states : null
  const keys = renderStates ? Object.keys(renderStates) : ['normal', ...(overrides ? Object.keys(overrides) : [])]
  const out: UiState[] = ['normal']
  for (const key of keys) if (isState(key) && !out.includes(key)) out.push(key)
  return out
}

export function resolveStates(file: unknown, requested: readonly UiState[]): UiState[] {
  return requested.length > 0 ? [...requested] : statesOf(file)
}

/** `button.inflatable` opens as artwork `button_inflatable` (dots and dashes become underscores). */
export function artworkId(id: string): string {
  return id.replace(/[.-]/g, '_')
}

export function previewPath(id: string, state: UiState): string {
  return `${OUT_DIR}/${id}.${state}.png`
}

export function previewFile(root: string, id: string, state: UiState): string {
  return resolve(root, previewPath(id, state))
}

/** The ui_asset_preview input; SDF Modeler only knows transparent and checker, so the sky is composited after. */
export function previewInput(id: string, state: UiState): Record<string, unknown> {
  return { id: artworkId(id), state, scale: SCALE, background: 'transparent' }
}

export function readUiAsset(root: string, id: string): unknown {
  const path = join(root, 'ui', `${id}.ui.json`)
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (e) {
    throw new Error(`ui/${id}.ui.json could not be read: ${message(e)}`)
  }
  try {
    return JSON.parse(text) as unknown
  } catch (e) {
    throw new Error(`ui/${id}.ui.json is not valid JSON: ${message(e)}`)
  }
}

const PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10]

function chunk(type: string, body: Uint8Array): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(body.length, 0)
  head.write(type, 4, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), Buffer.from(body)])), 0)
  return Buffer.concat([head, Buffer.from(body), crc])
}

/** 8-bit RGB/RGBA, non-interlaced PNG (SDF Modeler's preview encoder writes RGBA8 with any row filter). */
export function decodePng(bytes: Uint8Array): RgbaImage {
  if (bytes.length < 8 || PNG_SIG.some((b, i) => bytes[i] !== b)) throw new Error('sdfm returned something that is not a PNG')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let pos = 8
  let ihdr: Uint8Array | null = null
  const idat: Buffer[] = []
  while (pos + 8 <= bytes.length) {
    const len = view.getUint32(pos)
    if (pos + 12 + len > bytes.length) throw new Error('sdfm returned a truncated PNG')
    const type = Buffer.from(bytes.subarray(pos + 4, pos + 8)).toString('latin1')
    const body = bytes.subarray(pos + 8, pos + 8 + len)
    if (type === 'IHDR') ihdr = body
    else if (type === 'IDAT') idat.push(Buffer.from(body))
    else if (type === 'IEND') break
    pos += 12 + len
  }
  if (ihdr === null || ihdr.length !== 13) throw new Error('sdfm returned a PNG without IHDR')
  const head = new DataView(ihdr.buffer, ihdr.byteOffset, ihdr.byteLength)
  const width = head.getUint32(0)
  const height = head.getUint32(4)
  const depth = ihdr[8]
  const color = ihdr[9]
  const interlace = ihdr[12]
  if (depth !== 8 || (color !== 2 && color !== 6) || interlace !== 0) {
    throw new Error(`sdfm returned an unsupported PNG (depth ${depth}, colour ${color}, interlace ${interlace})`)
  }
  if (idat.length === 0) throw new Error('sdfm returned a PNG without IDAT')
  const raw = inflateSync(Buffer.concat(idat))
  const channels = color === 6 ? 4 : 3
  const stride = width * channels
  if (raw.length !== height * (stride + 1)) throw new Error('sdfm returned a PNG with a wrong IDAT length')
  const pixels = new Uint8Array(height * stride)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!
    const src = y * (stride + 1) + 1
    const row = y * stride
    const prev = row - stride
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? pixels[row + x - channels]! : 0
      const b = y > 0 ? pixels[prev + x]! : 0
      const c = x >= channels && y > 0 ? pixels[prev + x - channels]! : 0
      let p: number
      if (filter === 0) p = 0
      else if (filter === 1) p = a
      else if (filter === 2) p = b
      else if (filter === 3) p = (a + b) >> 1
      else if (filter === 4) {
        const pa = Math.abs(b - c)
        const pb = Math.abs(a - c)
        const pc = Math.abs(a + b - 2 * c)
        p = pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      } else throw new Error(`sdfm returned a PNG with unknown filter ${filter}`)
      pixels[row + x] = (raw[src + x]! + p) & 255
    }
  }
  if (channels === 4) return { width, height, data: pixels }
  const data = new Uint8Array(width * height * 4)
  for (let i = 0, j = 0; i < pixels.length; i += 3, j += 4) {
    data[j] = pixels[i]!
    data[j + 1] = pixels[i + 1]!
    data[j + 2] = pixels[i + 2]!
    data[j + 3] = 255
  }
  return { width, height, data }
}

export function encodePng(img: RgbaImage): Uint8Array {
  const raw = Buffer.alloc((img.width * 4 + 1) * img.height)
  for (let y = 0; y < img.height; y++) {
    Buffer.from(img.data.subarray(y * img.width * 4, (y + 1) * img.width * 4)).copy(raw, y * (img.width * 4 + 1) + 1)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(img.width, 0)
  ihdr.writeUInt32BE(img.height, 4)
  ihdr.set([8, 6, 0, 0, 0], 8)
  return new Uint8Array(Buffer.concat([
    Buffer.from(PNG_SIG),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', new Uint8Array(0)),
  ]))
}

const toLinear = (v: number): number => {
  const c = v / 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}
const toSrgb = (v: number): number => {
  const c = v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055
  return Math.round(Math.min(1, Math.max(0, c)) * 255)
}

/** Alpha-composites the transparent preview onto ref-1's sky blue, in linear light like SDF Modeler's checker. */
export function compositeOnSkyBlue(img: RgbaImage): RgbaImage {
  const bg = SKY_BLUE_RGB.map(toLinear) as [number, number, number]
  const out = new Uint8Array(img.data.length)
  for (let i = 0; i < img.data.length; i += 4) {
    const alpha = img.data[i + 3]!
    if (alpha === 255) {
      out.set(img.data.subarray(i, i + 4), i)
      continue
    }
    if (alpha === 0) {
      out[i] = SKY_BLUE_RGB[0]
      out[i + 1] = SKY_BLUE_RGB[1]
      out[i + 2] = SKY_BLUE_RGB[2]
      out[i + 3] = 255
      continue
    }
    const t = alpha / 255
    for (let c = 0; c < 3; c++) out[i + c] = toSrgb(toLinear(img.data[i + c]!) * t + bg[c]! * (1 - t))
    out[i + 3] = 255
  }
  return { width: img.width, height: img.height, data: out }
}

// SDFM_DIR, then $RF_BRICKS_DIR, then a sibling named sdfm or SDF_Modeler_MCP, then the read-only peer.
export function sdfmDir(root: string): string {
  const parent = dirname(root)
  const peers: string[] = []
  try {
    for (const name of readdirSync(parent)) if (SDFM_PEER_RE.test(name)) peers.push(join(parent, name))
  } catch {}
  const bricks = process.env.RF_BRICKS_DIR
  const tries = [
    ...(process.env.SDFM_DIR ? [process.env.SDFM_DIR] : []),
    ...(bricks ? SDFM_NAMES.map((name) => join(bricks, name)) : []),
    ...SDFM_NAMES.map((name) => join(parent, name)),
    ...peers.sort(),
  ]
  const hit = [...new Set(tries)].find((dir) => existsSync(join(dir, 'bin', 'sdfm.mjs')))
  if (hit === undefined) throw new Error(`no SDF Modeler checkout (tried ${tries.join(', ')}); set SDFM_DIR to a checkout with node_modules`)
  return hit
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))

// The sibling checkout is read-only, so its Node side is compiled in a temp copy keyed by its commit.
// A checkout without node_modules (the read-only peer) gets `npm ci` in the temp copy, which links
// the file: siblings; the checkout itself is never written. Builds share the copy, so a lock keeps
// parallel previews from installing and compiling over each other.
async function sdfmApi(src: string): Promise<{ createSdfm(): Promise<Sdfm> }> {
  let head = 'local'
  try { head = execFileSync('git', ['-C', src, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() } catch {}
  const dir = join(tmpdir(), `rf-ui-preview-sdfm-${head.slice(0, 12)}`)
  const build = join(dir, 'sdfm')
  const api = join(build, 'build-node/node/api.js')
  if (!existsSync(join(dir, 'build.done'))) await buildSdfm(src, dir, build, head)
  return import(pathToFileURL(api).href) as Promise<{ createSdfm(): Promise<Sdfm> }>
}

async function buildSdfm(src: string, dir: string, build: string, head: string): Promise<void> {
  const done = join(dir, 'build.done')
  const lock = join(dir, 'build.lock')
  const deadline = Date.now() + BUILD_TIMEOUT_MS
  mkdirSync(dir, { recursive: true })
  for (;;) {
    try {
      mkdirSync(lock)
      break
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) {
          rmSync(lock, { recursive: true, force: true })
          continue
        }
      } catch {}
      if (Date.now() > deadline) throw new Error(`SDF Modeler build lock ${lock} is stuck; remove it and retry`)
      await sleep(500)
    }
  }
  try {
    if (existsSync(done)) return
    rmSync(build, { recursive: true, force: true })
    for (const p of SDFM_COPY) cpSync(join(src, p), join(build, p), { recursive: true })
    if (existsSync(join(src, 'node_modules'))) {
      for (const p of SDFM_LINK) if (!existsSync(join(build, p)) && existsSync(join(src, p))) symlinkSync(join(src, p), join(build, p))
    } else {
      for (const name of SDFM_DEPS) {
        const sibling = join(dirname(src), name)
        if (!existsSync(sibling)) throw new Error(`SDF Modeler checkout ${src} has no node_modules and no ${name} sibling at ${sibling}`)
        if (!existsSync(join(dir, name))) symlinkSync(sibling, join(dir, name))
      }
      cpSync(join(src, 'package-lock.json'), join(build, 'package-lock.json'))
      cpSync(join(src, 'vendor'), join(build, 'vendor'), { recursive: true })
      console.log(`[uiPreview] installing SDF Modeler ${head.slice(0, 12)} dependencies in ${dir}`)
      execFileSync('npm', ['ci', '--no-audit', '--no-fund', '--ignore-scripts'], { cwd: build, stdio: 'inherit' })
    }
    console.log(`[uiPreview] compiling SDF Modeler ${head.slice(0, 12)} in ${build}`)
    const proof = await import(pathToFileURL(join(build, 'scripts/lib/proof.mjs')).href) as { compileNode(): void }
    proof.compileNode()
    writeFileSync(done, head)
  } finally {
    rmSync(lock, { recursive: true, force: true })
  }
}

/** One empty SDF Modeler session per run; an empty NMC_GPU_URL makes it render in Node. */
export async function startSdfm(root: string): Promise<Sdfm> {
  process.env.NMC_GPU_URL = ''
  const { createSdfm } = await sdfmApi(sdfmDir(root))
  return createSdfm()
}

async function openAsset(sdfm: Sdfm, id: string): Promise<void> {
  try {
    await sdfm.call('ui_asset_open', { path: `ui/${id}.ui.json`, replace: true })
  } catch (e) {
    throw new Error(`${id}: ui_asset_open: ${message(e)}`)
  }
}

async function renderState(sdfm: Sdfm, id: string, state: UiState): Promise<Uint8Array> {
  let result: ToolResult
  try {
    result = await sdfm.call('ui_asset_preview', previewInput(id, state))
  } catch (e) {
    throw new Error(`${id} ${state}: ui_asset_preview: ${message(e)}`)
  }
  const png = result.images?.[0]?.png
  if (png === undefined) throw new Error(`${id} ${state}: ui_asset_preview returned no image`)
  return png
}

export async function main(argv: readonly string[]): Promise<number> {
  let args: PreviewArgs
  try {
    args = parseArgs(argv)
  } catch (e) {
    console.error(`uiPreview: ${message(e)}`)
    return 1
  }
  try {
    const root = repoRoot()
    const file = readUiAsset(root, args.id)
    const states = resolveStates(file, args.states)
    const sdfm = await startSdfm(root)
    try {
      await openAsset(sdfm, args.id)
      for (const state of states) {
        const png = await renderState(sdfm, args.id, state)
        const path = previewFile(root, args.id, state)
        mkdirSync(dirname(path), { recursive: true })
        writeFileSync(path, encodePng(compositeOnSkyBlue(decodePng(png))))
        console.log(previewPath(args.id, state))
      }
    } finally {
      await sdfm.close()
    }
    return 0
  } catch (e) {
    console.error(`uiPreview: ${message(e)}`)
    return 1
  }
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (import.meta.url === entry) process.exitCode = await main(process.argv.slice(2))
