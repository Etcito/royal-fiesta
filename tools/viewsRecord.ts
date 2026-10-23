// Views record (S21): hashes the SDF Modeler view PNGs against the committed asset files.
// The proofs read only this record and the assets, never the PNGs (1.10, 1.14).
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { decodePng, pngNonEmpty } from '../apps/headless/src/gpuRecord.ts'
import { isRefusal, refuse } from '../packages/sim/src/refusal.ts'
import { loadAssetFile } from './contentProbe.ts'
import { repoRoot } from './bricks.ts'

const AREA = 'views'
const USAGE = 'usage: node --experimental-strip-types tools/viewsRecord.ts <views.input.json>'
const INPUT_FORMAT = 'royal-fiesta.views-input'
const RECORD_FORMAT = 'royal-fiesta.views'
const INPUT_KEYS = ['format', 'version', 'out', 'width', 'height', 'subjects']
const SUBJECT_KEYS = ['name', 'assets', 'views']
const SUBJECT_RE = /^[a-z0-9-]{1,48}$/
const WORLDS = ['candy', 'ice', 'jungle', 'neon', 'common']
const VIEW_SIZE = 1024

export const VIEW_YAWS = { front: 0, 'three-quarter': 45, back: 180 } as const
export type ViewName = keyof typeof VIEW_YAWS
const VIEW_NAMES = Object.keys(VIEW_YAWS) as ViewName[]

export interface ViewsInput {
  format: 'royal-fiesta.views-input'
  version: 1
  out: string
  width: number
  height: number
  subjects: { name: string; assets: string[]; views: ViewName[] }[]
}

export interface ViewsRecord {
  format: 'royal-fiesta.views'
  version: 1
  tool: 'sdfm'
  camera: { fovYDeg: 30; yaws: typeof VIEW_YAWS }
  subjects: {
    name: string
    assets: Record<string, string>
    views: { name: string; png: string; width: number; height: number; sha256: string; bytes: number; nonEmpty: boolean }[]
  }[]
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const isPosInt = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0

function fail(path: string, ptr: string, reason: string): never {
  refuse(AREA, `${path}#${ptr}`, reason)
}

function onlyKeys(o: Obj, allowed: string[], path: string, ptr: string): void {
  for (const k of Object.keys(o)) {
    if (!allowed.includes(k)) fail(path, `${ptr}/${k}`, `unknown key '${k}'; keep only ${allowed.join(', ')}`)
  }
}

function parseViewsInput(json: unknown, path: string): ViewsInput {
  if (!isObj(json)) fail(path, '', 'the input is not a JSON object; write {"format", "version", "out", "width", "height", "subjects"}')
  onlyKeys(json, INPUT_KEYS, path, '')
  if (json.format !== INPUT_FORMAT) fail(path, '/format', `format is ${JSON.stringify(json.format)}, not '${INPUT_FORMAT}'; set "format": "${INPUT_FORMAT}"`)
  if (json.version !== 1) fail(path, '/version', `version is ${JSON.stringify(json.version)}, not 1; set "version": 1`)
  if (typeof json.out !== 'string' || json.out.length === 0) fail(path, '/out', 'out is not a non-empty string; set the PNG folder, e.g. "out/c2"')
  for (const k of ['width', 'height']) {
    if (!isPosInt(json[k])) fail(path, `/${k}`, `${k} is ${JSON.stringify(json[k])}, not a positive integer; set the PNG ${k} in pixels`)
  }
  if (!Array.isArray(json.subjects) || json.subjects.length === 0) fail(path, '/subjects', 'subjects is not a non-empty array; list the rendered subjects')
  const names = new Set<string>()
  const subjects: ViewsInput['subjects'] = []
  json.subjects.forEach((s: unknown, i: number) => {
    const p = `/subjects/${i}`
    if (!isObj(s)) fail(path, p, 'the subject is not an object; write {"name", "assets", "views"}')
    onlyKeys(s, SUBJECT_KEYS, path, p)
    if (typeof s.name !== 'string' || !SUBJECT_RE.test(s.name)) fail(path, `${p}/name`, `name ${JSON.stringify(s.name)} does not match ${SUBJECT_RE.source}; use lower-case words joined by '-'`)
    if (names.has(s.name)) fail(path, `${p}/name`, `duplicate subject '${s.name}'; give each subject its own name`)
    names.add(s.name)
    if (!Array.isArray(s.assets) || s.assets.length === 0) fail(path, `${p}/assets`, 'assets is not a non-empty array; list the asset ids shown in the view')
    const assets: unknown[] = s.assets
    assets.forEach((a, j) => {
      if (typeof a !== 'string' || a.length === 0) fail(path, `${p}/assets/${j}`, `asset ${JSON.stringify(a)} is not an asset id; use an id such as penguin.body`)
      if (assets.indexOf(a) !== j) fail(path, `${p}/assets/${j}`, `duplicate asset '${a}'; list it once`)
    })
    if (!Array.isArray(s.views) || s.views.length === 0) fail(path, `${p}/views`, `views is not a non-empty array; list some of ${VIEW_NAMES.join('|')}`)
    const views: unknown[] = s.views
    views.forEach((v, j) => {
      if (!VIEW_NAMES.includes(v as ViewName)) fail(path, `${p}/views/${j}`, `view ${JSON.stringify(v)} is not one of ${VIEW_NAMES.join('|')}; use one of them`)
      if (views.indexOf(v) !== j) fail(path, `${p}/views/${j}`, `duplicate view '${String(v)}'; list it once`)
    })
    subjects.push({ name: s.name, assets: assets as string[], views: views as ViewName[] })
  })
  return { format: INPUT_FORMAT, version: 1, out: json.out, width: json.width as number, height: json.height as number, subjects }
}

// One file per id across the S14 worlds; a missing or doubled id is refused.
function assetPath(id: string, root: string): string {
  const hits = WORLDS.map(w => `assets/${w}/${id}.asset.json`).filter(rel => existsSync(join(root, rel)))
  if (hits.length !== 1) {
    const what = hits.length === 0 ? 'no file' : `${hits.length} files (${hits.join(', ')})`
    refuse(AREA, `assets/<world>/${id}.asset.json`, `${what} for asset '${id}'; save exactly one assets/<world>/${id}.asset.json`)
  }
  return hits[0]
}

// loadAssetFile resolves against the repository, so point it at the same file under root.
async function assetHash(rel: string, root: string): Promise<string> {
  return (await loadAssetFile(relative(repoRoot(), resolve(root, rel)))).asset.hash
}

export async function buildViewsRecord(input: ViewsInput, root: string): Promise<ViewsRecord> {
  const subjects: ViewsRecord['subjects'] = []
  for (const s of input.subjects) {
    const assets: Record<string, string> = {}
    for (const id of s.assets) assets[id] = await assetHash(assetPath(id, root), root)
    const views: ViewsRecord['subjects'][number]['views'] = []
    for (const v of s.views) {
      const png = `${input.out}/${s.name}-${v}.png`
      let buf: Buffer
      try {
        buf = readFileSync(join(root, png))
      } catch {
        return refuse(AREA, png, `missing view of '${s.name}'; render it with SDF Modeler at ${input.width}x${input.height}`)
      }
      const decoded = decodePng(buf, input.width, input.height, png)
      views.push({
        name: v, png, width: input.width, height: input.height,
        sha256: createHash('sha256').update(buf).digest('hex'), bytes: buf.length, nonEmpty: pngNonEmpty(decoded),
      })
    }
    subjects.push({ name: s.name, assets, views })
  }
  return { format: RECORD_FORMAT, version: 1, tool: 'sdfm', camera: { fovYDeg: 30, yaws: VIEW_YAWS }, subjects }
}

export async function viewsProblems(record: ViewsRecord, root: string): Promise<string[]> {
  const problems: string[] = []
  for (const s of record.subjects) {
    for (const [id, hash] of Object.entries(s.assets)) {
      let committed: string
      try {
        committed = await assetHash(assetPath(id, root), root)
      } catch (e) {
        if (!isRefusal(e)) throw e
        problems.push(`${s.name}: asset ${id}: ${e.message}`)
        continue
      }
      if (committed !== hash) problems.push(`${s.name}: asset ${id} hash ${hash} differs from the committed ${committed}: stale record; re-render`)
    }
    if (s.views.length === 0) problems.push(`${s.name}: no views; render them and re-run tools/viewsRecord.ts`)
    for (const v of s.views) {
      if (v.width !== VIEW_SIZE || v.height !== VIEW_SIZE) problems.push(`${s.name}/${v.name}: ${v.width}x${v.height}, not ${VIEW_SIZE}x${VIEW_SIZE}; re-render at ${VIEW_SIZE}x${VIEW_SIZE}`)
      if (!v.nonEmpty) problems.push(`${s.name}/${v.name}: ${v.png} is empty (uniform); re-render it`)
    }
  }
  return problems
}

// The root is the working directory: the proof commands run from the repository root.
export async function main(argv: string[]): Promise<number> {
  try {
    if (argv.length !== 1) refuse(AREA, 'argv', `expected one input file; ${USAGE}`)
    const inputPath = argv[0]
    let json: unknown
    try {
      json = JSON.parse(readFileSync(inputPath, 'utf8'))
    } catch (e) {
      return refuse(AREA, inputPath, `cannot read the input (${(e as Error).message}); pass a views.input.json file`)
    }
    const input = parseViewsInput(json, inputPath)
    const record = await buildViewsRecord(input, process.cwd())
    const out = join(dirname(inputPath), 'views.json')
    writeFileSync(out, JSON.stringify(record, null, 2) + '\n')
    for (const s of record.subjects) {
      for (const v of s.views) console.log(`[views] ${s.name}/${v.name} ${v.width}x${v.height} bytes=${v.bytes} nonEmpty=${v.nonEmpty}`)
    }
    return 0
  } catch (e) {
    if (!isRefusal(e)) throw e
    console.error(e.message)
    return 1
  }
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (import.meta.url === entry) process.exitCode = await main(process.argv.slice(2))
