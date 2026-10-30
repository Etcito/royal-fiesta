import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  BINARY_EXTS,
  MAX_ASSET_FILE_BYTES,
  MAX_FILE_BYTES,
  MAX_FIXTURE_BYTES,
  checkFile,
  checkPaths,
  leakScan,
  main,
  redact,
  trackedFiles,
} from '../guard.ts'

const text = (value: string): Uint8Array => new TextEncoder().encode(value)
const rules = (file: string, bytes: Uint8Array): string[] =>
  checkFile(file, bytes).map((violation) => violation.rule)

test('binary extensions are refused case-insensitively', () => {
  assert.deepEqual(rules('x/a.PNG', text('image')), ['binary-ext'])
})

test('NUL bytes are scanned only in the first 8000 bytes', () => {
  const early = new Uint8Array(11).fill(0x61)
  early[10] = 0
  assert.deepEqual(rules('notes.txt', early), ['nul-byte'])

  const late = new Uint8Array(9001).fill(0x61)
  late[9000] = 0
  assert.deepEqual(rules('notes.txt', late), [])
})

test('invalid UTF-8 is refused', () => {
  assert.deepEqual(rules('notes.txt', Uint8Array.of(0xff, 0xfe, 0x41)), ['not-utf8'])
})

test('files over 256 KiB are refused, package-lock.json is exempt', () => {
  const big = new Uint8Array(MAX_FILE_BYTES + 1).fill(0x61)
  assert.deepEqual(rules('src/big.ts', big), ['too-large'])
  assert.deepEqual(rules('package-lock.json', big), [])
})

test('asset JSON must live under fixtures/', () => {
  assert.deepEqual(rules('src/a.course.json', text('{}')), ['asset-outside-fixtures'])
  assert.deepEqual(rules('src/x.prims.json', text('{}')), ['asset-outside-fixtures'])
  assert.deepEqual(rules('fixtures/courses/a.course.json', text('{}')), [])
})

test('fixtures are small JSON only', () => {
  assert.deepEqual(rules('fixtures/readme.txt', text('hello')), ['fixture-not-json'])
  const json = text(`{"data":"${'a'.repeat(MAX_FIXTURE_BYTES - 10)}"}`)
  assert.equal(json.length, MAX_FIXTURE_BYTES + 1)
  assert.deepEqual(rules('fixtures/golden/x.json', json), ['fixture-too-large'])
})

test('every matching rule is reported', () => {
  const big = new Uint8Array(MAX_ASSET_FILE_BYTES + 1).fill(0x80)
  big[0] = 0
  assert.deepEqual(rules('assets/big.png', big), [
    'binary-ext',
    'nul-byte',
    'not-utf8',
    'too-large',
  ])
  assert.deepEqual(rules('assets/big.prims.json', big), [
    'nul-byte',
    'not-utf8',
    'too-large',
    'asset-outside-fixtures',
  ])
})

test('binary extension list includes common formats and is lower-case', () => {
  assert.ok(BINARY_EXTS.includes('.glb'))
  assert.ok(BINARY_EXTS.includes('.wasm'))
  assert.ok(BINARY_EXTS.includes('.woff2'))
  assert.ok(BINARY_EXTS.includes('.mesh'))
  assert.ok(BINARY_EXTS.every((ext) => ext === ext.toLowerCase()))
})

test('saved .mesh files are refused as binary', () => {
  assert.deepEqual(rules('assets/candy/candy.penguin.mesh', text('mesh')), ['binary-ext'])
})

test('.haa.json is only allowed under audio/ or fixtures/', () => {
  assert.deepEqual(rules('audio/fiesta.haa.json', text('{}')), [])
  assert.deepEqual(rules('fixtures/audio/fiesta.haa.json', text('{}')), [])
  for (const file of [
    'src/fiesta.haa.json',
    'assets/candy/fiesta.haa.json',
    'courses/fiesta.haa.json',
  ]) {
    assert.deepEqual(rules(file, text('{}')), ['asset-outside-fixtures'], file)
  }
})

test('checkPaths skips files that are gone from disk', () => {
  const root = path.resolve(import.meta.dirname, '../..')
  assert.deepEqual(checkPaths(root, ['fixtures/does-not-exist.json']), [])
})

test('the tracked tree passes the guard and main reports success', () => {
  const testDir = path.dirname(fileURLToPath(import.meta.url))
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: testDir,
    encoding: 'utf8',
  }).trim()
  assert.deepEqual(checkPaths(root, trackedFiles(root)), [])
  assert.equal(main([]), 0)
})

test('a clean small source file has no violations', () => {
  assert.deepEqual(rules('src/a.ts', text('export const value = 1\n')), [])
})

// Token-shaped strings are assembled at run time so no scanner sees a whole one in the source.
const ghToken = 'gh' + 'p_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'
const FAMILIES: readonly { pattern: string; secret: string }[] = [
  { pattern: 'home-path', secret: '/ho' + 'me/someone/' },
  { pattern: 'home-path', secret: '/ro' + 'ot/' },
  { pattern: 'home-path', secret: '/Us' + 'ers/someone/' },
  { pattern: 'home-path', secret: 'C:' + '\\Us' + 'ers\\' },
  { pattern: 'private-ipv4', secret: '10.' + '1.2.3' },
  { pattern: 'private-ipv4', secret: '172.' + '20.4.5' },
  { pattern: 'private-ipv4', secret: '192.' + '168.0.12' },
  { pattern: 'internal-host', secret: 'build.' + 'internal' },
  { pattern: 'internal-host', secret: 'git.' + 'corp' },
  { pattern: 'internal-host', secret: 'nas.' + 'lan' },
  { pattern: 'internal-host', secret: 'printer.' + 'local' },
  { pattern: 'internal-host', secret: 'wiki.team.' + 'intranet' },
  { pattern: 'github-token', secret: ghToken },
  { pattern: 'github-token', secret: 'gh' + 'o_' + 'Z'.repeat(20) },
  { pattern: 'github-token', secret: 'gh' + 's_' + '0'.repeat(24) },
  { pattern: 'github-token', secret: 'gh' + 'u_' + 'x9'.repeat(12) },
  { pattern: 'github-token', secret: 'github' + '_pat_' + '11AB_'.repeat(6) },
  {
    pattern: 'private-key',
    secret:
      '-----BEGIN RSA ' + 'PRIVATE KEY-----\nMIIEkeymaterial\n' +
      '-----END RSA ' + 'PRIVATE KEY-----',
  },
  { pattern: 'aws-key', secret: 'AK' + 'IA' + 'ABCDEFGHIJ123456' },
  { pattern: 'aws-key', secret: 'AS' + 'IA' + '0123456789ABCDEF' },
  { pattern: 'slack-token', secret: 'xo' + 'xb-' + '1234567890-abcdef' },
]

test('every leak pattern family hits, with the match masked in the excerpt', () => {
  for (const { pattern, secret } of FAMILIES) {
    const sample = `see ${secret} here`
    const hits = leakScan(sample)
    assert.deepEqual(
      hits.map((hit) => [hit.pattern, hit.index]),
      [[pattern, 4]],
      `${pattern}: ${JSON.stringify(sample)}`,
    )
    assert.equal(hits[0]!.excerpt, `see <${pattern}> here`)
    assert.ok(!hits[0]!.excerpt.includes(secret))
  }
})

test('leak patterns stay quiet on ordinary code and loopback addresses', () => {
  const clean = [
    'hub.update(flow.hub.state(this.local), k)',
    'http://127.0.0.1:5173/game.html and 0.0.0.0',
    'version 1.10.0.1.5 and 172.32.0.1 and 11.0.0.1',
    'src/home/user/a.ts, https://example.com/root/x',
    'x.local.example.com and foo.localhost',
    'gh' + 'p_short and AK' + 'IAshort',
  ]
  for (const sample of clean) assert.deepEqual(leakScan(sample), [], sample)
})

test('RF_GUARD_DENY substrings hit and are never printed', () => {
  const saved = process.env.RF_GUARD_DENY
  const first = 'deny' + '-alpha'
  const second = 'deny' + '-beta'
  process.env.RF_GUARD_DENY = `${first}, ,${second}`
  try {
    const sample = `one ${first} two ${second} three ${first}`
    assert.deepEqual(
      leakScan(sample).map((hit) => [hit.pattern, hit.index]),
      [['deny', 4], ['deny', 19], ['deny', 35]],
    )
    const violations = checkFile('docs/notes.md', text(sample))
    assert.deepEqual(
      violations.map((violation) => violation.rule),
      ['public-leak', 'public-leak', 'public-leak'],
    )
    for (const violation of violations) {
      assert.ok(!violation.detail.includes(first), violation.detail)
      assert.ok(!violation.detail.includes(second), violation.detail)
      assert.match(violation.detail, /^deny at line 1: /)
    }
  } finally {
    if (saved === undefined) delete process.env.RF_GUARD_DENY
    else process.env.RF_GUARD_DENY = saved
  }
  assert.deepEqual(leakScan('extra-term here', ['extra-term']).map((hit) => hit.pattern), ['deny'])
})

test('public-leak reports the line and masks the match', () => {
  const violations = checkFile('docs/notes.md', text(`line one\ntoken ${ghToken} end\n`))
  assert.deepEqual(violations, [
    {
      path: 'docs/notes.md',
      rule: 'public-leak',
      detail: 'github-token at line 2: line one token <github-token> end ',
    },
  ])
})

test('the guard files are exempt from public-leak through checkFile', () => {
  const secrets = FAMILIES.map((family) => family.secret).join('\n')
  const sample = text(`const a = '${ghToken}'\n${secrets}\n`)
  assert.deepEqual(rules('tools/guard.ts', sample), [])
  assert.deepEqual(rules('tools/test/guard.test.ts', sample), [])
  assert.ok(rules('tools/other.ts', sample).every((rule) => rule === 'public-leak'))
  assert.ok(rules('tools/other.ts', sample).length >= FAMILIES.length)
})

test('redact replaces every non-empty secret and ignores empty strings', () => {
  const secrets = ['', ghToken, 'tok', 'tok-long']
  assert.equal(
    redact(`a ${ghToken} b tok c tok-long d ${ghToken}`, secrets),
    'a <redacted> b <redacted> c <redacted> d <redacted>',
  )
  assert.equal(redact('unchanged', ['']), 'unchanged')
  assert.deepEqual(leakScan(redact(`x ${ghToken}`, [ghToken])), [])
})

test('placement follows the v1 data layout', () => {
  for (const file of [
    'courses/a.course.json',
    'fixtures/courses/a.course.json',
    'assets/candy/candy.a.asset.json',
    'assets/common/penguin.body.asset.json',
    'fixtures/game-assets/invalid/a.asset.json',
    'ui/a.ui.json',
    'fixtures/assets/a.prims.json',
    'fixtures/a.manifest.json',
  ]) {
    assert.deepEqual(rules(file, text('{}')), [], file)
  }
  for (const file of [
    'assets/a.asset.json',
    'assets/x/y/a.asset.json',
    'assets/lava/a.asset.json',
    'assets/candy/x/a.asset.json',
    'src/a.course.json',
    'src/a.ui.json',
    'courses/a.prims.json',
    'assets/candy/a.manifest.json',
  ]) {
    assert.deepEqual(rules(file, text('{}')), ['asset-outside-fixtures'], file)
  }
})

test('a world asset must be in the form SDF Modeler reads: slug ids and its own document hash', () => {
  const asset = (nodeId: string, hash: string): Uint8Array =>
    text(JSON.stringify({ hash, document: { nodes: { [nodeId]: { id: nodeId, kind: 'group' } } } }))
  assert.deepEqual(rules('assets/ice/ice.x.asset.json', asset('floe-main', 'x')), ['asset-not-modeler-valid', 'asset-not-modeler-valid'])
  assert.deepEqual(rules('assets/ice/ice.x.asset.json', asset('floe_main', 'x')), ['asset-not-modeler-valid'])
  assert.deepEqual(rules('fixtures/game-assets/invalid/x.asset.json', asset('floe-main', 'x')), [])
})

test('files under assets/ have the larger size cap', () => {
  const million = new Uint8Array(1000000).fill(0x61)
  assert.deepEqual(rules('assets/candy/candy.big.asset.json', million), [])
  assert.deepEqual(rules('src/big.json', million), ['too-large'])
  assert.deepEqual(rules('courses/big.course.json', million), ['too-large'])
  const over = new Uint8Array(MAX_ASSET_FILE_BYTES + 1).fill(0x61)
  assert.deepEqual(rules('assets/candy/candy.big.asset.json', over), ['too-large'])
})
