import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { isRefusal } from '../../packages/sim/src/refusal.ts'
import { repoRoot } from '../bricks.ts'
import {
  FONTS_PATH,
  FONT_STORE,
  UploadEnvError,
  fetchFont,
  fileName,
  fontPath,
  fontsourceMirror,
  objectUrl,
  parseFonts,
  parseStoreTarget,
  publishCommand,
  readFonts,
  redact,
  sha256Hex,
  uploadFont,
  verifyFont,
  writeFonts,
  type FetchLike,
  type FontEntry,
  type PublishInput,
  type Put,
} from '../uiFont.ts'

const BODY = new TextEncoder().encode('ui-font-test-bytes')
const SHA = sha256Hex(BODY)
const ENV = {
  ASSET_STORE_SSH: 'deploy@store.example.invalid:/srv/assets',
  ASSET_STORE_KEY: '/keys/deploy-probe',
}

function font(overrides: Partial<FontEntry> = {}): FontEntry {
  return {
    family: 'Test',
    weight: 700,
    url: objectUrl(SHA),
    sha256: SHA,
    bytes: BODY.length,
    license: 'OFL-1.1',
    source: 'https://example.test/font.woff2',
    ...overrides,
  }
}

function registry(entries: unknown, extra: Record<string, unknown> = {}): unknown {
  return { fonts: entries, ...extra }
}

function refusedAt(json: unknown, ptr: string): void {
  assert.throws(() => parseFonts(json, FONTS_PATH), (error: unknown) => {
    assert.ok(isRefusal(error), `not a RefusalError: ${String(error)}`)
    assert.equal(error.area, 'ui-font')
    assert.equal(error.path, `${FONTS_PATH}#${ptr}`)
    assert.ok(error.message.startsWith(`[ui-font] ${FONTS_PATH}#${ptr}: `), error.message)
    return true
  })
}

function response(bytes: Uint8Array, status = 200): Awaited<ReturnType<FetchLike>> {
  return { ok: status >= 200 && status < 300, status, arrayBuffer: async () => bytes.slice().buffer as ArrayBuffer }
}

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'rf-ui-font-'))
}

function uploadRoot(entry: FontEntry): string {
  const root = tempRoot()
  mkdirSync(join(root, 'ui'), { recursive: true })
  writeFonts(root, { fonts: [entry] })
  const file = fontPath(root, entry)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, BODY)
  return root
}

function stageIn(root: string, entry: FontEntry): Put {
  const key = `objects/${entry.sha256.slice(0, 2)}/${entry.sha256}`
  const path = join(root, FONT_STORE, key)
  return async file => {
    assert.equal(file, fontPath(root, entry))
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, BODY)
    return { sha256: entry.sha256, size: BODY.length, key }
  }
}

test('the committed registry parses with a derived store URL and a pinned source', () => {
  const fonts = readFonts(repoRoot())
  assert.equal(fonts.fonts.length, 1)
  const entry = fonts.fonts[0]
  assert.equal(entry.family, 'Fredoka')
  assert.equal(entry.weight, 700)
  assert.equal(entry.license, 'OFL-1.1')
  assert.match(entry.sha256, /^[0-9a-f]{64}$/)
  assert.equal(entry.url, objectUrl(entry.sha256))
  assert.equal(entry.url, `https://assets.etcito.com/objects/${entry.sha256.slice(0, 2)}/${entry.sha256}`)
  assert.ok(Number.isInteger(entry.bytes) && entry.bytes > 0)
  assert.match(entry.source, /^https:\/\/cdn\.jsdelivr\.net\/fontsource\/fonts\/fredoka@\d+\.\d+\.\d+\/latin-700-normal\.woff2$/)
  assert.equal(entry.source.includes('@latest'), false)
  assert.equal(fileName(entry), 'fredoka-700.woff2')
})

test('objectUrl puts the first two hex characters in the path', () => {
  const sha = 'ee61b48acab42fcfee4e1c398b03bbae7e09d1be8471779c440a97dc85118c16'
  assert.equal(objectUrl(sha), `https://assets.etcito.com/objects/ee/${sha}`)
  assert.throws(() => objectUrl('nope'), (error: unknown) => isRefusal(error) && error.area === 'ui-font')
  assert.throws(() => objectUrl('EE61B48ACAB42FCFEE4E1C398B03BBAE7E09D1BE8471779C440A97DC85118C16'), (error: unknown) => isRefusal(error))
})

test('fileName slugs the family and keeps the weight', () => {
  assert.equal(fileName(font({ family: 'Open Sans' })), 'open-sans-700.woff2')
  assert.equal(fileName(font({ family: 'Fredoka', weight: 400 })), 'fredoka-400.woff2')
  assert.throws(() => fileName(font({ family: '.-' })), (error: unknown) => isRefusal(error))
})

test('a non-object registry, a missing fonts array or an extra key is refused', () => {
  refusedAt([], '')
  refusedAt(null, '')
  refusedAt({}, '/fonts')
  refusedAt({ fonts: 'x' }, '/fonts')
  refusedAt({ fonts: [] }, '/fonts')
  refusedAt(registry([font()], { version: 1 }), '/version')
})

test('a font entry must have exactly the seven keys and valid fields', () => {
  refusedAt(registry([3]), '/fonts/0')
  refusedAt(registry([{ ...font(), extra: 1 }]), '/fonts/0/extra')
  const missing = { ...font() } as Record<string, unknown>
  delete missing.license
  refusedAt(registry([missing]), '/fonts/0/license')
  refusedAt(registry([font({ family: '' })]), '/fonts/0/family')
  refusedAt(registry([font({ family: 'Fredoka/700' })]), '/fonts/0/family')
  refusedAt(registry([font({ weight: 0 })]), '/fonts/0/weight')
  refusedAt(registry([font({ weight: 700.5 })]), '/fonts/0/weight')
  refusedAt(registry([font({ weight: '700' as unknown as number })]), '/fonts/0/weight')
})

test('the sha, url, bytes, licence and source are checked', () => {
  refusedAt(registry([font({ sha256: 'abc' })]), '/fonts/0/sha256')
  refusedAt(registry([font({ url: 'https://assets.etcito.com/objects/00/x' })]), '/fonts/0/url')
  refusedAt(registry([font({ bytes: 0 })]), '/fonts/0/bytes')
  refusedAt(registry([font({ license: '' })]), '/fonts/0/license')
  refusedAt(registry([font({ source: 'http://example.test/f.woff2' })]), '/fonts/0/source')
  refusedAt(registry([font({ source: 'https://cdn.jsdelivr.net/fontsource/fonts/fredoka@latest/latin-700-normal.woff2' })]), '/fonts/0/source')
})

test('a duplicate family and weight is refused', () => {
  refusedAt(registry([font(), font()]), '/fonts/1/family')
  parseFonts(registry([font(), font({ weight: 400 })]), FONTS_PATH)
})

test('fontsourceMirror names the npm tarball and the file inside it', () => {
  const mirror = fontsourceMirror('https://cdn.jsdelivr.net/fontsource/fonts/fredoka@5.3.0/latin-700-normal.woff2')
  assert.deepEqual(mirror, {
    url: 'https://registry.npmjs.org/@fontsource/fredoka/-/fredoka-5.3.0.tgz',
    path: 'package/files/fredoka-latin-700-normal.woff2',
  })
  assert.equal(fontsourceMirror('https://example.test/f.woff2'), null)
})

test('fetchFont writes verified bytes and reuses a verified local file', async () => {
  const root = tempRoot()
  try {
    const entry = font()
    const lines: string[] = []
    const file = await fetchFont(root, entry, async () => response(BODY), line => lines.push(line))
    assert.equal(file, fontPath(root, entry))
    assert.deepEqual(new Uint8Array(readFileSync(file)), BODY)
    assert.ok(lines.some(line => line.startsWith('PASS font fetch')))
    const offline: FetchLike = async () => { throw new Error('offline') }
    const again = await fetchFont(root, entry, offline, line => lines.push(line))
    assert.equal(again, file)
    assert.ok(lines.some(line => line.endsWith('(cached)')))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('fetchFont refuses a sha256 or byte-length mismatch and writes nothing', async () => {
  const root = tempRoot()
  try {
    const wrong = font({ sha256: '0'.repeat(64), url: objectUrl('0'.repeat(64)) })
    await assert.rejects(fetchFont(root, wrong, async () => response(BODY)), (error: unknown) => isRefusal(error) && /sha256 mismatch/.test(error.reason))
    const short = font({ bytes: BODY.length + 1 })
    await assert.rejects(fetchFont(root, short, async () => response(BODY)), (error: unknown) => isRefusal(error) && /byte length mismatch/.test(error.reason))
    assert.throws(() => readFileSync(fontPath(root, wrong)), /ENOENT/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('upload refuses without ASSET_STORE_SSH and ASSET_STORE_KEY', async () => {
  const root = tempRoot()
  try {
    for (const env of [{}, { ASSET_STORE_SSH: ENV.ASSET_STORE_SSH }, { ASSET_STORE_KEY: ENV.ASSET_STORE_KEY }]) {
      await assert.rejects(uploadFont(root, font(), { env }), (error: unknown) => {
        assert.ok(error instanceof UploadEnvError)
        assert.equal(error.message, 'uiFont: upload needs ASSET_STORE_SSH and ASSET_STORE_KEY')
        return true
      })
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('upload stages, publishes, verifies and records the object', async () => {
  const root = uploadRoot(font())
  try {
    const seen: PublishInput[] = []
    let gets = 0
    const get: FetchLike = async url => {
      assert.equal(url, objectUrl(SHA))
      gets++
      return gets === 1 ? response(new Uint8Array(0), 404) : response(BODY)
    }
    const lines: string[] = []
    await uploadFont(root, font(), {
      env: ENV,
      get,
      stage: stageIn(root, font()),
      publish: async input => { seen.push(input) },
      log: line => lines.push(line),
    })
    assert.equal(gets, 2)
    assert.equal(seen.length, 1)
    assert.equal(seen[0].ssh, 'deploy@store.example.invalid')
    assert.equal(seen[0].root, '/srv/assets')
    assert.equal(seen[0].keyFile, '/keys/deploy-probe')
    assert.equal(seen[0].sha256, SHA)
    assert.deepEqual(new Uint8Array(seen[0].bytes), BODY)
    assert.ok(lines.some(line => line.includes('published')))
    const entry = readFonts(root).fonts[0]
    assert.equal(entry.url, objectUrl(SHA))
    assert.equal(entry.sha256, SHA)
    assert.equal(entry.bytes, BODY.length)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('upload skips publishing when the store already has the object', async () => {
  const root = uploadRoot(font())
  try {
    const lines: string[] = []
    await uploadFont(root, font(), {
      env: ENV,
      get: async () => response(BODY),
      stage: stageIn(root, font()),
      publish: async () => { throw new Error('publish must be skipped') },
      log: line => lines.push(line),
    })
    assert.ok(lines.some(line => line.includes('already in the store')))
    assert.ok(lines.some(line => line.startsWith('PASS font verify')))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('upload refuses when raa-assets staged a different object', async () => {
  const root = uploadRoot(font())
  try {
    const wrong: Put = async () => ({ sha256: '0'.repeat(64), size: BODY.length, key: `objects/00/${'0'.repeat(64)}` })
    await assert.rejects(uploadFont(root, font(), { env: ENV, get: async () => response(new Uint8Array(0), 404), stage: wrong }), (error: unknown) => isRefusal(error) && /staged/.test(error.reason))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('parseStoreTarget splits the scp-form user, host and store root', () => {
  assert.deepEqual(parseStoreTarget('deploy@store.example.invalid:/srv/assets/'), { target: 'deploy@store.example.invalid', root: '/srv/assets' })
  assert.deepEqual(parseStoreTarget('deploy@[2001:db8::1]:/srv'), { target: 'deploy@[2001:db8::1]', root: '/srv' })
  assert.deepEqual(parseStoreTarget('deploy@store.example.invalid:/'), { target: 'deploy@store.example.invalid', root: '/' })
  for (const bad of ['store.example.invalid:/srv', 'deploy@store.example.invalid', 'deploy@store.example.invalid:relative', 'ssh://deploy@store.example.invalid/srv']) {
    assert.throws(() => parseStoreTarget(bad), (error: unknown) => isRefusal(error) && error.area === 'ui-font')
  }
})

test('publishCommand creates the shard, writes a temp object and renames it', () => {
  const shard = SHA.slice(0, 2)
  assert.equal(
    publishCommand({ target: 'deploy@store.example.invalid', root: '/srv/assets' }, SHA, 42),
    `mkdir -p '/srv/assets/objects/${shard}' && cat > '/srv/assets/objects/${shard}/${SHA}.tmp-42' && mv '/srv/assets/objects/${shard}/${SHA}.tmp-42' '/srv/assets/objects/${shard}/${SHA}'`,
  )
  assert.equal(
    publishCommand({ target: 'deploy@store.example.invalid', root: '/' }, SHA, 7),
    `mkdir -p '/objects/${shard}' && cat > '/objects/${shard}/${SHA}.tmp-7' && mv '/objects/${shard}/${SHA}.tmp-7' '/objects/${shard}/${SHA}'`,
  )
})

test('verifyFont GETs the store URL and checks sha256 and byte length', async () => {
  const entry = font()
  const lines: string[] = []
  await verifyFont(entry, async url => {
    assert.equal(url, entry.url)
    return response(BODY)
  }, line => lines.push(line))
  assert.ok(lines.some(line => line.startsWith('PASS font verify')))
  await assert.rejects(verifyFont(entry, async () => response(new TextEncoder().encode('other'))), (error: unknown) => isRefusal(error) && /sha256 mismatch/.test(error.reason))
  await assert.rejects(verifyFont(entry, async () => response(new Uint8Array(0), 404)), (error: unknown) => isRefusal(error) && /HTTP 404/.test(error.reason))
})

test('redact hides the asset-store credentials and the store root', () => {
  const out = redact('deploy@store.example.invalid:/srv/assets deploy@store.example.invalid /srv/assets store.example.invalid /keys/deploy-probe deploy-probe', ENV)
  for (const secret of ['deploy@store.example.invalid', '/srv/assets', 'store.example.invalid', '/keys/deploy-probe', 'deploy-probe']) {
    assert.equal(out.includes(secret), false, `leaked ${secret}: ${out}`)
  }
})
