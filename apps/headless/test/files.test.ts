import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdir } from 'node:fs/promises'
import { isRefusal, RefusalError } from '@royal-fiesta/sim/refusal'
import { loadAllCourses, loadCourseFile, readRepoText, repoPath } from '../src/files.ts'

test('repoPath refuses paths that escape the repository', () => {
  assert.throws(() => repoPath('../outside'), RefusalError)
  assert.throws(() => repoPath('/etc/passwd'), RefusalError)
})

test('repoPath resolves repo-relative paths', () => {
  assert.match(repoPath('fixtures'), /[\\/]fixtures$/)
})

test('readRepoText refuses a missing file', async () => {
  await assert.rejects(readRepoText('fixtures/no-such-file.json'), RefusalError)
})

test('loadCourseFile loads the gallery and caches it', async () => {
  const p = 'fixtures/courses/obstacle-gallery.course.json'
  const a = await loadCourseFile(p)
  assert.equal(a.kind, 'gallery')
  assert.equal(await loadCourseFile(p), a)
})

test('loadAllCourses is sorted by id and skips invalid/', async () => {
  const all = await loadAllCourses()
  const ids = all.map(c => c.id)
  assert.ok(ids.includes('obstacle-gallery'))
  assert.deepEqual(ids, [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)))
  const invalid = (await readdir(repoPath('fixtures/courses/invalid'))).map(f => f.replace(/\.course\.json$/, ''))
  for (const id of invalid) assert.ok(!ids.includes(id), id)
})

test('loadCourseFile refuses every invalid course', async () => {
  const files = (await readdir(repoPath('fixtures/courses/invalid'))).filter(f => f.endsWith('.course.json')).sort()
  assert.ok(files.length >= 4)
  for (const f of files) {
    await assert.rejects(loadCourseFile(`fixtures/courses/invalid/${f}`), e => isRefusal(e), f)
  }
})
