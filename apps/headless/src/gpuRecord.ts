// Turns GPU-client op results into the committed proofs/mN/captures.json record (shared S10).
// Every field comes from the op output; nothing is defaulted or invented.
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { inflateSync } from 'node:zlib'
import { isRefusal, refuse } from '@royal-fiesta/sim/refusal'

const AREA = 'gpu-record'
const SIG = [137, 80, 78, 71, 13, 10, 26, 10]

export interface DecodedPng { width: number; height: number; channels: number; data: Uint8Array }
export interface CaptureEntry { name: string; width: number; height: number; sha256: string; bytes: number; nonEmpty: boolean }
export interface CapturesRecord {
  renderer: string; adapter: string; software: boolean; pageRef: string
  captures: CaptureEntry[]
  frameTiming: { width: number; height: number; frames: number; p50Ms: number; p95Ms: number } | null
}
export interface OpResult { file: string; json: unknown }

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null

export function decodePng(buf: Uint8Array, width: number, height: number, where: string): DecodedPng {
  const fail = (what: string): never => refuse(AREA, where, `${what}; re-run the GPU op and pass its unmodified result file`)
  if (buf.length < 8 || SIG.some((b, i) => buf[i] !== b)) fail('not a PNG (bad signature)')
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  let pos = 8
  let ihdr: Uint8Array | null = null
  const idat: Uint8Array[] = []
  while (pos + 8 <= buf.length) {
    const len = dv.getUint32(pos)
    const type = String.fromCharCode(...buf.subarray(pos + 4, pos + 8))
    if (pos + 12 + len > buf.length) fail(`truncated ${type} chunk`)
    const body = buf.subarray(pos + 8, pos + 8 + len)
    if (type === 'IHDR') ihdr = body
    else if (type === 'IDAT') idat.push(body)
    else if (type === 'IEND') break
    pos += 12 + len
  }
  if (ihdr === null || ihdr.length !== 13) return fail('missing IHDR')
  const h = new DataView(ihdr.buffer, ihdr.byteOffset, 13)
  const w = h.getUint32(0)
  const hh = h.getUint32(4)
  if (w !== width || hh !== height) fail(`IHDR is ${w}x${hh} but the capture declares ${width}x${height}`)
  const [depth, color, , , interlace] = ihdr.subarray(8)
  if (depth !== 8 || (color !== 2 && color !== 6) || interlace !== 0) {
    fail(`unsupported PNG (bit depth ${depth}, colour type ${color}, interlace ${interlace}); expected 8-bit RGB/RGBA non-interlaced`)
  }
  if (idat.length === 0) fail('no IDAT chunk')
  let raw: Uint8Array
  try { raw = inflateSync(Buffer.concat(idat)) } catch (e) { return fail(`IDAT does not inflate (${(e as Error).message})`) }
  const ch = color === 6 ? 4 : 3
  const stride = w * ch
  if (raw.length !== hh * (stride + 1)) fail(`inflated IDAT is ${raw.length} bytes, expected ${hh * (stride + 1)}`)
  const data = new Uint8Array(hh * stride)
  for (let y = 0; y < hh; y++) {
    const ft = raw[y * (stride + 1)]
    const src = y * (stride + 1) + 1
    const row = y * stride
    const prev = row - stride
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? data[row + x - ch] : 0
      const b = y > 0 ? data[prev + x] : 0
      const c = x >= ch && y > 0 ? data[prev + x - ch] : 0
      let p: number
      if (ft === 0) p = 0
      else if (ft === 1) p = a
      else if (ft === 2) p = b
      else if (ft === 3) p = (a + b) >> 1
      else if (ft === 4) {
        const pa = Math.abs(b - c)
        const pb = Math.abs(a - c)
        const pc = Math.abs(a + b - 2 * c)
        p = pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      } else return fail(`row ${y} has unknown filter type ${ft}`)
      data[row + x] = (raw[src + x] + p) & 255
    }
  }
  return { width: w, height: hh, channels: ch, data }
}

// The HUD is drawn top-left, so only the bottom half of each 2x2 quadrant counts.
export function pngNonEmpty(png: DecodedPng): boolean {
  const { width, height, channels, data } = png
  const hw = Math.floor(width / 2)
  const hh = Math.floor(height / 2)
  for (let q = 0; q < 4; q++) {
    const x0 = (q % 2) * hw
    const y0 = Math.floor(q / 2) * hh
    let first = -1
    let varied = false
    for (let y = y0 + Math.floor(hh / 2); y < y0 + hh && !varied; y++) {
      for (let x = x0; x < x0 + hw; x++) {
        const i = (y * width + x) * channels
        const rgb = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2]
        if (first < 0) first = rgb
        else if (rgb !== first) { varied = true; break }
      }
    }
    if (!varied) return false
  }
  return true
}

// The op output is the top-level object or the single nested object (<= 3 levels) holding `key`.
export function unwrapOp(res: OpResult, key: string): { out: Obj; path: string } {
  if (isObj(res.json) && !Array.isArray(res.json) && key in res.json) return { out: res.json, path: '#' }
  const found: { out: Obj; path: string }[] = []
  const walk = (v: unknown, path: string, depth: number): void => {
    if (!isObj(v) || depth > 3) return
    if (depth > 0 && !Array.isArray(v) && key in v) found.push({ out: v, path })
    for (const k of Object.keys(v)) walk((v as Obj)[k], `${path}/${k}`, depth + 1)
  }
  walk(res.json, '#', 0)
  if (found.length !== 1) {
    const what = found.length === 0 ? `no object with "${key}"` : `${found.length} objects with "${key}" (${found.map(f => f.path).join(', ')})`
    refuse(AREA, `${res.file}#`, `${what} within 3 levels; pass the GPU client result file of exactly one op`)
  }
  return found[0]
}

function need<T>(ok: (v: unknown) => v is T, o: Obj, k: string, where: string, expect: string): T {
  const v = o[k]
  if (!ok(v)) refuse(AREA, `${where}/${k}`, `${JSON.stringify(v)} is not ${expect}; pass the unmodified op output`)
  return v as T
}
const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0
const isPosInt = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isBool = (v: unknown): v is boolean => typeof v === 'boolean'

function adapterOf(out: Obj, where: string): { label: string; software: boolean } {
  const a = need(isObj, out, 'adapter', where, 'an adapter object')
  const p = `${where}/adapter`
  const s = (k: string): string => need((v): v is string => typeof v === 'string', a, k, p, 'a string')
  return { label: `${s('vendor')} | ${s('architecture')} | ${s('description')}`, software: need(isBool, a, 'software', p, 'a boolean') }
}

export function buildCapturesRecord(caps: OpResult, timing: OpResult | null, pageRef: string): { record: CapturesRecord; pngs: { name: string; bytes: Buffer }[] } {
  const { out, path } = unwrapOp(caps, 'captures')
  const where = `${caps.file}${path}`
  if (out.renderer !== 'raa') refuse(AREA, `${where}/renderer`, `${JSON.stringify(out.renderer)} is not 'raa'; record only captures rendered by the RAA port`)
  const adapter = adapterOf(out, where)
  const list = need((v): v is unknown[] => Array.isArray(v) && v.length > 0, out, 'captures', where, 'a non-empty array')
  const pngs: { name: string; bytes: Buffer }[] = []
  const captures = list.map((c, i): CaptureEntry => {
    const cw = `${where}/captures/${i}`
    if (!isObj(c)) return refuse(AREA, cw, 'not an object; pass the unmodified op output')
    const name = need((v): v is string => typeof v === 'string' && /^[A-Za-z0-9._-]{1,80}$/.test(v), c, 'name', cw, 'a file-safe name')
    const width = need(isPosInt, c, 'width', cw, 'a positive integer')
    const height = need(isPosInt, c, 'height', cw, 'a positive integer')
    need((v): v is string => v === 'image/png', c, 'mime', cw, "'image/png'")
    const b64 = need(isStr, c, 'base64', cw, 'a base64 string')
    const bytes = Buffer.from(b64, 'base64')
    if (pngs.some(p => p.name === name)) refuse(AREA, `${cw}/name`, `duplicate capture name ${name}; each capture needs its own name`)
    pngs.push({ name, bytes })
    const nonEmpty = pngNonEmpty(decodePng(bytes, width, height, `${cw}/base64`))
    return { name, width, height, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, nonEmpty }
  })
  let software = adapter.software
  let frameTiming: CapturesRecord['frameTiming'] = null
  if (timing !== null) {
    const t = unwrapOp(timing, 'p50Ms')
    const tw = `${timing.file}${t.path}`
    software = software || adapterOf(t.out, tw).software
    frameTiming = {
      width: 1920, height: 1080,
      frames: need(isPosInt, t.out, 'frames', tw, 'a positive integer'),
      p50Ms: need(isNum, t.out, 'p50Ms', tw, 'a finite number'),
      p95Ms: need(isNum, t.out, 'p95Ms', tw, 'a finite number'),
    }
  }
  return { record: { renderer: 'raa', adapter: adapter.label, software, pageRef, captures, frameTiming }, pngs }
}

function readJson(file: string): OpResult {
  let text: string
  try { text = readFileSync(file, 'utf8') } catch { return refuse(AREA, file, 'cannot read the file; pass the path of the GPU client result JSON') }
  try { return { file, json: JSON.parse(text) as unknown } } catch (e) { return refuse(AREA, `${file}#`, `invalid JSON (${(e as Error).message}); pass the unmodified result file`) }
}

const USAGE = 'usage: gpuRecord.ts --out <proofs/mN/captures.json> --png-dir <out/mN> --page-ref <REF> --captures <result.json> [--timing <result.json>]'

export function main(argv: string[]): number {
  try {
    const opts = new Map<string, string>()
    for (let i = 0; i < argv.length; i += 2) {
      const k = argv[i]
      const v = argv[i + 1]
      if (!['--out', '--png-dir', '--page-ref', '--captures', '--timing'].includes(k) || v === undefined || opts.has(k)) refuse(AREA, `argv/${i}`, `unexpected ${JSON.stringify(k)}; ${USAGE}`)
      opts.set(k, v)
    }
    const req = (k: string): string => opts.get(k) ?? refuse(AREA, `argv ${k}`, `missing; ${USAGE}`)
    const out = req('--out')
    const pngDir = req('--png-dir')
    const pageRef = req('--page-ref')
    const timingFile = opts.get('--timing')
    const { record, pngs } = buildCapturesRecord(readJson(req('--captures')), timingFile === undefined ? null : readJson(timingFile), pageRef)
    mkdirSync(pngDir, { recursive: true })
    for (const p of pngs) writeFileSync(join(pngDir, `${p.name}.png`), p.bytes)
    writeFileSync(out, JSON.stringify(record, null, 2) + '\n')
    const nonEmpty = record.captures.filter(c => c.nonEmpty).length
    console.log(`[report:gpu-record] captures=${record.captures.length} nonEmpty=${nonEmpty} p95Ms=${record.frameTiming?.p95Ms ?? 'none'} software=${record.software}`)
    return 0
  } catch (e) {
    if (!isRefusal(e)) throw e
    console.error(e.message)
    return 1
  }
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (import.meta.url === entry) process.exitCode = main(process.argv.slice(2))
