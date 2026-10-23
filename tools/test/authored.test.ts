import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { isRefusal } from '../../packages/sim/src/refusal.ts'
import { AUTHORED_PATH, isAuthored, parseAuthored, readAuthored } from '../authored.ts'
import { repoRoot } from '../bricks.ts'

const registry = (files: unknown, extra: Record<string, unknown> = {}): unknown =>
  ({ format: 'royal-fiesta.authored', version: 1, files, ...extra })

// The refusal names the exact field: the pointer is followed by ': '.
function refusedAt(json: unknown, ptr: string): void {
  assert.throws(() => parseAuthored(json, AUTHORED_PATH), (e: unknown) => {
    assert.ok(isRefusal(e), `not a RefusalError: ${String(e)}`)
    assert.equal(e.area, 'authored')
    assert.equal(e.path, `${AUTHORED_PATH}#${ptr}`)
    assert.ok(e.message.startsWith(`[authored] ${AUTHORED_PATH}#${ptr}: `), e.message)
    assert.match(e.reason, /; [^;]+$/)
    return true
  })
}

test('the committed registry parses', () => {
  const a = readAuthored(repoRoot())
  assert.ok(Array.isArray(a.files))
})

test('a sorted registry with one asset and one course parses', () => {
  const files = ['assets/common/penguin.body.asset.json', 'courses/race-hammer-hill.course.json']
  const a = parseAuthored(registry(files), AUTHORED_PATH)
  assert.deepEqual(a.files, files)
  assert.equal(isAuthored(a, 'courses/race-hammer-hill.course.json'), true)
  assert.equal(isAuthored(a, 'courses/podium.course.json'), false)
  assert.equal(isAuthored(a, 'courses/race-hammer-hill.course'), false)
})

test('a non-object top level is refused', () => {
  refusedAt([], '')
  refusedAt(null, '')
})

test('an unknown top key is refused', () => {
  refusedAt(registry([], { extra: 1 }), '/extra')
})

test('a wrong format is refused', () => {
  refusedAt({ format: 'royal-fiesta.registry', version: 1, files: [] }, '/format')
})

test('a wrong version is refused', () => {
  refusedAt({ format: 'royal-fiesta.authored', version: 2, files: [] }, '/version')
})

test('files that are not an array of strings are refused', () => {
  refusedAt(registry('courses/a.course.json'), '/files')
  refusedAt(registry(['courses/a.course.json', 3]), '/files/1')
})

test('a path outside the two forms is refused', () => {
  refusedAt(registry(['assets/mars/x.y.asset.json']), '/files/0')
  refusedAt(registry(['courses/a.course.json', 'fixtures/courses/a.course.json']), '/files/1')
  refusedAt(registry(['courses/A.course.json']), '/files/0')
  refusedAt(registry(['assets/candy/Candy.x.asset.json']), '/files/0')
  refusedAt(registry(['assets/candy/sub/candy.x.asset.json']), '/files/0')
})

test('a duplicate entry is refused, naming the first index', () => {
  const dup = registry(['courses/a.course.json', 'courses/b.course.json', 'courses/a.course.json'])
  refusedAt(dup, '/files/2')
  assert.throws(() => parseAuthored(dup, AUTHORED_PATH), /duplicates entry 0/)
})

test('an unsorted pair is refused', () => {
  refusedAt(registry(['courses/b.course.json', 'courses/a.course.json']), '/files/1')
})

test('a missing registry is refused, never an empty default', () => {
  assert.throws(() => readAuthored('/nonexistent-royal-fiesta-root'), (e: unknown) => isRefusal(e) && e.path === AUTHORED_PATH)
})

test('invalid JSON is refused with the file path', () => {
  const root = mkdtempSync(join(tmpdir(), 'rf-authored-'))
  try {
    mkdirSync(join(root, 'tools'))
    writeFileSync(join(root, AUTHORED_PATH), '{"format": ')
    assert.throws(() => readAuthored(root), (e: unknown) =>
      isRefusal(e) && e.message.startsWith(`[authored] ${AUTHORED_PATH}: invalid JSON `) && e.message.endsWith('; fix the file syntax'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
