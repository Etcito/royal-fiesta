import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { RefusalError } from '@royal-fiesta/sim/refusal'
import { parseSeason, playableMaps, schedMaps, seasonFloorProblems } from '../src/season.ts'
import type { SeasonData, SeasonMap } from '../src/season.ts'

const path = 'courses/test-season.json'
function map(id: string, kind: SeasonMap['kind'], status: SeasonMap['status'] = 'planned'): SeasonMap {
  return {
    id, slug: 'test', name: 'Test map', course: `s1-${id.toLowerCase()}-test`, kind,
    finalRule: null, family: 'test', stages: ['R1', 'R2'], capacity: 60, usual: [60, 40],
    teams: kind === 'team' ? { count: 2, maxPerTeam: 30, usualPerTeam: 20 } : null,
    timeCapS: 120, overtimeS: 0, plan: 'docs/test.svg', assets: 'docs/test-assets.md',
    files: { course: `courses/${id}.course.json`, zones: `courses/${id}.zones.json` },
    status, reason: status === 'cut' ? 'Outside this season' : null,
  }
}
function season(): SeasonData {
  return {
    format: 'royal-fiesta.season', version: 0, id: 's1-test', name: 'Test', world: 'candy',
    plans: { default: [60, 40, 24, 12, 6, 1], long: [60, 48, 36, 24, 12, 6, 1] },
    rules: {
      maxTeamRoundsPerShow: 1, finalReservedFirst: true, noBackToBack: [['A', 'B']], cutMaps: ['E'],
      floor: { final: 2, race: 4, survivalOrScore: 3, team: 1 },
    },
    maps: [map('A', 'team', 'built'), map('B', 'race', 'built'), map('E', 'race', 'cut'),
      { ...map('I', 'survival'), finalRule: 'lastStanding' },
      { ...map('Q', 'final', 'built'), finalRule: 'crown', stages: ['final'] }],
  }
}
function refusal(value: unknown, pointer: string): void {
  assert.throws(() => parseSeason(value, path), (error: unknown) => {
    assert.ok(error instanceof RefusalError)
    assert.equal(error.area, 'season')
    assert.equal(error.path, `${path}#${pointer}`)
    assert.ok(error.message.includes(`${path}#${pointer}`))
    assert.match(error.message, /; fix: .+/)
    return true
  })
}

test('valid season parses without defaults or changes', () => {
  const input = season()
  assert.deepEqual(parseSeason(JSON.parse(JSON.stringify(input)), path), input)
})

test('duplicate id, unknown kind and bad status name the pointer and fix (QB7)', () => {
  const duplicate = season()
  duplicate.maps[1].id = 'A'
  refusal(duplicate, '/maps/1/id')
  const kind = season()
  Object.assign(kind.maps[3], { kind: 'mystery' })
  refusal(kind, '/maps/3/kind')
  const status = season()
  Object.assign(status.maps[0], { status: 'ready' })
  refusal(status, '/maps/0/status')
})

test('required fields and invalid S12 values are refused', () => {
  const cases: [string, unknown][] = [
    ['/format', 'other'], ['/version', 1], ['/name', null], ['/plans/default/0', 1.5],
    ['/maps/0/id', 'Z'], ['/maps/0/course', 'wrong'], ['/maps/0/family', null],
    ['/maps/0/finalRule', 'winner'], ['/maps/0/stages', []], ['/maps/0/stages/0', 'cut'],
    ['/maps/0/stages', ['R1', 'R1']], ['/maps/0/capacity', 61], ['/maps/0/capacity', 1],
    ['/maps/0/usual/0', 2.5], ['/maps/0/teams/count', 3], ['/maps/0/teams/maxPerTeam', 0],
    ['/maps/0/teams/usualPerTeam', 1.5], ['/maps/0/timeCapS', 0], ['/maps/0/timeCapS', Infinity],
    ['/maps/0/overtimeS', -1], ['/maps/0/overtimeS', NaN],
    ['/maps/0/files/course', 'elsewhere/file.json'], ['/maps/0/files/zones', 'courses/../file.json'],
    ['/maps/0/reason', 'not cut'], ['/maps/2/reason', null],
    ['/rules/cutMaps/0', 'Q2'], ['/rules/noBackToBack/0/1', 'C1'],
    ['/rules/noBackToBack/0', ['A']], ['/rules/finalReservedFirst', 1],
    ['/rules/maxTeamRoundsPerShow', -1], ['/rules/floor/final', -1], ['/rules/floor/team', 0.5],
  ]
  for (const [pointer, value] of cases) {
    const input = season()
    const parts = pointer.slice(1).split('/')
    let target: any = input
    for (const part of parts.slice(0, -1)) target = target[part]
    target[parts.at(-1)!] = value
    refusal(input, pointer === '/maps/0/stages' && Array.isArray(value) && value.length ? '/maps/0/stages/1' : pointer)
  }
  // Every declared field is required, including nullable fields and nested objects.
  function missingFields(value: unknown, parts: string[] = []): void {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return
    for (const [key, child] of Object.entries(value)) {
      const input = season()
      let target: any = input
      for (const part of parts) target = target[part]
      delete target[key]
      refusal(input, `/${[...parts, key].join('/')}`)
      missingFields(child, [...parts, key])
    }
  }
  missingFields(season())
  missingFields(season().maps[0], ['maps', '0'])
})

test('floors count non-cut maps, including planned maps and final-capable survival', () => {
  const s = season()
  assert.deepEqual(seasonFloorProblems(s), [
    'race: 1 non-cut maps; requires at least 4',
    'survivalOrScore: 1 non-cut maps; requires at least 3',
  ])
  s.rules.floor = { final: 3, race: 1, survivalOrScore: 5, team: 2 }
  s.maps.push(map('N', 'collection'), map('O', 'hunt'), map('P', 'logic'))
  assert.deepEqual(seasonFloorProblems(s), [
    'final: 2 non-cut maps; requires at least 3',
    'survivalOrScore: 4 non-cut maps; requires at least 5',
    'team: 1 non-cut maps; requires at least 2',
  ])
  s.rules.floor = { final: 2, race: 1, survivalOrScore: 4, team: 1 }
  assert.deepEqual(seasonFloorProblems(s), [])
})

test('playable and scheduled maps preserve roster order and filter status and loaded course ids', () => {
  const s = season()
  assert.deepEqual(playableMaps(s).map(m => m.id), ['A', 'B', 'Q'])
  const courses = ['s1-q-test', 's1-i-test', 's1-e-test', 's1-a-test', 'B', 's1-a-test'].map(id => ({ id }))
  const scheduled = schedMaps(s, courses)
  assert.deepEqual(scheduled, [s.maps[0], s.maps[4]].map(m => ({
    id: m.id, course: m.course, kind: m.kind, finalRule: m.finalRule, family: m.family,
    stages: m.stages, capacity: m.capacity, teams: m.teams, timeCapS: m.timeCapS, overtimeS: m.overtimeS,
  })))
  assert.deepEqual(schedMaps(s, []), [])
  assert.deepEqual(s, season())
})

test('committed courses/season.json holds all 18 planned maps and meets the floor', () => {
  const file = new URL('../../../courses/season.json', import.meta.url)
  const season = parseSeason(JSON.parse(readFileSync(file, 'utf8')), 'courses/season.json')
  assert.equal(season.maps.length, 18)
  assert.deepEqual(season.maps.map(m => m.id), ['A', 'B', 'C1', 'C2', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q'])
  for (const map of season.maps) {
    assert.equal(map.status, 'planned')
    assert.equal(map.reason, null)
  }
  const finals = season.maps.filter(m => m.finalRule !== null).length
  const races = season.maps.filter(m => m.kind === 'race').length
  const survivalOrScore = season.maps.filter(m => ['survival', 'collection', 'hunt', 'logic'].includes(m.kind)).length
  const teams = season.maps.filter(m => m.kind === 'team').length
  assert.deepEqual({ finals, races, survivalOrScore, teams }, { finals: 2, races: 7, survivalOrScore: 7, teams: 3 })
  assert.deepEqual(seasonFloorProblems(season), [])
})
