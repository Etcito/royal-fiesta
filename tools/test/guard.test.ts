import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  BINARY_EXTS,
  MAX_FILE_BYTES,
  MAX_FIXTURE_BYTES,
  checkFile,
  checkPaths,
  main,
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
  assert.deepEqual(rules('courses/a.course.json', text('{}')), ['asset-outside-fixtures'])
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
  const big = new Uint8Array(MAX_FILE_BYTES + 1).fill(0x80)
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
  assert.ok(BINARY_EXTS.every((ext) => ext === ext.toLowerCase()))
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
