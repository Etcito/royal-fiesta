// Authored registry (S20): the assets/ and courses/ files written by SDF Modeler or by hand.
// tools/placeholders.ts neither regenerates nor compares a listed file.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ASSET_ID_RE } from '../packages/game/src/gameAsset.ts'
import { refuse } from '../packages/sim/src/refusal.ts'

export const AUTHORED_PATH = 'tools/authored.json'

export interface Authored { files: readonly string[] }

const FORMAT = 'royal-fiesta.authored'
const TOP_KEYS = ['format', 'version', 'files']
// The worlds of sdfm.game.json (S14); gameAsset.ts keeps its own list private.
const WORLDS = ['candy', 'ice', 'jungle', 'neon', 'common']
const ASSET_PATH_RE = /^assets\/([^/]+)\/([^/]+)\.asset\.json$/
const COURSE_PATH_RE = /^courses\/([a-z0-9-]{1,40})\.course\.json$/

function fail(path: string, ptr: string, reason: string): never {
  refuse('authored', `${path}#${ptr}`, reason)
}

function isEntryPath(rel: string): boolean {
  if (COURSE_PATH_RE.test(rel)) return true
  const m = ASSET_PATH_RE.exec(rel)
  return m !== null && WORLDS.includes(m[1]) && ASSET_ID_RE.test(m[2])
}

export function parseAuthored(json: unknown, path: string): Authored {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) fail(path, '', 'the registry is not a JSON object; write {"format", "version", "files"}')
  const obj = json as Record<string, unknown>
  for (const key of Object.keys(obj)) {
    if (!TOP_KEYS.includes(key)) fail(path, `/${key}`, `unknown key '${key}'; keep only format, version and files`)
  }
  if (obj.format !== FORMAT) fail(path, '/format', `format is ${JSON.stringify(obj.format)}, not '${FORMAT}'; set "format": "${FORMAT}"`)
  if (obj.version !== 1) fail(path, '/version', `version is ${JSON.stringify(obj.version)}, not 1; set "version": 1`)
  if (!Array.isArray(obj.files)) fail(path, '/files', 'files is not an array; write "files": [ <repository paths> ]')
  const files: string[] = []
  const firstIndex = new Map<string, number>()
  for (let i = 0; i < obj.files.length; i++) {
    const rel: unknown = obj.files[i]
    if (typeof rel !== 'string') fail(path, `/files/${i}`, `entry ${JSON.stringify(rel)} is not a string; write a repository path`)
    if (!isEntryPath(rel)) {
      fail(path, `/files/${i}`, `'${rel}' is neither assets/<world>/<id>.asset.json (world candy|ice|jungle|neon|common) nor courses/<id>.course.json; list only game asset and course files`)
    }
    const first = firstIndex.get(rel)
    if (first !== undefined) fail(path, `/files/${i}`, `'${rel}' duplicates entry ${first}; remove the duplicate`)
    // Plain < compares UTF-16 code units, the order JSON tools and Array.prototype.sort use.
    if (i > 0 && !(files[i - 1] < rel)) fail(path, `/files/${i}`, `'${rel}' is not sorted; sort the entries by code unit`)
    firstIndex.set(rel, i)
    files.push(rel)
  }
  return { files }
}

export function readAuthored(root: string): Authored {
  let text: string
  try {
    text = readFileSync(join(root, AUTHORED_PATH), 'utf8')
  } catch (e) {
    // Never an empty default: a missing registry would let placeholders.ts overwrite authored files.
    refuse('authored', AUTHORED_PATH, `cannot read the registry (${(e as Error).message}); restore the file`)
  }
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch (e) {
    refuse('authored', AUTHORED_PATH, `invalid JSON ${(e as Error).message}; fix the file syntax`)
  }
  return parseAuthored(json, AUTHORED_PATH)
}

export function isAuthored(a: Authored, rel: string): boolean {
  return a.files.includes(rel)
}
