import assert from 'node:assert/strict'
import test from 'node:test'
import { ShowDirector } from '../src/game/showDirector.ts'
import type { ShowPort } from '../src/game/showDirector.ts'
import type { ShowState, ZoneRoundResult } from '../../../packages/game/src/net/zoneRounds.ts'

function fixture() {
  const show: ShowState = {
    cursor: { plan: [6, 4, 2, 1], step: 0, alive: 6, teamRounds: 0, roundIndex: 0 },
    schedule: { finalMap: 'Q', used: [], lastKind: null, previous: null, rngState: 1 },
    rounds: [], openingRanks: new Uint16Array(6),
  }
  const sent: number[] = []
  const port = {
    candidates: ['B', 'C', 'D'] as readonly string[] | null,
    round: null as ShowPort['round'], show, done: false as boolean, champion: null as number | null,
    alive: [0, 1, 2, 3, 4, 5], vote: (choice: number) => { sent.push(choice) },
  } satisfies ShowPort
  const director = new ShowDirector(port, map => ({ name: `Map ${map}`, kind: 'race' }), seat => `Bean ${seat}`, 0)
  return { port, director, sent }
}

function result(index: number, ranking: number[], qualified: number[], final = false): ZoneRoundResult {
  return { index, map: final ? 'Q' : 'B', course: 'fixture', kind: final ? 'final' : 'race',
    final, playoff: false, endTick: 100, reason: final ? 'crown' : 'target', ranking, qualified,
    eliminated: ranking.filter(seat => !qualified.includes(seat)),
    points: ranking.map((seat, i) => qualified.includes(seat) ? ranking.length - i : 0),
    teamScores: [], champion: final ? qualified[0] : -1 }
}

function load(director: ShowDirector, port: ReturnType<typeof fixture>['port'], index: number) {
  port.candidates = null
  port.round = { plan: { index } }
  assert.equal(director.step(null, 0).hold, true)
  director.worldReady(index)
  assert.equal(director.step(null, 0).hold, false)
  return director.step(null, 4000)
}

test('two rounds and a final: screen order, vote once, totals, spectate and held presentations', () => {
  const { port, director, sent } = fixture()
  const screens: string[] = []
  const observe = (screen: string) => { if (screens.at(-1) !== screen) screens.push(screen) }
  observe(director.step(null, 0).screen)
  assert.equal(director.step('right', 0).vote?.focus, 1)
  assert.deepEqual(director.step('confirm', 0).sounds, ['flow.vote-confirm'])
  director.step('confirm', 16)
  director.step('left', 16)
  assert.deepEqual(sent, [1])
  const rounds = [result(0, [1, 2, 3, 4, 0, 5], [1, 2, 3, 4]),
    result(1, [2, 1, 3, 4], [2, 1]), result(2, [1, 2], [1], true)]
  for (const r of rounds) {
    port.candidates = null
    port.round = { plan: { index: r.index } }
    observe(director.step(null, 0).screen)
    director.worldReady(r.index)
    director.step(null, 0)
    const running = director.step(null, 4000)
    observe(running.screen)
    assert.equal(running.screen, r.index === 0 ? 'round' : 'spectate')
    port.show.rounds.push(r)
    port.alive = r.qualified
    port.done = r.final
    port.champion = r.final ? 1 : null
    const results = director.step(null, 100)
    observe(results.screen)
    assert.equal(results.hold, true)
    assert.equal(results.results?.[0].name, `Bean ${r.ranking[0]}`)
    if (r.final) assert.equal(results.results?.[0].total, 11)
    assert.equal(director.step('confirm', 1499).screen, 'result')
    const elimination = director.step('confirm', 1)
    observe(elimination.screen)
    assert.equal(elimination.hold, true)
    assert.equal(director.step('confirm', 1499).screen, 'elimShow')
    const after = director.step('confirm', 1)
    observe(after.screen)
    assert.equal(after.hold, r.final)
    if (!r.final) {
      // Old round remains visible on the port until the match resumes.
      assert.equal(director.step(null, 0).screen, 'vote')
      port.candidates = r.index === 0 ? ['C', 'D'] : ['Q']
      port.round = null
      assert.equal(director.step(null, 0).vote?.msLeft, 5000)
    }
  }
  assert.equal(director.step(null, 2499).screen, 'podium')
  const end = director.step(null, 1)
  observe(end.screen)
  assert.equal(end.hold, true)
  assert.equal(end.endScreen?.goldenTicketTo, 1)
  assert.equal(director.step('confirm', 3999).finished, false)
  assert.equal(director.step('confirm', 1).finished, true)
  assert.deepEqual(screens, ['vote', 'countdown', 'round', 'result', 'elimShow', 'vote',
    'countdown', 'spectate', 'result', 'elimShow', 'vote', 'countdown', 'spectate', 'result',
    'elimShow', 'podium', 'endScreen'])
})

test('loading is untimed; only matching worldReady starts countdown and cues each label once', () => {
  const { port, director } = fixture()
  port.candidates = null
  port.round = { plan: { index: 7 } }
  director.step(null, 0)
  director.worldReady(6)
  const loading = director.step(null, 20000)
  assert.equal(loading.hold, true)
  assert.equal(loading.countdown, null)
  assert.deepEqual(loading.sounds, [])
  director.worldReady(7)
  const start = director.step(null, 0)
  assert.equal(start.hold, false)
  assert.equal(start.countdown?.label, '3')
  assert.deepEqual(start.sounds, ['flow.count-tick'])
  director.worldReady(7) // duplicate readiness must not restart the countdown
  assert.deepEqual(director.step(null, 999).sounds, [])
  for (const [dt, label, sound] of [[1, '2', 'flow.count-tick'], [1000, '1', 'flow.count-tick'],
    [1000, 'GO', 'flow.count-go']] as const) {
    const frame = director.step(null, dt)
    assert.equal(frame.countdown?.label, label)
    assert.deepEqual(frame.sounds, [sound])
    assert.deepEqual(director.step(null, 0).sounds, [])
  }
  assert.deepEqual(director.step(null, 1000).sounds, ['flow.round-start'])
  assert.deepEqual(director.step(null, 0).sounds, [])
})

test('natural results/elimination deadlines and drop cues are not replayed', () => {
  const { port, director } = fixture()
  load(director, port, 0)
  port.show.rounds.push(result(0, [0, 1, 2], [0]))
  director.step(null, 0)
  assert.equal(director.step(null, 3999).screen, 'result')
  assert.equal(director.step(null, 1).screen, 'elimShow')
  assert.deepEqual(director.step(null, 1500).sounds, ['flow.elim-drop'])
  assert.deepEqual(director.step(null, 0).sounds, [])
  assert.deepEqual(director.step(null, 1000).sounds, ['flow.elim-drop'])
  const next = director.step(null, 3500)
  assert.equal(next.screen, 'vote')
  assert.equal(next.hold, false)
})

test('zero eliminations bypass elimShow; end finishes automatically two seconds after winner time', () => {
  const { port, director } = fixture()
  load(director, port, 0)
  port.show.rounds.push(result(0, [0, 1], [0, 1]))
  director.step(null, 0)
  assert.equal(director.step(null, 4000).screen, 'vote')
  port.done = true
  port.champion = 1
  assert.equal(director.step(null, 0).screen, 'podium')
  const end = director.step(null, 2500)
  assert.equal(end.endScreen?.winner, 1)
  assert.equal(director.step('confirm', 1000).finished, false)
  assert.equal(director.step(null, 4999).finished, false)
  assert.equal(director.step(null, 1).finished, true)
  assert.equal(director.step(null, 100).finished, true)
})
