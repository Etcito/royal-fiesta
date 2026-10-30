import assert from 'node:assert/strict'
import test from 'node:test'
import { checkFullMatchLogs } from '../src/zoneMatchCheck.ts'

interface BotLines {
  ledger?: string
  sessions?: string
}

const ZERO = 'desyncs=0 resultMismatches=0 malformed=0'
const BASE = JSON.stringify({
  rounds: [
    { kind: 'race', final: false },
    { kind: 'survival', final: true },
  ],
  champion: null,
})

function logsFor(bots: readonly BotLines[]): string[] {
  const lines: string[] = []
  bots.forEach((bot, i) => {
    const name = `zone-bot-${i}`
    if (bot.ledger !== undefined) lines.push(`[bot ${i}] [zone-match ${name}] ledger ${bot.ledger}`)
    if (bot.sessions !== undefined) lines.push(`[bot ${i}] [zone-match ${name}] sessions ${bot.sessions}`)
  })
  return lines
}

function threeBots(overrides: Partial<Record<number, BotLines>> = {}): string[] {
  return logsFor([0, 1, 2].map(i => ({
    ledger: BASE,
    sessions: ZERO,
    ...overrides[i],
  })))
}

test('3 bots with identical ledgers and zero counters give ok', () => {
  const check = checkFullMatchLogs(threeBots(), 3)
  assert.equal(check.ok, true)
  assert.deepEqual(check.problems, [])
  assert.equal(check.rounds, 2)
  assert.equal(check.champion, null)
})

test('a differing ledger names both bots', () => {
  const other = JSON.stringify({
    rounds: [
      { kind: 'race', final: false },
      { kind: 'survival', final: true },
    ],
    champion: 1,
  })
  const check = checkFullMatchLogs(threeBots({ 1: { ledger: other } }), 3)
  assert.equal(check.ok, false)
  assert.ok(check.problems.includes('bot 1 ledger differs from bot 0'))
})

test('a missing sessions line is a problem', () => {
  const check = checkFullMatchLogs(threeBots({ 1: { sessions: undefined } }), 3)
  assert.equal(check.ok, false)
  assert.ok(check.problems.includes('bot 1: no sessions line'))
})

test('desyncs=1 is a problem', () => {
  const check = checkFullMatchLogs(threeBots({ 1: { sessions: 'desyncs=1 resultMismatches=0 malformed=0' } }), 3)
  assert.equal(check.ok, false)
  assert.ok(check.problems.includes('bot 1: desyncs=1'))
})

test('a ledger without a final round is a problem', () => {
  const noFinal = JSON.stringify({
    rounds: [
      { kind: 'race', final: false },
      { kind: 'survival', final: false },
    ],
    champion: null,
  })
  const check = checkFullMatchLogs(threeBots({ 1: { ledger: noFinal } }), 3)
  assert.equal(check.ok, false)
  assert.ok(check.problems.includes('bot 1: last round is not final'))
})

test('a numeric champion allows a non-final last round', () => {
  const champion = JSON.stringify({
    rounds: [
      { kind: 'race', final: false },
      { kind: 'survival', final: false },
    ],
    champion: 2,
  })
  const check = checkFullMatchLogs(logsFor([0, 1, 2].map(() => ({ ledger: champion, sessions: ZERO }))), 3)
  assert.equal(check.ok, true)
  assert.equal(check.champion, 2)
})

test('malformed counters never gate the check', () => {
  const check = checkFullMatchLogs(threeBots({ 1: { sessions: 'desyncs=0 resultMismatches=0 malformed=4' } }), 3)
  assert.equal(check.ok, true)
})
