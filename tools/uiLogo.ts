import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import sharp from 'sharp'
import { objectUrl } from '../packages/game/src/assets.ts'
import { repoRoot } from './bricks.ts'

export const LOGO_STORE = 'out/ui-store'
export const LOGO_BUNDLE = 'apps/web/public/images'
export interface Logo { asset: string; format: 'png' | 'svg'; sha256: string; bytes: number; width: number; height: number }
export const AVIF_OPTIONS = { quality: 85, effort: 4, chromaSubsampling: '4:4:4', bitdepth: 8 } as const

export function readLogo(root: string): Logo {
  const logo = JSON.parse(readFileSync(join(root, 'ui/logo.json'), 'utf8')) as Logo
  if (logo.asset !== 'logo.crown' || !['png', 'svg'].includes(logo.format) || !/^[a-f0-9]{64}$/.test(logo.sha256)
    || ![logo.bytes, logo.width, logo.height].every(n => Number.isSafeInteger(n) && n > 0)) {
    throw new Error('ui-logo: invalid ui/logo.json registry')
  }
  return logo
}

export function logoObjectKey(logo: Logo): string {
  return `objects/${logo.sha256.slice(0, 2)}/${logo.sha256}`
}

export function verifyLogo(bytes: Uint8Array, logo: Logo): void {
  if (bytes.length !== logo.bytes || createHash('sha256').update(bytes).digest('hex') !== logo.sha256) {
    throw new Error('ui-logo: source does not match the sha256 and size in ui/logo.json')
  }
  if (logo.format === 'svg') {
    if (!/<svg(?:\s|>)/.test(new TextDecoder().decode(bytes))) throw new Error('ui-logo: source is not SVG')
    return
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (bytes.length < 24 || view.getUint32(0) !== 0x89504e47 || view.getUint32(4) !== 0x0d0a1a0a
    || view.getUint32(16) !== logo.width || view.getUint32(20) !== logo.height) {
    throw new Error('ui-logo: PNG dimensions do not match ui/logo.json')
  }
}

function write(file: string, bytes: Uint8Array): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, bytes)
}

// Before publication, stage the original bytes at the same object key the store will use.
export function stageLogo(root: string, source: string): string {
  const logo = readLogo(root)
  const bytes = readFileSync(source)
  verifyLogo(bytes, logo)
  const file = join(root, LOGO_STORE, logoObjectKey(logo))
  write(file, bytes)
  return file
}

export async function bundleLogo(root: string, get: typeof fetch = fetch): Promise<string> {
  const logo = readLogo(root)
  const destination = join(root, LOGO_BUNDLE, `${logo.sha256}.${logo.format}`)
  let bytes: Uint8Array | undefined
  for (const file of [join(root, LOGO_STORE, logoObjectKey(logo)), destination]) {
    try { bytes = readFileSync(file) } catch { continue }
    verifyLogo(bytes, logo)
    break
  }
  if (bytes === undefined) {
    const response = await get(objectUrl(logo.sha256), { signal: AbortSignal.timeout(20000) })
    if (!response.ok) throw new Error(`ui-logo: asset store answered HTTP ${response.status}; publish the logo or stage it with tools/uiLogo.ts stage <file>`)
    bytes = new Uint8Array(await response.arrayBuffer())
    verifyLogo(bytes, logo)
    write(join(root, LOGO_STORE, logoObjectKey(logo)), bytes)
  }
  write(destination, bytes)
  const image = sharp(bytes)
  const metadata = await image.metadata()
  if (metadata.width !== logo.width || metadata.height !== logo.height) throw new Error('ui-logo: source dimensions do not match ui/logo.json')
  const avif = await image.avif(AVIF_OPTIONS).toBuffer()
  const avifFile = join(root, LOGO_BUNDLE, `${logo.sha256}.avif`)
  write(avifFile, avif)
  const avifSha256 = createHash('sha256').update(avif).digest('hex')
  write(join(root, LOGO_STORE, `objects/${avifSha256.slice(0, 2)}/${avifSha256}`), avif)
  write(join(root, LOGO_BUNDLE, 'logo-build.json'), new TextEncoder().encode(JSON.stringify({
    source: { sha256: logo.sha256, bytes: bytes.length, format: logo.format },
    avif: { sha256: avifSha256, bytes: avif.length, ...AVIF_OPTIONS },
    encoder: { sharp: sharp.versions.sharp, vips: sharp.versions.vips, aom: sharp.versions.aom },
  }, null, 2) + '\n'))
  return logo.format === 'svg' ? destination : avifFile
}

async function main(args: string[]): Promise<void> {
  const root = repoRoot()
  if (args[0] === 'stage' && args.length === 2) stageLogo(root, args[1])
  else if (args.length !== 0 && !(args[0] === 'bundle' && args.length === 1)) {
    throw new Error('usage: node --experimental-strip-types tools/uiLogo.ts [bundle|stage <file>]')
  }
  await bundleLogo(root)
  console.log(`ui-logo: verified source ${readLogo(root).sha256}`)
  console.log(readFileSync(join(root, LOGO_BUNDLE, 'logo-build.json'), 'utf8').trim())
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1 })
}
