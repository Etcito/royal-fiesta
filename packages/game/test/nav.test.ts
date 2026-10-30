import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Effect, Nav, SCREENS, navGraph, navStates } from '../src/screens/nav.ts'
import type { NavEvent, Screen } from '../src/screens/nav.ts'
import type { LoadProgress } from '../src/content.ts'

const back: NavEvent = { kind: 'back' }

function reachable(graph: Record<Screen, Screen[]>, from: Screen): Set<Screen> {
  const seen = new Set<Screen>([from])
  const todo = [from]
  while (todo.length > 0) {
    for (const s of graph[todo.pop()!]) {
      if (!seen.has(s)) {
        seen.add(s)
        todo.push(s)
      }
    }
  }
  return seen
}

function navAt(...events: NavEvent[]): Nav {
  const nav = new Nav()
  for (const ev of events) nav.dispatch(ev)
  return nav
}

const play: NavEvent = { kind: 'action', action: 'play' }

test('every screen is reachable from title', () => {
  const fromTitle = reachable(navGraph(), 'title')
  for (const s of SCREENS) assert.ok(fromTitle.has(s), `${s} unreachable`)
})

test('no dead end: title is reachable from every screen, and back leaves every non-title screen', () => {
  const graph = navGraph()
  for (const s of SCREENS) assert.ok(reachable(graph, s).has('title'), `${s} is a dead end`)
  for (const state of navStates()) {
    // Loading has no back edge: it ends only in loaded or error (tested below).
    if (state.screen === 'title' || state.screen === 'loading') continue
    const n = state.clone()
    n.dispatch(back)
    assert.notEqual(n.screen, state.screen, `no back edge from ${state.key()}`)
  }
})

test('pause back returns to the screen paused from', () => {
  const round = navAt(play, { kind: 'game', screen: 'queue' }, { kind: 'game', screen: 'countdown' },
    { kind: 'game', screen: 'round' })
  assert.deepEqual(round.dispatch(back), ['pause'])
  assert.equal(round.screen, 'pause')
  assert.deepEqual(round.dispatch(back), ['resume'])
  assert.equal(round.screen, 'round')

  const hub = navAt(play)
  assert.deepEqual(hub.dispatch(back), ['pause'])
  assert.deepEqual(hub.dispatch({ kind: 'action', action: 'resume' }), ['resume'])
  assert.equal(hub.screen, 'hub')
})

test('leave from pause: match goes to hub, hub goes to title', () => {
  const match = navAt(play, { kind: 'game', screen: 'queue' }, { kind: 'game', screen: 'countdown' }, back)
  assert.deepEqual(match.dispatch({ kind: 'action', action: 'leave' }), ['leaveMatch', 'resume'])
  assert.equal(match.screen, 'hub')
  const hub = navAt(play, back)
  assert.deepEqual(hub.dispatch({ kind: 'action', action: 'leave' }), ['leaveGame'])
  assert.equal(hub.screen, 'title')
})

test('settings opened from pause returns to pause', () => {
  const nav = navAt(play, back, { kind: 'action', action: 'settings' })
  assert.equal(nav.screen, 'settings')
  assert.equal(nav.settingsFrom, 'pause')
  nav.dispatch(back)
  assert.equal(nav.screen, 'pause')
  nav.dispatch(back)
  assert.equal(nav.screen, 'hub')
})

test('error keeps its message, leaves a live game, and back goes to title', () => {
  const nav = navAt(play)
  assert.deepEqual(nav.dispatch({ kind: 'error', message: 'relay closed' }), ['leaveGame'])
  assert.equal(nav.screen, 'error')
  assert.equal(nav.error, 'relay closed')
  assert.deepEqual(nav.actions(), ['retry', 'leave'])
  nav.dispatch(back)
  assert.equal(nav.screen, 'title')
})

test('retry repeats the last start', () => {
  const hub = navAt(play, { kind: 'error', message: 'x' })
  assert.deepEqual(hub.dispatch({ kind: 'action', action: 'retry' }), ['startHub'])
  assert.equal(hub.screen, 'hub')
  const online = navAt({ kind: 'action', action: 'playOnline' }, { kind: 'error', message: 'x' })
  assert.deepEqual(online.dispatch({ kind: 'action', action: 'retry' }), ['startOnline'])
  assert.equal(online.screen, 'title')
})

test('an invalid event returns [] and leaves the state unchanged', () => {
  const invalid: [Nav, NavEvent][] = [
    [new Nav(), back],
    [new Nav(), { kind: 'action', action: 'leave' }],
    [new Nav(), { kind: 'game', screen: 'round' }],
    [navAt(play), { kind: 'action', action: 'retry' }],
  ]
  for (const [nav, ev] of invalid) {
    const before = nav.key()
    assert.deepEqual(nav.dispatch(ev), [])
    assert.equal(nav.key(), before)
  }
})

test('actions list the buttons of the current screen', () => {
  assert.deepEqual(new Nav().actions(), ['play', 'playOnline', 'settings', 'credits'])
  assert.deepEqual(navAt(play).actions(), ['queue'])
  assert.deepEqual(navAt(play, back).actions(), ['resume', 'settings', 'leave'])
  assert.deepEqual(navAt(play, { kind: 'game', screen: 'round' }).actions(), [])
})

test('onlineOnly (a baked relay): Play is Play online, no separate button, retry stays online', () => {
  const nav = new Nav()
  nav.onlineOnly = true
  assert.deepEqual(nav.actions(), ['play', 'settings', 'credits'])
  assert.deepEqual(nav.dispatch({ kind: 'action', action: 'playOnline' }), [])
  assert.deepEqual(nav.dispatch({ kind: 'action', action: 'play' }), ['startOnline'])
  assert.deepEqual(nav.enterHub(), ['startHub'])
  assert.equal(nav.screen, 'hub')
  nav.dispatch({ kind: 'error', message: 'x' })
  assert.deepEqual(nav.dispatch({ kind: 'action', action: 'retry' }), ['startOnline'])
  const boot = new Nav()
  boot.onlineOnly = true
  boot.dispatch({ kind: 'load', next: 'hub' })
  assert.deepEqual(boot.dispatch({ kind: 'loaded' }), ['startOnline'])
})

const progress = (phase: LoadProgress['phase'], done: number, total: number, label: string): NavEvent =>
  ({ kind: 'progress', progress: { phase, done, total, label } })

test('loading -> progress updates -> next screen', () => {
  const nav = new Nav()
  assert.deepEqual(nav.dispatch({ kind: 'load', next: 'title' }), ['load'])
  assert.equal(nav.screen, 'loading')
  assert.equal(nav.progress, null)
  assert.equal(nav.contentReady(), false)
  assert.deepEqual(nav.actions(), [])
  nav.dispatch(progress('courses', 1, 6, 'race-sprint'))
  assert.deepEqual(nav.progress, { phase: 'courses', done: 1, total: 6, label: 'race-sprint' })
  nav.dispatch(progress('meshing', 3, 9, 'candy.spinner-bar'))
  assert.deepEqual(nav.progress, { phase: 'meshing', done: 3, total: 9, label: 'candy.spinner-bar' })
  assert.equal(nav.screen, 'loading')
  assert.deepEqual(nav.dispatch({ kind: 'loaded' }), [])
  assert.equal(nav.screen, 'title')
  assert.equal(nav.contentReady(), true)
  assert.equal(nav.progress, null)
  assert.deepEqual(nav.actions(), ['play', 'playOnline', 'settings', 'credits'])

  const hub = navAt({ kind: 'load', next: 'hub' }, progress('done', 1, 1, 'v0'))
  assert.deepEqual(hub.dispatch({ kind: 'loaded' }), ['startHub'])
  assert.equal(hub.screen, 'hub')
  assert.equal(hub.live, true)
})

test('loading is never skipped: back, actions, game events and a second load are ignored', () => {
  const nav = navAt({ kind: 'load', next: 'hub' }, progress('assets', 2, 5, 'bean'))
  const before = nav.key()
  const events: NavEvent[] = [back, play, { kind: 'action', action: 'retry' },
    { kind: 'game', screen: 'hub' }, { kind: 'load', next: 'title' }]
  for (const ev of events) {
    assert.deepEqual(nav.dispatch(ev), [])
    assert.equal(nav.key(), before)
  }
  // Progress and loaded outside loading do nothing.
  const title = new Nav()
  assert.deepEqual(title.dispatch(progress('done', 1, 1, 'x')), [])
  assert.deepEqual(title.dispatch({ kind: 'loaded' }), [])
  assert.equal(title.key(), new Nav().key())
})

test('loading -> fail keeps the message text, then retry reloads', () => {
  const message = '[content] courses/race-sprint.course.json#/obstacles/3/asset: unknown asset; add the asset file'
  const nav = navAt({ kind: 'load', next: 'title' }, progress('courses', 0, 6, 'race-sprint'))
  assert.deepEqual(nav.dispatch({ kind: 'error', message }), [])
  assert.equal(nav.screen, 'error')
  assert.equal(nav.error, message)
  assert.equal(nav.contentReady(), false)
  // Back to title offers no play without content, only retry.
  const left = nav.clone()
  left.dispatch(back)
  assert.equal(left.screen, 'title')
  assert.deepEqual(left.actions(), ['retry', 'settings', 'credits'])
  assert.deepEqual(left.dispatch(play), [])
  assert.deepEqual(left.dispatch({ kind: 'action', action: 'retry' }), ['load'])
  assert.equal(left.screen, 'loading')
  // Retry on the error screen reloads too.
  assert.deepEqual(nav.dispatch({ kind: 'action', action: 'retry' }), ['load'])
  assert.equal(nav.screen, 'loading')
  assert.equal(nav.error, null)
  nav.dispatch({ kind: 'loaded' })
  assert.equal(nav.screen, 'title')
})

test('lobby choice: join / spectate / new lobby buttons, back takes the default and returns to the hub; neither counts as a match', () => {
  const n = new Nav()
  n.dispatch({ kind: 'action', action: 'play' })
  n.dispatch({ kind: 'game', screen: 'lobbyChoice' })
  assert.equal(n.screen, 'lobbyChoice')
  assert.equal(n.inMatch, false)
  assert.deepEqual(n.actions(), ['join', 'spectate', 'newLobby'])
  assert.deepEqual(n.dispatch({ kind: 'action', action: 'join' }), [Effect.pickJoin])
  assert.deepEqual(n.dispatch({ kind: 'action', action: 'newLobby' }), [Effect.pickNew])
  n.dispatch({ kind: 'game', screen: 'lobbyLive' })
  assert.deepEqual(n.actions(), ['spectate', 'newLobby'])
  assert.deepEqual(n.dispatch({ kind: 'action', action: 'join' }), [])
  assert.deepEqual(n.dispatch({ kind: 'action', action: 'spectate' }), [Effect.pickSpectate])
  assert.deepEqual(n.dispatch({ kind: 'back' }), [Effect.pickDefault])
  assert.equal(n.screen, 'hub')
})
