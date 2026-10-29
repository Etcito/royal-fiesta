import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import sharp from 'sharp'
import { bundleLogo, LOGO_BUNDLE, LOGO_STORE, logoObjectKey, stageLogo, type Logo } from '../uiLogo.ts'

const bytes = await sharp({ create: { width: 16, height: 8, channels: 4, background: { r: 255, g: 0, b: 128, alpha: 0.5 } } }).png().toBuffer()
const logo: Logo = { asset: 'logo.crown', format: 'png', sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, width: 16, height: 8 }

async function temporary(run: (root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'rf-ui-logo-'))
  try {
    mkdirSync(join(root, 'ui'))
    writeFileSync(join(root, 'ui/logo.json'), JSON.stringify(logo))
    await run(root)
  } finally { rmSync(root, { recursive: true, force: true }) }
}

test('staged logo bundles without network and waits at its publication object key', () => temporary(async root => {
  const source = join(root, 'source.png')
  writeFileSync(source, bytes)
  assert.equal(stageLogo(root, source), join(root, LOGO_STORE, logoObjectKey(logo)))
  const output = await bundleLogo(root, async () => { throw new Error('unexpected network') })
  assert.equal(output, join(root, LOGO_BUNDLE, `${logo.sha256}.avif`))
  const decoded = await sharp(output).raw().toBuffer({ resolveWithObject: true })
  assert.equal(decoded.info.width, 16)
  assert.equal(decoded.info.height, 8)
  assert.equal(decoded.info.channels, 4)
  assert.ok(Math.abs(decoded.data[3] - 128) <= 1, 'AVIF preserves alpha')
  const sourceBundle = join(root, LOGO_BUNDLE, `${logo.sha256}.png`)
  assert.deepEqual(readFileSync(sourceBundle), bytes)
  writeFileSync(sourceBundle, 'corrupt bundle')
  await bundleLogo(root, async () => { throw new Error('unexpected network') })
  assert.deepEqual(readFileSync(sourceBundle), bytes)
}))

test('a fresh build fetches the pinned object and refuses wrong bytes', () => temporary(async root => {
  await assert.rejects(bundleLogo(root, async () => new Response('wrong image')), /sha256 and size/)
  await bundleLogo(root, async url => {
    assert.equal(url, `https://assets.etcito.com/${logoObjectKey(logo)}`)
    return new Response(bytes)
  })
  assert.deepEqual(readFileSync(join(root, LOGO_STORE, logoObjectKey(logo))), bytes)
}))

test('staging refuses an unregistered image', () => temporary(async root => {
  const source = join(root, 'source.png')
  writeFileSync(source, Buffer.alloc(bytes.length))
  assert.throws(() => stageLogo(root, source), /sha256 and size/)
}))

test('SVG can be staged and delivered directly while the build also produces AVIF', () => temporary(async root => {
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="8"><circle cx="8" cy="4" r="3" fill="gold"/></svg>')
  const vector: Logo = { ...logo, format: 'svg', sha256: createHash('sha256').update(svg).digest('hex'), bytes: svg.length }
  writeFileSync(join(root, 'ui/logo.json'), JSON.stringify(vector))
  const source = join(root, 'source.svg')
  writeFileSync(source, svg)
  stageLogo(root, source)
  assert.equal(await bundleLogo(root), join(root, LOGO_BUNDLE, `${vector.sha256}.svg`))
  assert.deepEqual(readFileSync(join(root, LOGO_BUNDLE, `${vector.sha256}.svg`)), svg)
  assert.equal((await sharp(join(root, LOGO_BUNDLE, `${vector.sha256}.avif`)).metadata()).hasAlpha, true)
}))
