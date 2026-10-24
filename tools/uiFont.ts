import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { isRefusal, refuse, RefusalError } from '../packages/sim/src/refusal.ts'
import { ASSET_STORE_BASE, objectUrl as storeObjectUrl } from '../packages/game/src/assets.ts'
import { repoRoot } from './bricks.ts'

export { ASSET_STORE_BASE }

export const FONTS_PATH = 'ui/fonts.json'
export const FONT_DIR = 'out/fonts'
export const FONT_STORE = 'out/font-store'
// The page copy (gitignored, like the baked audio): the GPU page has no network, so the build ships the
// verified bytes in dist and the uaa host loads fonts/<sha256>.woff2 relative to the page.
export const BUNDLE_DIR = 'apps/web/public/fonts'
const AREA = 'ui-font'
const SHA256 = /^[0-9a-f]{64}$/
const FAMILY = /^[A-Za-z0-9][A-Za-z0-9 .-]{0,63}$/
const LICENSE = /^[A-Za-z0-9][A-Za-z0-9.+-]{0,31}$/
const FONT_KEYS = ['family', 'weight', 'url', 'sha256', 'bytes', 'license', 'source'] as const
const FONTSOURCE = /^https:\/\/cdn\.jsdelivr\.net\/fontsource\/fonts\/([a-z0-9-]+)@(\d+\.\d+\.\d+)\/([a-z0-9@._-]+\.woff2)$/
const USAGE = 'usage: node --experimental-strip-types tools/uiFont.ts fetch|bundle|upload|verify [family]'

export interface FontEntry {
  family: string
  weight: number
  url: string
  sha256: string
  bytes: number
  license: string
  source: string
}

export interface Fonts { fonts: FontEntry[] }
export interface FetchResponse { ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer> }
export type FetchLike = (url: string) => Promise<FetchResponse>
export interface PutObject { sha256: string; size: number; key: string }
export type Put = (file: string) => Promise<PutObject>
export interface StoreTarget { target: string; root: string }
export interface PublishInput { ssh: string; keyFile: string; root: string; sha256: string; bytes: Uint8Array; pid: number }
export type Publish = (input: PublishInput) => Promise<void>
export interface UploadOptions {
  get?: FetchLike
  stage?: Put
  publish?: Publish
  env?: NodeJS.ProcessEnv
  log?: (line: string) => void
}

export class UploadEnvError extends Error {
  constructor() {
    super('uiFont: upload needs ASSET_STORE_SSH and ASSET_STORE_KEY')
    this.name = 'UploadEnvError'
  }
}

const publicFetch: FetchLike = url => fetch(url)

export function objectUrl(sha256: string): string {
  if (!SHA256.test(sha256)) refuse(AREA, `font:${sha256}`, `sha256 '${sha256}' is not 64 lowercase hex; use the object hash`)
  return storeObjectUrl(sha256, ASSET_STORE_BASE)
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function pinnedSource(source: string): boolean {
  if (!source.startsWith('https://') || source.includes('@latest')) return false
  try {
    return new URL(source).protocol === 'https:'
  } catch {
    return false
  }
}

export function parseFonts(json: unknown, path: string = FONTS_PATH): Fonts {
  if (!isObject(json)) refuse(AREA, `${path}#`, 'the registry is not a JSON object; write {"fonts": [ ... ]}')
  for (const key of Object.keys(json)) {
    if (key !== 'fonts') refuse(AREA, `${path}#/${key}`, `unknown key '${key}'; keep only fonts`)
  }
  if (!Array.isArray(json.fonts)) refuse(AREA, `${path}#/fonts`, 'fonts is not an array; write "fonts": [ ... ]')
  if (json.fonts.length === 0) refuse(AREA, `${path}#/fonts`, 'fonts is empty; add at least one font')
  const fonts: FontEntry[] = []
  const seen = new Set<string>()
  for (let i = 0; i < json.fonts.length; i++) {
    const base = `${path}#/fonts/${i}`
    const entry: unknown = json.fonts[i]
    if (!isObject(entry)) refuse(AREA, base, 'entry is not an object; write {family, weight, url, sha256, bytes, license, source}')
    for (const key of Object.keys(entry)) {
      if (!(FONT_KEYS as readonly string[]).includes(key)) refuse(AREA, `${base}/${key}`, `unknown key '${key}'; keep only ${FONT_KEYS.join(', ')}`)
    }
    for (const key of FONT_KEYS) {
      if (!(key in entry)) refuse(AREA, `${base}/${key}`, `missing key '${key}'; write all of ${FONT_KEYS.join(', ')}`)
    }
    const family = entry.family
    if (typeof family !== 'string' || !FAMILY.test(family)) {
      refuse(AREA, `${base}/family`, `family ${JSON.stringify(family)} is not 1-64 letters, digits, spaces, dots or hyphens; use the font family name`)
    }
    const weight = entry.weight
    if (typeof weight !== 'number' || !Number.isInteger(weight) || weight < 1 || weight > 1000) {
      refuse(AREA, `${base}/weight`, `weight ${JSON.stringify(weight)} is not an integer from 1 to 1000; use the font weight`)
    }
    const sha256 = entry.sha256
    if (typeof sha256 !== 'string' || !SHA256.test(sha256)) {
      refuse(AREA, `${base}/sha256`, 'sha256 is not 64 lowercase hexadecimal characters; use the object hash')
    }
    const url = entry.url
    const derived = objectUrl(sha256)
    if (url !== derived) refuse(AREA, `${base}/url`, `url is ${JSON.stringify(url)}, not ${derived}; derive it from sha256`)
    const bytes = entry.bytes
    if (typeof bytes !== 'number' || !Number.isInteger(bytes) || bytes <= 0) {
      refuse(AREA, `${base}/bytes`, `bytes ${JSON.stringify(bytes)} is not a positive integer; use the object byte length`)
    }
    const license = entry.license
    if (typeof license !== 'string' || !LICENSE.test(license)) {
      refuse(AREA, `${base}/license`, `license ${JSON.stringify(license)} is not an SPDX identifier; use the font licence`)
    }
    const source = entry.source
    if (typeof source !== 'string' || !pinnedSource(source)) {
      refuse(AREA, `${base}/source`, `source ${JSON.stringify(source)} is not an https URL pinned to a version; resolve @latest and use the versioned URL`)
    }
    const id = `${family}/${weight}`
    if (seen.has(id)) refuse(AREA, `${base}/family`, `${family} ${weight} duplicates an earlier entry; keep one per family and weight`)
    seen.add(id)
    fonts.push({ family, weight, url, sha256, bytes, license, source })
  }
  return { fonts }
}

export function readFonts(root: string): Fonts {
  let text: string
  try {
    text = readFileSync(join(root, FONTS_PATH), 'utf8')
  } catch (error) {
    refuse(AREA, FONTS_PATH, `cannot read the font registry (${error instanceof Error ? error.message : String(error)}); restore ${FONTS_PATH}`)
  }
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch (error) {
    refuse(AREA, FONTS_PATH, `invalid JSON (${error instanceof Error ? error.message : String(error)}); fix the file syntax`)
  }
  return parseFonts(json, FONTS_PATH)
}

export function writeFonts(root: string, fonts: Fonts): void {
  const entries = fonts.fonts.map(font => ({
    family: font.family,
    weight: font.weight,
    url: font.url,
    sha256: font.sha256,
    bytes: font.bytes,
    license: font.license,
    source: font.source,
  }))
  writeFileSync(join(root, FONTS_PATH), `${JSON.stringify({ fonts: entries }, null, 2)}\n`)
}

export function fileName(entry: FontEntry): string {
  const slug = entry.family.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  if (slug === '') refuse(AREA, `font:${entry.family}`, 'family has no letters or digits; use a family name that can name a file')
  return `${slug}-${entry.weight}.woff2`
}

export function fontPath(root: string, entry: FontEntry): string {
  return join(root, FONT_DIR, fileName(entry))
}

export function fontsourceMirror(source: string): { url: string; path: string } | null {
  const match = FONTSOURCE.exec(source)
  if (match === null) return null
  const [, id, version, file] = match
  return { url: `https://registry.npmjs.org/@fontsource/${id}/-/${id}-${version}.tgz`, path: `package/files/${id}-${file}` }
}

function cString(bytes: Uint8Array, start: number, length: number): string {
  let end = start
  while (end < start + length && bytes[end] !== 0) end++
  return new TextDecoder().decode(bytes.subarray(start, end))
}

function tarEntry(gz: Uint8Array, wanted: string): Uint8Array | null {
  const tar = gunzipSync(gz)
  for (let offset = 0; offset + 512 <= tar.length;) {
    const name = cString(tar, offset, 100)
    if (name === '') return null
    const sizeText = cString(tar, offset + 124, 12).trim()
    const size = sizeText === '' ? 0 : Number.parseInt(sizeText, 8)
    if (!Number.isFinite(size) || size < 0) return null
    const start = offset + 512
    const prefix = cString(tar, offset + 345, 155)
    if ((prefix === '' ? name : `${prefix}/${name}`) === wanted) return new Uint8Array(tar.subarray(start, start + size))
    offset = start + Math.ceil(size / 512) * 512
  }
  return null
}

async function downloadFont(entry: FontEntry, get: FetchLike, log: (line: string) => void): Promise<Uint8Array> {
  let failure: string
  try {
    const response = await get(entry.source)
    if (response.ok) return new Uint8Array(await response.arrayBuffer())
    failure = `HTTP ${response.status}`
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error)
  }
  const mirror = fontsourceMirror(entry.source)
  if (mirror === null) refuse(AREA, entry.source, `download failed (${failure}); check the source URL and the network`)
  let response: FetchResponse
  try {
    response = await get(mirror.url)
  } catch (error) {
    refuse(AREA, entry.source, `download failed (${failure}) and the npm mirror failed (${error instanceof Error ? error.message : String(error)}); check the network`)
  }
  if (!response.ok) refuse(AREA, entry.source, `download failed (${failure}) and the npm mirror answered HTTP ${response.status}; check the network`)
  const bytes = tarEntry(new Uint8Array(await response.arrayBuffer()), mirror.path)
  if (bytes === null) refuse(AREA, entry.source, `download failed (${failure}) and the npm mirror has no ${mirror.path}; check the fontsource version`)
  log(`ui-font: ${entry.source} answered ${failure}; used ${mirror.url}`)
  return bytes
}

export async function fetchFont(root: string, entry: FontEntry, get: FetchLike = publicFetch, log: (line: string) => void = console.log): Promise<string> {
  const write = (line: string): void => log(redact(line))
  const file = fontPath(root, entry)
  try {
    const cached = new Uint8Array(readFileSync(file))
    if (cached.length === entry.bytes && sha256Hex(cached) === entry.sha256) {
      write(`PASS font fetch ${fileName(entry)} ${entry.sha256} ${entry.bytes} bytes (cached)`)
      return file
    }
  } catch {}
  const bytes = await downloadFont(entry, get, write)
  const actual = sha256Hex(bytes)
  if (actual !== entry.sha256) refuse(AREA, entry.source, `sha256 mismatch: ui/fonts.json has ${entry.sha256}, downloaded ${actual}; check the source before updating the registry`)
  if (bytes.length !== entry.bytes) refuse(AREA, entry.source, `byte length mismatch: ui/fonts.json has ${entry.bytes}, downloaded ${bytes.length}; check the source before updating the registry`)
  mkdirSync(dirname(file), { recursive: true })
  const temp = `${file}.tmp-${process.pid}`
  writeFileSync(temp, bytes)
  renameSync(temp, file)
  write(`PASS font fetch ${fileName(entry)} ${actual} ${bytes.length} bytes`)
  return file
}

export function bundledName(entry: FontEntry): string {
  if (!SHA256.test(entry.sha256)) refuse(AREA, `font:${entry.family}`, `sha256 '${entry.sha256}' is not 64 lowercase hex; use the object hash`)
  return `${entry.sha256}.woff2`
}

// fetch, then copy the verified bytes to BUNDLE_DIR for the web build.
export async function bundleFont(root: string, entry: FontEntry, get: FetchLike = publicFetch, log: (line: string) => void = console.log): Promise<string> {
  const source = new Uint8Array(readFileSync(await fetchFont(root, entry, get, log)))
  const file = join(root, BUNDLE_DIR, bundledName(entry))
  mkdirSync(dirname(file), { recursive: true })
  const temp = `${file}.tmp-${process.pid}`
  writeFileSync(temp, source)
  renameSync(temp, file)
  log(redact(`PASS font bundle ${fileName(entry)} -> ${BUNDLE_DIR}/${bundledName(entry)}`))
  return file
}

function secretValues(env: NodeJS.ProcessEnv): string[] {
  const values: string[] = []
  const ssh = env.ASSET_STORE_SSH
  if (ssh !== undefined && ssh !== '') {
    values.push(ssh)
    const at = ssh.lastIndexOf('@')
    if (at >= 0) {
      const rest = ssh.slice(at + 1)
      let colon: number
      if (rest.startsWith('[')) {
        const close = rest.indexOf(']')
        colon = close < 0 ? -1 : rest.indexOf(':', close)
      } else {
        colon = rest.indexOf(':')
      }
      if (colon > 0) {
        values.push(rest.slice(0, colon))
        values.push(rest.slice(colon + 1))
      }
    }
  }
  const key = env.ASSET_STORE_KEY
  if (key !== undefined && key !== '') {
    values.push(key)
    values.push(basename(key))
  }
  return values.filter(value => value.length >= 3).sort((a, b) => b.length - a.length)
}

export function redact(text: string, env: NodeJS.ProcessEnv = process.env): string {
  let out = text
  for (const value of secretValues(env)) out = out.split(value).join('<asset-store-secret>')
  return out
}

function runProcess(command: string, args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((done, fail) => {
    const child = spawn(command, args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { stdout += chunk })
    child.stderr.on('data', (chunk: string) => { stderr += chunk })
    child.on('error', fail)
    child.on('close', code => done({ code: code ?? 1, stdout, stderr }))
  })
}

export function cliFile(root: string): string {
  const require = createRequire(join(root, 'package.json'))
  try {
    return join(dirname(require.resolve('@etcito/raa-assets-tools/package.json')), 'dist', 'cli', 'main.js')
  } catch {
    refuse(AREA, 'raa-assets-tools', 'cannot resolve the raa-assets CLI; run npm install and use the pinned @etcito/raa-assets-tools')
  }
}

function tail(text: string, env: NodeJS.ProcessEnv = process.env): string {
  const line = redact(text, env).trim().split('\n').filter(Boolean).pop()
  return line === undefined ? '' : `: ${line}`
}

export async function runRaaPut(root: string, file: string): Promise<PutObject> {
  const store = join(root, FONT_STORE)
  mkdirSync(store, { recursive: true })
  const result = await runProcess(process.execPath, [cliFile(root), 'put', file, '--store', store, '--json'], root)
  if (result.code !== 0) {
    refuse(AREA, file, `raa-assets put exited ${result.code}${tail(result.stderr)}; check the asset store and its environment (the CLI reads ASSET_STORE_SSH and ASSET_STORE_KEY and they are never printed)`)
  }
  let json: unknown
  try {
    json = JSON.parse(result.stdout)
  } catch {
    refuse(AREA, file, `raa-assets put printed no JSON${tail(result.stderr)}; check the CLI output`)
  }
  if (!isObject(json) || !Array.isArray(json.objects) || !isObject(json.objects[0])) {
    refuse(AREA, file, 'raa-assets put returned no objects; check the CLI output')
  }
  const object = json.objects[0]
  if (typeof object.sha256 !== 'string' || typeof object.size !== 'number' || typeof object.key !== 'string') {
    refuse(AREA, file, 'raa-assets put returned an object without sha256, size and key; check the CLI version')
  }
  const key = `objects/${object.sha256.slice(0, 2)}/${object.sha256}`
  if (object.key !== key) refuse(AREA, file, `raa-assets put staged ${object.key}, not ${key}; check the CLI store`)
  return { sha256: object.sha256, size: object.size, key }
}

export function parseStoreTarget(ssh: string): StoreTarget {
  if (ssh.includes('://')) refuse(AREA, 'ASSET_STORE_SSH', 'is not an scp-form target; use <user>@<host>:<store root>')
  const at = ssh.lastIndexOf('@')
  if (at <= 0) refuse(AREA, 'ASSET_STORE_SSH', 'has no <user>@<host>; use <user>@<host>:<store root>')
  const host = ssh.slice(at + 1)
  let colon: number
  if (host.startsWith('[')) {
    const close = host.indexOf(']')
    colon = close < 0 ? -1 : host.indexOf(':', close)
  } else {
    colon = host.indexOf(':')
  }
  if (colon <= 0) refuse(AREA, 'ASSET_STORE_SSH', 'has no :<store root>; use <user>@<host>:<store root>')
  const target = ssh.slice(0, at + 1) + host.slice(0, colon)
  const root = host.slice(colon + 1)
  if (!root.startsWith('/')) refuse(AREA, 'ASSET_STORE_SSH', 'store root is not absolute; use <user>@<host>:/<path>')
  const trimmed = root.replace(/\/+$/, '')
  return { target, root: trimmed === '' ? '/' : trimmed }
}

function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export function publishCommand(target: StoreTarget, sha256: string, pid: number): string {
  const dir = `${target.root === '/' ? '' : target.root}/objects/${sha256.slice(0, 2)}`
  const dest = `${dir}/${sha256}`
  const temp = `${dest}.tmp-${pid}`
  return `mkdir -p ${quote(dir)} && cat > ${quote(temp)} && mv ${quote(temp)} ${quote(dest)}`
}

export function publishObject(input: PublishInput): Promise<void> {
  const env: NodeJS.ProcessEnv = { ASSET_STORE_SSH: `${input.ssh}:${input.root}`, ASSET_STORE_KEY: input.keyFile }
  return new Promise((done, fail) => {
    const args = [
      '-i', input.keyFile,
      '-o', 'BatchMode=yes',
      '-o', 'StrictHostKeyChecking=accept-new',
      '-o', 'ConnectTimeout=20',
      input.ssh,
      publishCommand({ target: input.ssh, root: input.root }, input.sha256, input.pid),
    ]
    const child = spawn('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { stdout += chunk })
    child.stderr.on('data', (chunk: string) => { stderr += chunk })
    child.on('error', (error: unknown) => {
      fail(new RefusalError(AREA, 'ASSET_STORE_SSH', `cannot run ssh (${error instanceof Error ? error.message : String(error)}); check the ssh client and ASSET_STORE_KEY`))
    })
    child.on('close', code => {
      if (code === 0) done()
      else fail(new RefusalError(AREA, 'ASSET_STORE_SSH', `ssh exited ${code ?? 1}${tail(stderr || stdout, env)}; check ASSET_STORE_SSH, ASSET_STORE_KEY and the store root`))
    })
    child.stdin.on('error', () => {})
    child.stdin.end(Buffer.from(input.bytes))
  })
}

async function storeHas(entry: FontEntry, get: FetchLike): Promise<boolean> {
  try {
    const response = await get(entry.url)
    if (!response.ok) return false
    const bytes = new Uint8Array(await response.arrayBuffer())
    return bytes.length === entry.bytes && sha256Hex(bytes) === entry.sha256
  } catch {
    return false
  }
}

export async function uploadFont(root: string, entry: FontEntry, options: UploadOptions = {}): Promise<void> {
  const write = options.log ?? console.log
  const env = options.env ?? process.env
  const log = (line: string): void => write(redact(line, env))
  const get = options.get ?? publicFetch
  const key = `objects/${entry.sha256.slice(0, 2)}/${entry.sha256}`
  if (await storeHas(entry, get)) {
    log(`PASS font upload ${fileName(entry)} already published ${key}`)
    return
  }
  const ssh = env.ASSET_STORE_SSH
  const keyFile = env.ASSET_STORE_KEY
  if (ssh === undefined || ssh === '' || keyFile === undefined || keyFile === '') throw new UploadEnvError()
  const file = fontPath(root, entry)
  let bytes: Uint8Array
  try {
    bytes = new Uint8Array(readFileSync(file))
  } catch {
    refuse(AREA, `${FONT_DIR}/${fileName(entry)}`, 'the local font is missing; run fetch before upload')
  }
  const actual = sha256Hex(bytes)
  if (actual !== entry.sha256 || bytes.length !== entry.bytes) {
    refuse(AREA, `${FONT_DIR}/${fileName(entry)}`, `the local font is ${actual} with ${bytes.length} bytes, not the registry's ${entry.sha256} with ${entry.bytes}; run fetch again`)
  }
  const stage = options.stage ?? ((path: string) => runRaaPut(root, path))
  const stored = await stage(file)
  if (stored.sha256 !== entry.sha256 || stored.size !== entry.bytes || stored.key !== key) {
    refuse(AREA, `${FONT_DIR}/${fileName(entry)}`, `raa-assets put staged ${stored.sha256} (${stored.size} bytes) at ${stored.key}, not ${entry.sha256} (${entry.bytes} bytes) at ${key}; check the local font and the CLI store`)
  }
  const target = parseStoreTarget(ssh)
  const stagedFile = join(root, FONT_STORE, stored.key)
  let staged: Uint8Array
  try {
    staged = new Uint8Array(readFileSync(stagedFile))
  } catch {
    refuse(AREA, `${FONT_STORE}/${stored.key}`, 'the staged font is missing; run upload again')
  }
  if (sha256Hex(staged) !== stored.sha256 || staged.length !== stored.size) {
    refuse(AREA, `${FONT_STORE}/${stored.key}`, 'the staged font does not match its sha256 and size; run upload again')
  }
  const publish = options.publish ?? publishObject
  await publish({ ssh: target.target, keyFile, root: target.root, sha256: stored.sha256, bytes: staged, pid: process.pid })
  log(`PASS font upload ${fileName(entry)} published ${stored.sha256} ${stored.size} bytes ${stored.key}`)
  await verifyFont(entry, get, log)
  const fonts = readFonts(root)
  const index = fonts.fonts.findIndex(font => font.family === entry.family && font.weight === entry.weight)
  if (index < 0) refuse(AREA, FONTS_PATH, `no ${entry.family} ${entry.weight} entry; add it before upload`)
  fonts.fonts[index] = { ...fonts.fonts[index], url: objectUrl(stored.sha256), sha256: stored.sha256, bytes: stored.size }
  writeFonts(root, fonts)
}

export async function verifyFont(entry: FontEntry, get: FetchLike = publicFetch, log: (line: string) => void = console.log): Promise<void> {
  const write = (line: string): void => log(redact(line))
  let response: FetchResponse
  try {
    response = await get(entry.url)
  } catch (error) {
    refuse(AREA, entry.url, `GET failed (${error instanceof Error ? error.message : String(error)}); check the store URL and the network`)
  }
  if (!response.ok) refuse(AREA, entry.url, `GET answered HTTP ${response.status}; upload the font first`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  const actual = sha256Hex(bytes)
  if (actual !== entry.sha256) refuse(AREA, entry.url, `sha256 mismatch: ui/fonts.json has ${entry.sha256}, the store has ${actual}; upload the font`)
  if (bytes.length !== entry.bytes) refuse(AREA, entry.url, `byte length mismatch: ui/fonts.json has ${entry.bytes}, the store has ${bytes.length}; upload the font`)
  write(`PASS font verify ${fileName(entry)} ${actual} ${bytes.length} bytes`)
}

const COMMANDS = ['fetch', 'bundle', 'upload', 'verify'] as const
type Command = typeof COMMANDS[number]

function isCommand(value: string | undefined): value is Command {
  return value !== undefined && (COMMANDS as readonly string[]).includes(value)
}

export async function main(argv: string[], root: string = repoRoot()): Promise<number> {
  const [command, family, ...rest] = argv
  if (!isCommand(command) || rest.length > 0) {
    console.error(USAGE)
    return 2
  }
  try {
    const fonts = readFonts(root).fonts.filter(entry => family === undefined || entry.family === family)
    if (fonts.length === 0) refuse(AREA, FONTS_PATH, `no font family '${family}'; list the families with node --experimental-strip-types tools/uiFont.ts`)
    for (const entry of fonts) {
      if (command === 'fetch') await fetchFont(root, entry)
      else if (command === 'bundle') await bundleFont(root, entry)
      else if (command === 'upload') await uploadFont(root, entry)
      else await verifyFont(entry)
    }
    console.log(redact(`PASS ui-font ${command}: ${fonts.length} font(s)`))
    return 0
  } catch (error) {
    if (error instanceof UploadEnvError) {
      console.error(error.message)
      return 1
    }
    if (!isRefusal(error)) throw error
    console.error(redact(error.message))
    return 1
  }
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (import.meta.url === entry) process.exit(await main(process.argv.slice(2)))
