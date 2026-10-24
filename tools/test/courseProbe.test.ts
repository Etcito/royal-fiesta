import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initRapier } from '@gamesaloon/rollback-rapier'
import type { CourseV1, DecorItem } from '../../packages/game/src/courseV1.ts'
import { nodeGameAssets } from '../../apps/headless/src/contentFiles.ts'
import { decorProblems, generatedCourse, loadAuthoredCourse, playSprint, simDiff } from '../courseProbe.ts'

const item = (n: number, asset: string, t: [number, number, number]): DecorItem =>
  ({ id: `d-${n}`, asset, t, r: [0, 0, 0, 1], s: [1, 1, 1] })
const withDecor = (c: CourseV1, decor: DecorItem[]): CourseV1 => ({ ...c, decor })

// Far from the track: high and to the side, with the slime pool below the floor top.
function dressing(): DecorItem[] {
  const d: DecorItem[] = []
  const add = (asset: string, n: number, y: number) => {
    for (let i = 0; i < n; i++) d.push(item(d.length, asset, [d.length % 2 ? -60 : 60, y, d.length * 15]))
  }
  add('candy.banner', 2, 30)
  add('candy.hot-air-balloon', 1, 40)
  add('candy.tower', 3, 30)
  add('candy.cloud', 4, 50)
  d.push(item(d.length, 'candy.slime-pool', [60, -6, 20]))
  return d
}

test('simDiff: generated race-sprint equals the committed file', async () => {
  assert.deepEqual(simDiff(await generatedCourse('race-sprint'), await loadAuthoredCourse('race-sprint'), []), [])
})

test('simDiff: reports profiles and obstacles changes', async () => {
  const a = await generatedCourse('race-sprint')
  const json = structuredClone(a.json)
  json.profiles = ['standard']
  const b = { ...a, json }
  assert.ok(simDiff(a, b, []).some(s => s.startsWith('profiles: ')))
  assert.deepEqual(simDiff(a, b, ['profiles']), [])
  const json2 = structuredClone(a.json)
  const obs = json2.obstacles as { t: number[] }[]
  obs[3].t = [obs[3].t[0] + 1, obs[3].t[1], obs[3].t[2]]
  assert.deepEqual(simDiff(a, { ...a, json: json2 }, []).map(s => s.split(':')[0]), ['obstacles/3'])
})

test('decorProblems: missing minimums, spawn hit, high slime, cap, clean dressing', async () => {
  const c = await generatedCourse('race-sprint')
  const assets = nodeGameAssets()
  const empty = await decorProblems(withDecor(c, []), assets)
  for (const a of ['candy.banner', 'candy.hot-air-balloon', 'candy.tower', 'candy.cloud', 'candy.slime-pool']) {
    assert.ok(empty.some(s => s.includes('missing') && s.includes(a)), a)
  }
  assert.deepEqual(await decorProblems(withDecor(c, dressing()), assets), [])
  const spawn = (c.json.spawns as { t: [number, number, number] }[])[0].t
  const onSpawn = [...dressing(), item(99, 'candy.banner', spawn)]
  assert.ok((await decorProblems(withDecor(c, onSpawn), assets)).some(s => s.includes('d-99') && s.includes('intersects spawn 0')))
  const high = dressing().map(d => d.asset === 'candy.slime-pool' ? { ...d, t: [60, 5, 20] as [number, number, number] } : d)
  assert.ok((await decorProblems(withDecor(c, high), assets)).some(s => s.includes('slime pool')))
  const many: DecorItem[] = []
  for (let i = 0; i < 49; i++) many.push(item(i, 'candy.cloud', [100 + i * 20, 50, 0]))
  assert.ok((await decorProblems(withDecor(c, many), assets)).some(s => s.includes('over the cap')))
})

test('playSprint: race-sprint + survival-sprint reaches done', async () => {
  const R = await initRapier()
  const r = await playSprint(R, 'race-sprint', 'survival-sprint', 11)
  assert.equal(r.done, true)
  assert.ok(r.winner >= 0 && r.winner <= 7)
  assert.match(r.finalHash, /^[0-9a-f]{8}$/)
  assert.ok(r.ownRoundQualified >= 1)
})
