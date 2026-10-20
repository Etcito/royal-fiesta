import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'

export type GuardRule =
  | 'binary-ext'
  | 'nul-byte'
  | 'not-utf8'
  | 'too-large'
  | 'asset-outside-fixtures'
  | 'fixture-not-json'
  | 'fixture-too-large'

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
  '.woff', '.woff2', '.pdf',
]

export const MAX_FILE_BYTES = 262144
export const MAX_FIXTURE_BYTES = 65536

const BINARY_EXT_SET = new Set(BINARY_EXTS)
const ASSET_SUFFIXES = ['.prims.json', '.course.json', '.manifest.json']

export function checkFile(file: string, bytes: Uint8Array): GuardViolation[] {
  const violations: GuardViolation[] = []
  const name = path.basename(file)
  const ext = path.extname(file).toLowerCase()
  const underFixtures = file.startsWith('fixtures/')

  if (BINARY_EXT_SET.has(ext)) {
    violations.push({ path: file, rule: 'binary-ext', detail: ext })
  }

  const head = bytes.subarray(0, 8000)
  const nul = head.indexOf(0)
  if (nul !== -1) {
    violations.push({ path: file, rule: 'nul-byte', detail: `NUL byte at offset ${nul}` })
  }

  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    violations.push({ path: file, rule: 'not-utf8', detail: 'not valid UTF-8' })
  }

  if (bytes.length > MAX_FILE_BYTES && name !== 'package-lock.json') {
    violations.push({
      path: file,
      rule: 'too-large',
      detail: `${bytes.length} bytes > ${MAX_FILE_BYTES}`,
    })
  }

  if (!underFixtures && ASSET_SUFFIXES.some((suffix) => name.endsWith(suffix))) {
    violations.push({
      path: file,
      rule: 'asset-outside-fixtures',
      detail: 'asset JSON must live under fixtures/',
    })
  }

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

  return violations
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
