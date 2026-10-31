import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync, mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { generateSeason, seasonDifference } from '../seasonGen.ts'
import { parseSeason } from '../../packages/game/src/season.ts'

const root = fileURLToPath(new URL('../../', import.meta.url))
const readme = readFileSync(join(root, 'docs/level-plans/README.md'), 'utf8')
const season = generateSeason(readme)
const expected = [
  ['A', 'team', null, ['R3'], 120, 20, 'big-ball-borough'],
  ['B', 'race', null, ['R1', 'R2', 'R3'], 150, 0, 'butterfly-freeway'],
  ['C1', 'race', null, ['R1', 'R2', 'R3', 'R4'], 150, 0, 'diamond-citadel'],
  ['C2', 'race', null, ['R1', 'R2', 'R3', 'R4'], 150, 0, 'tidal-relay'],
  ['D', 'race', null, ['R2', 'R3', 'R4'], 150, 0, 'spiral-of-mischief'],
  ['E', 'race', null, ['R1', 'R2'], 60, 0, 'sugar-sprint'],
  ['F', 'race', null, ['R1', 'R2', 'R3'], 150, 0, 'taffy-circuit'],
  ['G', 'race', null, ['R2', 'R3', 'R4'], 150, 0, 'cloudstack-tower'],
  ['H', 'survival', null, ['R2', 'R3', 'R4'], 120, 30, 'wafer-wipeout'],
  ['I', 'survival', 'lastStanding', ['R3', 'R4', 'final'], 150, 30, 'honeycomb-heights'],
  ['J', 'survival', null, ['R2', 'R3', 'R4'], 120, 30, 'syrup-summit'],
  ['K', 'survival', null, ['R2', 'R3', 'R4'], 120, 30, 'candy-orbit'],
  ['L', 'team', null, ['R3'], 120, 20, 'bonbon-bank'],
  ['M', 'team', null, ['R3'], 120, 20, 'gummy-grounds'],
  ['N', 'collection', null, ['R2', 'R3', 'R4'], 120, 0, 'sweet-vaults'],
  ['O', 'hunt', null, ['R2', 'R3', 'R4'], 90, 0, 'ribbon-runners'],
  ['P', 'logic', null, ['R2', 'R3', 'R4'], 60, 0, 'sugar-signals'],
  ['Q', 'final', 'crown', ['final'], 90, 30, 'crown-confection'],
]

test('real README generates all 18 S12 maps in roster order', () => {
  assert.equal(season.maps.length, 18)
  assert.deepEqual(season.maps.map(m => [m.id, m.kind, m.finalRule, m.stages, m.timeCapS, m.overtimeS, m.slug]), expected)
  for (const map of season.maps) {
    assert.equal(map.course, `s1-${map.id.toLowerCase()}-${map.slug}`)
    assert.equal(map.capacity, 60)
    assert.equal(map.status, 'planned')
    assert.equal(map.reason, null)
    assert.deepEqual(map.usual, map.stages.map(stage => ({ R1: 60, R2: 40, R3: 24, R4: 12, final: 6 })[stage]))
    assert.deepEqual(map.teams, ['A', 'L', 'M'].includes(map.id) ? { count: 2, maxPerTeam: 30, usualPerTeam: 12 } : null)
    assert.deepEqual(map.files, { course: `courses/${map.course}.course.json`, zones: `courses/${map.course}.zones.json` })
  }
  assert.equal(season.maps[0].plan, 'docs/level-plans/A-football.svg')
  assert.equal(season.maps[0].assets, 'docs/level-plans/A-football-assets.md')
  assert.equal(season.maps[9].family, 'layered-hex')
  assert.equal(season.maps[2].family, 'open-routes-gauntlet')
  assert.equal(season.name, 'Sugarcloud Showdown')
  assert.equal(season.id, 's1-sugarcloud-showdown')
  assert.equal(season.world, 'candy')
  assert.deepEqual(season.plans, { default: [60, 40, 24, 12, 6, 1], long: [60, 48, 36, 24, 12, 6, 1] })
  assert.deepEqual(season.rules, { maxTeamRoundsPerShow: 1, finalReservedFirst: true, noBackToBack: [['H', 'I'], ['D', 'G']], cutMaps: ['E', 'P'], floor: { final: 2, race: 4, survivalOrScore: 3, team: 1 } })
})

test('pool and cap edits are parsed rather than inferred from roster Stage or constants', () => {
  const changed = generateSeason(readme.replace('B, C1, C2, E, F. Broad', 'C1, C2, E, F. Broad').replace('cap 150', 'cap 155'))
  assert.deepEqual(changed.maps[1].stages, ['R2', 'R3'])
  assert.equal(changed.maps[1].timeCapS, 155)
  assert.throws(() => generateSeason(readme.replace('cap 150', 'cap 0')), /timeCapS/)
})

test('comparison reports the first changed kind but ignores map build metadata', () => {
  const changed = structuredClone(season)
  changed.maps[0].status = 'cut'
  changed.maps[0].reason = 'Deferred'
  changed.maps[0].files.course = 'courses/other.course.json'
  assert.equal(seasonDifference(parseSeason(changed, 'test.json'), season), null)
  changed.maps[0].kind = 'race'
  assert.equal(seasonDifference(changed, season), '/maps/0/kind')
})

test('CLI writes formatted data, checks metadata and exits 1 with the changed pointer', () => {
  const dir = mkdtempSync(join(tmpdir(), 'season-gen-'))
  try {
    for (const path of ['tools', 'docs/level-plans', 'courses']) mkdirSync(join(dir, path), { recursive: true })
    copyFileSync(join(root, 'tools/seasonGen.ts'), join(dir, 'tools/seasonGen.ts'))
    symlinkSync(join(root, 'packages'), join(dir, 'packages'))
    writeFileSync(join(dir, 'package.json'), '{"type":"module"}')
    writeFileSync(join(dir, 'docs/level-plans/README.md'), readme)
    const run = (arg: string) => spawnSync(process.execPath, ['--experimental-strip-types', join(dir, 'tools/seasonGen.ts'), arg], { encoding: 'utf8', timeout: 10000 })
    const write = run('--write')
    assert.equal(write.status, 0, write.stderr)
    const target = join(dir, 'courses/season.json')
    assert.equal(readFileSync(target, 'utf8'), `${JSON.stringify(season, null, 2)}\n`)
    assert.equal(run('--check').status, 0)
    const changed = structuredClone(season)
    changed.maps[0].status = 'built'
    writeFileSync(target, JSON.stringify(changed))
    assert.equal(run('--check').status, 0)
    changed.maps[0].kind = 'race'
    writeFileSync(target, JSON.stringify(changed))
    const check = run('--check')
    assert.equal(check.status, 1)
    assert.match(check.stderr, /courses\/season.json#\/maps\/0\/kind/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
