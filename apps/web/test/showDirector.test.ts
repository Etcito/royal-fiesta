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
      assert.equal(director.step(null, 0).screen, 'countdown')
      port.candidates = r.index === 0 ? ['C', 'D'] : ['Q']
      port.round = null
      const vote = director.step(null, 0)
      observe(vote.screen)
      assert.equal(vote.vote?.msLeft, 5000)
    }
  }
  assert.equal(director.step(null, 2499).screen, 'podium')
  const end = director.step(null, 1)
  observe(end.screen)
  assert.equal(end.hold, true)
  assert.equal(end.endScreen?.goldenTicketTo, 1)
  assert.equal(director.step('confirm', 3999).finished, false)
  assert.equal(director.step('confirm', 1).finished, true)
  assert.deepEqual(screens, ['vote', 'countdown', 'round', 'result', 'elimShow', 'countdown', 'vote',
    'countdown', 'spectate', 'result', 'elimShow', 'countdown', 'vote', 'countdown', 'spectate', 'result',
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
  assert.equal(next.screen, 'countdown')
  assert.equal(next.hold, false)
})

test('zero eliminations bypass elimShow; end finishes automatically two seconds after winner time', () => {
  const { port, director } = fixture()
  load(director, port, 0)
  port.show.rounds.push(result(0, [0, 1], [0, 1]))
  director.step(null, 0)
  assert.equal(director.step(null, 4000).screen, 'countdown')
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

// A large incoming dt belongs to the old screen. Each new screen receives its full hold.
test('vote starts on entry with the configured match window and decreases on each displayed frame', () => {
  const { port } = fixture()
  const director = new ShowDirector(port, () => ({ name: 'Map', kind: 'race' }), String, 0, 1000)
  assert.equal(director.step(null, 9000).vote?.msLeft, 1000)
  for (let frame = 1; frame <= 3; frame++) assert.equal(director.step(null, 16).vote?.msLeft, 1000 - frame * 16)
})

test('countdown starts at 3 on its first displayed frame after an arbitrarily long world load', () => {
  const { port, director } = fixture()
  port.round = { plan: { index: 0 } }
  director.step(null, 9000)
  for (let i = 0; i < 3; i++) assert.equal(director.step(null, 9000).countdown, null)
  director.worldReady(0)
  assert.equal(director.step(null, 9000).countdown?.label, '3')
  for (let i = 0; i < 3; i++) assert.equal(director.step(null, 16).countdown?.label, '3')
  assert.equal(director.step(null, 952).countdown?.label, '2')
})

test('result gets its full four seconds from its first frame', () => {
  const { port, director } = fixture()
  port.show.rounds.push(result(0, [0, 1], [0]))
  assert.equal(director.step(null, 9000).screen, 'result')
  for (let i = 0; i < 3; i++) assert.equal(director.step(null, 16).screen, 'result')
  assert.equal(director.step(null, 3951).screen, 'result')
  assert.equal(director.step(null, 1).screen, 'elimShow')
})

test('elimShow gets its entire intermission after result leaves', () => {
  const { port, director } = fixture()
  port.show.rounds.push(result(0, [0, 1], [0]))
  director.step(null, 0)
  const first = director.step(null, 9000)
  assert.equal(first.screen, 'elimShow')
  assert.equal(first.elimShow?.lastMs, 0)
  const full = first.elimShow!.doneAtMs
  for (let i = 1; i <= 3; i++) assert.equal(director.step(null, 16).elimShow?.lastMs, i * 16)
  assert.equal(director.step(null, full - 49).screen, 'elimShow')
  assert.equal(director.step(null, 1).screen, 'countdown')
})

test('podium starts on entry and its clock freezes on paused frames', () => {
  const { port, director } = fixture()
  port.done = true
  port.champion = 0
  assert.equal(director.step(null, 9000).screen, 'podium')
  for (let i = 0; i < 3; i++) assert.equal(director.step(null, 16).screen, 'podium')
  for (let i = 0; i < 60; i++) assert.equal(director.step(null, 0).screen, 'podium')
  assert.equal(director.step(null, 2451).screen, 'podium')
  assert.equal(director.step(null, 1).screen, 'endScreen')
})

test('endScreen winner hold starts at entry, with automatic exit after the extra two seconds', () => {
  const { port, director } = fixture()
  port.done = true
  director.step(null, 9000)
  const first = director.step(null, 9000)
  assert.equal(first.screen, 'endScreen')
  assert.equal(first.endScreen?.showWinnerMs, 4000)
  for (let i = 0; i < 3; i++) assert.equal(director.step('confirm', 16).finished, false)
  assert.equal(director.step('confirm', 3951).finished, false)
  assert.equal(director.step('confirm', 1).finished, true)
})

test('local lobby starts full after hidden preparation and only consumes supplied unpaused time', async () => {
  const { LocalCountdown, LOCAL_LOBBY_WAIT_S } = await import('../../../packages/game/src/hub/lobby.ts')
  const timer = new LocalCountdown()
  // Constructing/preparing a mode does not step its hub countdown.
  await Promise.resolve()
  assert.equal(timer.secondsLeft, LOCAL_LOBBY_WAIT_S)
  for (let i = 0; i < 3; i++) {
    timer.step(1 / 60)
    assert.equal(timer.secondsLeft, LOCAL_LOBBY_WAIT_S)
  }
  timer.step(1)
  assert.equal(timer.secondsLeft, LOCAL_LOBBY_WAIT_S - 1)
  timer.step(0)
  assert.equal(timer.secondsLeft, LOCAL_LOBBY_WAIT_S - 1)
})

test('legacy local podium presenter receives zero dt while App frame is paused', async () => {
  const { readFileSync } = await import('node:fs')
  const { stripTypeScriptTypes } = await import('node:module')
  const source = readFileSync(new URL('../src/game/main.ts', import.meta.url), 'utf8')
  // Run the actual frameMatch method with a settled podium and a recording presenter.
  const method = source.match(/  private frameMatch\(run: LocalRun, f: FrameIn\): GameScreen \{[\s\S]*?\n  \}/)![0]
  const cls = stripTypeScriptTypes(`class Subject { ${method} }`)
  const Subject = new Function('matchScreen', 'Phase', cls + '; return Subject')(() => 'podium', { podium: 4 })
  const subject = new Subject()
  let seconds = 0
  subject.over = () => true
  subject.presenter = { view: {}, onPodium: true, draw: (_m: unknown, _a: number, dt: number) => { seconds += dt } }
  subject.c = { setLayout() {} }
  subject.cv = {}
  const run = { singleRace: true, order: [0], match: { sim: { phase: () => ({}), character: () => ({ status: 0 }) } } }
  subject.frameMatch(run, { dt: 0.25, paused: false })
  assert.equal(seconds, 0.25)
  for (let i = 0; i < 3; i++) subject.frameMatch(run, { dt: 1, paused: true })
  assert.equal(seconds, 0.25)
  subject.frameMatch(run, { dt: 0.25, paused: false })
  assert.equal(seconds, 0.5)
})

test('between rounds, loading stays visible until the next vote has its candidates', () => {
  const { port, director } = fixture()
  port.candidates = null
  port.show.rounds.push(result(0, [0], [0]))
  director.step(null, 0)
  assert.equal(director.step(null, 4000).screen, 'countdown')
  for (let i = 0; i < 3; i++) {
    const waiting = director.step(null, 9000)
    assert.equal(waiting.screen, 'countdown')
    assert.equal(waiting.countdown, null)
    assert.equal(waiting.hold, false, 'network intermission must still advance')
  }
  port.candidates = ['C', 'D']
  const first = director.step(null, 9000)
  assert.equal(first.screen, 'vote')
  assert.equal(first.vote?.msLeft, 5000)
  for (let i = 1; i <= 3; i++) assert.equal(director.step(null, 16).vote?.msLeft, 5000 - i * 16)
})
