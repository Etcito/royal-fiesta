import assert from 'node:assert/strict'
import { test } from 'node:test'
import { LOBBY_CHOICE_MS, LOBBY_FALLBACK_MS, LocalCountdown, LobbyTracker, lobbyLines } from '../src/hub/lobby.ts'
import { parseRelayServerMsg } from '../src/net/relayProtocol.ts'

const A = { g: 'royal-fiesta', v: 1, name: 'Ann', c: 0 }
const B = { g: 'royal-fiesta', v: 1, name: 'Bob', c: 1 }

function choice(phase: 'waiting' | 'playing', actions: string[]) {
  return { t: 'lobby_choice' as const, lobbies: [{ id: 'L1', phase, players: 1, seats: 4, startsInMs: 40_000, actions, names: [A] }] }
}

test('player in a lobby: countdown from the server, names, never reset by a later state', () => {
  const t = new LobbyTracker()
  t.entered(0)
  t.apply({ t: 'lobby_state', id: 'L1', phase: 'waiting', role: 'player', seat: 0, players: [A], seats: 4, startsInMs: 60_000, waitMs: 60_000 }, 1000)
  assert.equal(t.view.stage, 'player')
  assert.equal(t.secondsLeft(1000), 60)
  assert.equal(t.secondsLeft(31_500), 30)
  // Bob arrives 20 s later: the server's remaining time keeps the same end.
  t.apply({ t: 'lobby_state', id: 'L1', phase: 'waiting', role: 'player', seat: 0, players: [A, B], seats: 4, startsInMs: 40_000, waitMs: 60_000 }, 21_000)
  assert.equal(t.secondsLeft(21_000), 40)
  assert.deepEqual(lobbyLines(t, 21_000), ['Lobby 2/4 - round starts in 40 s', 'Ann, Bob', 'Bots fill the empty places'])
})

test('choice on a waiting lobby: join, spectate or new; unanswered it joins', () => {
  const t = new LobbyTracker()
  t.entered(0)
  t.apply(choice('waiting', ['join', 'spectate']), 0)
  assert.equal(t.view.stage, 'choosing')
  assert.deepEqual(t.view.offer!.actions, ['join', 'spectate', 'new'])
  assert.equal(t.choiceDue(LOBBY_CHOICE_MS - 1), false)
  assert.equal(t.choiceDue(LOBBY_CHOICE_MS), true)
  assert.equal(t.defaultPick(), 'join')
  assert.equal(t.pick('join'), 'L1')
  // Answered: no default any more.
  assert.equal(t.choiceDue(LOBBY_CHOICE_MS * 2), false)
})

test('choice: a joinable lobby is offered before a round that is on', () => {
  const t = new LobbyTracker()
  t.apply({ t: 'lobby_choice', lobbies: [
    { id: 'L1', phase: 'playing', players: 1, seats: 4, startsInMs: 0, actions: ['spectate'], names: [A] },
    { id: 'L3', phase: 'waiting', players: 1, seats: 4, startsInMs: 9000, actions: ['join', 'spectate'], names: [B] },
  ] }, 0)
  assert.equal(t.view.offer!.id, 'L3')
  assert.equal(t.defaultPick(), 'join')
})

test('choice on a started round: spectate or new; unanswered it opens a new lobby; join is refused', () => {
  const t = new LobbyTracker()
  t.entered(0)
  t.apply(choice('playing', ['spectate']), 0)
  assert.deepEqual(t.view.offer!.actions, ['spectate', 'new'])
  assert.equal(t.defaultPick(), 'new')
  assert.throws(() => t.pick('join'), /allows spectate, new/)
  assert.equal(t.pick('new'), null)
  assert.match(lobbyLines(new LobbyTracker(), 0)[0], /Joining a lobby/)
})

test('spectator: waiting then playing; the end of the round asks to enter again', () => {
  const t = new LobbyTracker()
  t.entered(0)
  t.apply({ t: 'lobby_state', id: 'L1', phase: 'waiting', role: 'spectator', seat: -1, players: [A], seats: 4, startsInMs: 5000, waitMs: 60_000 }, 0)
  assert.equal(t.view.stage, 'spectator')
  assert.match(lobbyLines(t, 0)[0], /^Spectating a lobby: 1\/4 - round in 5 s/)
  t.apply({ t: 'lobby_watch', id: 'L1', session: 'q1', seed: 9, players: 1, opps: [A], replay: true }, 5000)
  assert.equal(t.view.phase, 'playing')
  assert.equal(t.secondsLeft(5000), null)
  assert.equal(lobbyLines(t, 5000)[0], 'Spectating a round: Ann')
  assert.deepEqual(t.apply({ t: 'lobby_closed', id: 'L2', reason: 'ended' }, 9000), { kind: 'none' })
  assert.deepEqual(t.apply({ t: 'lobby_closed', id: 'L1', reason: 'ended' }, 9000), { kind: 'reenter' })
  assert.equal(t.view.stage, 'entering')
})

test('errors: a lost race enters again, anything else fails', () => {
  const t = new LobbyTracker()
  assert.deepEqual(t.apply({ t: 'lobby_error', reason: 'lobby_closed' }, 0), { kind: 'reenter' })
  assert.deepEqual(t.apply({ t: 'lobby_error', reason: 'unknown_lobby' }, 0), { kind: 'reenter' })
  assert.deepEqual(t.apply({ t: 'lobby_error', reason: 'server full' }, 0), { kind: 'fail', reason: 'server full' })
})

test('fallback: no lobby answer for LOBBY_FALLBACK_MS means a server without lobbies', () => {
  const t = new LobbyTracker()
  t.entered(1000)
  assert.equal(t.fallbackDue(1000 + LOBBY_FALLBACK_MS - 1), false)
  assert.equal(t.fallbackDue(1000 + LOBBY_FALLBACK_MS), true)
  t.apply({ t: 'lobby_left' }, 1500)
  assert.equal(t.fallbackDue(99_999), false)
})

test('local countdown: runs on frame time, pauses with dt 0, is done at the wait', () => {
  const c = new LocalCountdown(3)
  assert.equal(c.secondsLeft, 3)
  assert.equal(c.step(1.2), false)
  assert.equal(c.step(0), false)
  assert.equal(c.secondsLeft, 2)
  assert.equal(c.step(1.8), true)
  assert.equal(c.secondsLeft, 0)
  c.reset()
  assert.equal(c.done, false)
  assert.throws(() => new LocalCountdown(0))
})

test('protocol copy parses the lobby messages and rejects malformed ones', () => {
  const ok = (m: object) => parseRelayServerMsg(JSON.stringify(m))
  assert.ok(ok(choice('waiting', ['join', 'spectate'])))
  assert.ok(ok({ t: 'lobby_state', id: 'L1', phase: 'waiting', role: 'player', seat: 0, players: [], seats: 4, startsInMs: 1, waitMs: 1 }))
  assert.ok(ok({ t: 'lobby_closed', id: 'L1', reason: 'ended' }))
  assert.equal(ok({ t: 'lobby_state', id: 'L1', phase: 'later', role: 'player', seat: 0, players: [], seats: 4, startsInMs: 1, waitMs: 1 }), null)
  assert.equal(ok({ t: 'lobby_closed', id: 'L1', reason: 'why' }), null)
})
