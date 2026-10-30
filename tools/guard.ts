import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { assetDocumentText, assetFileText } from '../packages/game/src/gameAsset.ts'

export type GuardRule =
  | 'binary-ext'
  | 'nul-byte'
  | 'not-utf8'
  | 'too-large'
  | 'asset-outside-fixtures'
  | 'asset-not-modeler-valid'
  | 'fixture-not-json'
  | 'fixture-too-large'
  | 'public-leak'

export interface GuardViolation {
  path: string
  rule: GuardRule
  detail: string
}

export const BINARY_EXTS: readonly string[] = [
  '.glb', '.gltf', '.png', '.jpg', '.jpeg', '.webp', '.avif', '.gif', '.bmp',
  '.tga', '.ico', '.ktx2', '.dds', '.basis', '.exr', '.hdr', '.bin', '.wasm',
  '.zip', '.gz', '.tgz', '.7z', '.tar', '.rar', '.mp3', '.ogg', '.wav', '.flac',
  '.mp4', '.webm', '.mov', '.fbx', '.obj', '.blend', '.psd', '.ttf', '.otf',
  '.woff', '.woff2', '.pdf', '.mesh',
]

export const MAX_FILE_BYTES = 262144
export const MAX_FIXTURE_BYTES = 65536
export const MAX_ASSET_FILE_BYTES = 2200000
const LOGO_SOURCE = /^ui\/logo\.[a-z0-9-]+\.png$/

const BINARY_EXT_SET = new Set(BINARY_EXTS)
const WORLDS = ['candy', 'ice', 'jungle', 'neon', 'common']

interface Placement {
  suffix: string
  allowed: (file: string) => boolean
  where: string
}

// suffix -> the only folders it may live in
const PLACEMENT: readonly Placement[] = [
  { suffix: '.prims.json', allowed: (file) => file.startsWith('fixtures/'), where: 'fixtures/' },
  { suffix: '.manifest.json', allowed: (file) => file.startsWith('fixtures/'), where: 'fixtures/' },
  {
    suffix: '.course.json',
    allowed: (file) => file.startsWith('fixtures/') || file.startsWith('courses/'),
    where: 'fixtures/ or courses/',
  },
  {
    suffix: '.asset.json',
    allowed: (file) => file.startsWith('fixtures/') || inWorldFolder(file),
    where: `fixtures/ or assets/<world>/ (${WORLDS.join('|')})`,
  },
  { suffix: '.ui.json', allowed: (file) => file.startsWith('ui/'), where: 'ui/' },
  {
    suffix: '.haa.json',
    allowed: (file) => file.startsWith('fixtures/') || file.startsWith('audio/'),
    where: 'fixtures/ or audio/',
  },
]

// The guard's own files spell out every pattern on purpose.
const LEAK_EXEMPT = new Set(['tools/guard.ts', 'tools/test/guard.test.ts'])

function inWorldFolder(file: string): boolean {
  const parts = file.split('/')
  return parts.length === 3 && parts[0] === 'assets' && WORLDS.includes(parts[1]!)
}

export interface LeakHit {
  pattern: string
  index: number
  excerpt: string
}

const OCTET = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)'
const LABEL = '[a-z0-9](?:[a-z0-9-]*[a-z0-9])?'

const LEAK_PATTERNS: readonly { name: string; re: RegExp }[] = [
  {
    name: 'home-path',
    re: /(?<![\w.-])(?:\/home\/[A-Za-z0-9._-]+\/|\/root\/|\/Users\/[A-Za-z0-9._-]+\/|[A-Za-z]:(?:\\{1,2}|\/)[Uu]sers(?:\\{1,2}|\/))/g,
  },
  {
    // 127.0.0.1 and 0.0.0.0 are outside these ranges, so they never hit
    name: 'private-ipv4',
    re: new RegExp(
      `(?<![\\d.])(?:10\\.${OCTET}\\.${OCTET}\\.${OCTET}|172\\.(?:1[6-9]|2\\d|3[01])\\.${OCTET}\\.${OCTET}|192\\.168\\.${OCTET}\\.${OCTET})(?!\\d|\\.\\d)`,
      'g',
    ),
  },
  {
    // hostname shape only, so code such as `f(this.local)` does not hit
    name: 'internal-host',
    re: new RegExp(
      `(?<=^|[\\s'"\`@]|//)(?:${LABEL}\\.)+(?:internal|corp|lan|local|intranet)(?![\\w-]|\\.[a-z0-9])`,
      'gim',
    ),
  },
  { name: 'github-token', re: /(?<![A-Za-z0-9])(?:gh[opsu]_|github_pat_)[A-Za-z0-9_]{20,}/g },
  {
    // the whole block, so an excerpt never shows key material
    name: 'private-key',
    re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----(?:[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----|[\s\S]*)/g,
  },
  { name: 'aws-key', re: /(?<![A-Z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Z0-9])/g },
  { name: 'slack-token', re: /(?<![A-Za-z0-9])xox[abprs]-[A-Za-z0-9-]{10,}/g },
]

const EXCERPT_CONTEXT = 16

interface RawHit {
  pattern: string
  index: number
  length: number
}

function envDeny(): string[] {
  return (process.env.RF_GUARD_DENY ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
}

// Deny substrings from RF_GUARD_DENY always apply; `deny` adds to them.
export function leakScan(text: string, deny: readonly string[] = []): LeakHit[] {
  const raw: RawHit[] = []
  for (const { name, re } of LEAK_PATTERNS) {
    for (const match of text.matchAll(re)) {
      raw.push({ pattern: name, index: match.index, length: match[0].length })
    }
  }
  for (const needle of new Set([...envDeny(), ...deny])) {
    if (needle.length === 0) continue
    for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + 1)) {
      raw.push({ pattern: 'deny', index: at, length: needle.length })
    }
  }
  raw.sort((a, b) => a.index - b.index || b.length - a.length)
  return raw.map((hit) => ({
    pattern: hit.pattern,
    index: hit.index,
    excerpt: excerptOf(text, raw, hit),
  }))
}

// One line of context with every hit inside it replaced by <pattern>.
function excerptOf(text: string, hits: readonly RawHit[], hit: RawHit): string {
  const from = Math.max(0, hit.index - EXCERPT_CONTEXT)
  const to = Math.min(text.length, hit.index + hit.length + EXCERPT_CONTEXT)
  let out = ''
  let at = from
  for (const other of hits) {
    const end = other.index + other.length
    if (end <= at || other.index >= to) continue
    out += text.slice(at, Math.max(at, other.index))
    out += `<${other.pattern}>`
    at = end
  }
  if (at < to) out += text.slice(at, to)
  return out.replace(/\s+/g, ' ')
}

export function redact(text: string, secrets: readonly string[]): string {
  // longest first, so a secret that contains another is replaced whole
  const sorted = secrets.filter((secret) => secret.length > 0).sort((a, b) => b.length - a.length)
  let out = text
  for (const secret of sorted) out = out.split(secret).join('<redacted>')
  return out
}

function lineOf(text: string, index: number): number {
  let line = 1
  for (let at = text.indexOf('\n'); at !== -1 && at < index; at = text.indexOf('\n', at + 1)) line++
  return line
}

export function checkFile(file: string, bytes: Uint8Array): GuardViolation[] {
  const violations: GuardViolation[] = []
  const name = path.basename(file)
  const ext = path.extname(file).toLowerCase()
  const underFixtures = file.startsWith('fixtures/')

  // the pinned UI logo source (ui/logo.<name>.png, sha256 in ui/logo.json) is the one binary the repository carries
  if (LOGO_SOURCE.test(file) && bytes.length <= MAX_ASSET_FILE_BYTES) return violations

  if (BINARY_EXT_SET.has(ext)) {
    violations.push({ path: file, rule: 'binary-ext', detail: ext })
  }

  const head = bytes.subarray(0, 8000)
  const nul = head.indexOf(0)
  if (nul !== -1) {
    violations.push({ path: file, rule: 'nul-byte', detail: `NUL byte at offset ${nul}` })
  }

  let decoded: string | null = null
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    violations.push({ path: file, rule: 'not-utf8', detail: 'not valid UTF-8' })
  }

  const maxBytes = file.startsWith('assets/') ? MAX_ASSET_FILE_BYTES : MAX_FILE_BYTES
  if (bytes.length > maxBytes && name !== 'package-lock.json') {
    violations.push({
      path: file,
      rule: 'too-large',
      detail: `${bytes.length} bytes > ${maxBytes}`,
    })
  }

  const placement = PLACEMENT.find((entry) => name.endsWith(entry.suffix))
  if (placement !== undefined && !placement.allowed(file)) {
    violations.push({
      path: file,
      rule: 'asset-outside-fixtures',
      detail: `${placement.suffix} must live under ${placement.where}`,
    })
  }

  if (decoded !== null && isWorldAsset(file)) violations.push(...modelerAssetViolations(file, decoded))

  if (underFixtures) {
    if (!name.endsWith('.json')) {
      violations.push({ path: file, rule: 'fixture-not-json', detail: 'not .json' })
    }
    if (bytes.length > MAX_FIXTURE_BYTES) {
      violations.push({
        path: file,
        rule: 'fixture-too-large',
        detail: `${bytes.length} bytes > ${MAX_FIXTURE_BYTES}`,
      })
    }
  }

  if (decoded !== null && !LEAK_EXEMPT.has(file)) {
    for (const hit of leakScan(decoded)) {
      violations.push({
        path: file,
        rule: 'public-leak',
        detail: `${hit.pattern} at line ${lineOf(decoded, hit.index)}: ${hit.excerpt}`,
      })
    }
  }

  return violations
}

const NODE_ID = /^[a-z][a-z0-9_]{0,47}$/

function isWorldAsset(file: string): boolean {
  return file.endsWith('.asset.json') && file.startsWith('assets/') && file.split('/').length === 3
}

// SDF Modeler reads an asset strictly: node ids and shape names are lowercase slugs (letters, digits, underscore) and
// the hash is the sha256 of its own document text. The game parser also accepts a canonicalJson hash and any id, so an
// asset written by a tool can load in the game and still be refused by the modeler's asset browser ("placed assets
// could not be found"). Assets must therefore be saved in the modeler's form.
function modelerAssetViolations(file: string, decoded: string): GuardViolation[] {
  const out: GuardViolation[] = []
  let asset: { hash?: unknown; document?: { nodes?: Record<string, { id?: unknown }>; shapes?: Record<string, unknown> } }
  try {
    asset = JSON.parse(decoded)
  } catch {
    return out
  }
  const doc = asset.document
  if (doc === null || typeof doc !== 'object') return out
  const bad = [
    ...Object.entries(doc.nodes ?? {}).flatMap(([key, n]) => [key, n?.id]),
    ...Object.keys(doc.shapes ?? {}),
  ].filter((id): id is string => typeof id === 'string' && !NODE_ID.test(id))
  if (bad.length > 0) {
    out.push({ path: file, rule: 'asset-not-modeler-valid', detail: `node ids and shape names must match ${NODE_ID}: ${[...new Set(bad)].slice(0, 3).join(', ')}` })
  }
  const hash = createHash('sha256').update(assetDocumentText(doc)).digest('hex')
  if (asset.hash !== hash) {
    out.push({ path: file, rule: 'asset-not-modeler-valid', detail: 'hash is not the sha256 of the document text SDF Modeler saves; save the asset again from SDF Modeler' })
  }
  // The modeler's text is the canonical form: any other layout (compact clips, unrounded numbers, another key order)
  // would come back as a pure formatting diff on the next modeler save, so it is refused at commit time.
  const canonical = assetFileText(asset)
  if (canonical !== decoded) {
    const a = decoded.split('\n'), b = canonical.split('\n')
    let line = 0
    while (line < a.length && a[line] === b[line]) line++
    out.push({ path: file, rule: 'asset-not-modeler-valid', detail: `text is not the canonical SDF Modeler serialization of its own content (first difference at line ${line + 1}); save the asset again from SDF Modeler or write it with assetFileText` })
  }
  return out
}

export function checkPaths(root: string, files: readonly string[]): GuardViolation[] {
  const violations: GuardViolation[] = []
  for (const file of files) {
    let bytes: Buffer
    try {
      bytes = readFileSync(path.join(root, file))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    violations.push(...checkFile(file, bytes))
  }
  return violations
}

export function trackedFiles(root: string): string[] {
  const output = execFileSync('git', ['ls-files', '-z'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  return output.split('\0').filter((file) => file.length > 0)
}

export function stagedFiles(root: string): string[] {
  const output = execFileSync(
    'git',
    ['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMR'],
    { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  )
  return output.split('\0').filter((file) => file.length > 0)
}

function repoRoot(): string {
  return execFileSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: process.cwd(),
    encoding: 'utf8',
  }).trim()
}

export function main(argv: string[]): number {
  const root = repoRoot()
  const files = argv.includes('--staged') ? stagedFiles(root) : trackedFiles(root)
  const violations = checkPaths(root, files)

  console.log(`guard: ${files.length} files checked, ${violations.length} violations`)
  for (const violation of violations) {
    console.log(`${violation.path}: ${violation.rule}: ${violation.detail}`)
  }
  return violations.length > 0 ? 1 : 0
}

function invokedDirectly(): boolean {
  if (process.argv[1] === undefined) return false
  const self = decodeURIComponent(new URL(import.meta.url).pathname)
  return path.resolve(process.argv[1]) === self
}

if (invokedDirectly()) {
  process.exitCode = main(process.argv.slice(2))
}
