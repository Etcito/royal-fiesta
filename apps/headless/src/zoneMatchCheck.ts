export interface FullMatchCheck {
  ok: boolean
  problems: string[]
  rounds: number
  champion: number | null
}

interface Sessions {
  desyncs: number
  resultMismatches: number
  malformed: number
}

interface Ledger {
  rounds: unknown[]
  champion: number | null
}

interface BotLines {
  ledgers: string[]
  sessions: Sessions[]
  badSessions: number
}

const BOT_PREFIX = /^\[bot (\d+)\] /
const LEDGER_LINE = /^\[zone-match .*?\] ledger (.*)$/
const SESSIONS_LINE = /^\[zone-match .*?\] sessions desyncs=(\d+) resultMismatches=(\d+) malformed=(\d+)$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseLedger(text: string): Ledger | { error: string } {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
  const record = isRecord(value) ? value : {}
  const rounds = Array.isArray(record.rounds) ? record.rounds : []
  const champion = typeof record.champion === 'number' && Number.isFinite(record.champion)
    ? record.champion
    : null
  return { rounds, champion }
}

function roundKind(round: unknown): string | undefined {
  if (!isRecord(round)) return undefined
  if (typeof round.kind === 'string') return round.kind
  const result = round.result
  if (isRecord(result) && typeof result.kind === 'string') return result.kind
  return undefined
}

function roundFinal(round: unknown): boolean {
  if (!isRecord(round)) return false
  if (typeof round.final === 'boolean') return round.final
  const result = round.result
  return isRecord(result) && result.final === true
}

export function checkFullMatchLogs(logs: readonly string[], peers: number): FullMatchCheck {
  const problems: string[] = []
  const count = Number.isInteger(peers) && peers > 0 ? peers : 0
  const perBot: BotLines[] = Array.from({ length: count }, () => ({
    ledgers: [], sessions: [], badSessions: 0,
  }))

  for (const line of logs) {
    const prefix = BOT_PREFIX.exec(line)
    if (prefix === null) continue
    const bot = Number(prefix[1])
    if (bot < 0 || bot >= count) continue
    const rest = line.slice(prefix[0].length)
    const ledger = LEDGER_LINE.exec(rest)
    if (ledger !== null) {
      perBot[bot].ledgers.push(ledger[1].trimEnd())
      continue
    }
    const sessions = SESSIONS_LINE.exec(rest)
    if (sessions !== null) {
      perBot[bot].sessions.push({
        desyncs: Number(sessions[1]),
        resultMismatches: Number(sessions[2]),
        malformed: Number(sessions[3]),
      })
    } else if (/^\[zone-match .*?\] sessions\b/.test(rest)) {
      perBot[bot].badSessions++
    }
  }

  const parsedLedgers: (Ledger | null)[] = []
  for (let i = 0; i < count; i++) {
    const bot = perBot[i]
    if (bot.ledgers.length === 0) {
      problems.push(`bot ${i}: no ledger line`)
      parsedLedgers.push(null)
      continue
    }
    if (bot.ledgers.length > 1) problems.push(`bot ${i}: ${bot.ledgers.length} ledger lines, expected one`)
    let first: Ledger | null = null
    for (const text of bot.ledgers) {
      const parsed = parseLedger(text)
      if ('error' in parsed) problems.push(`bot ${i}: ledger JSON does not parse: ${parsed.error}`)
      else if (first === null) first = parsed
    }
    parsedLedgers.push(first)
  }

  const reference = perBot[0]?.ledgers[0]
  if (reference !== undefined) {
    for (let i = 1; i < count; i++) {
      if (perBot[i].ledgers.some(text => text !== reference)) {
        problems.push(`bot ${i} ledger differs from bot 0`)
      }
    }
  }

  for (let i = 0; i < count; i++) {
    const bot = perBot[i]
    if (bot.sessions.length === 0) {
      problems.push(bot.badSessions === 0
        ? `bot ${i}: no sessions line`
        : `bot ${i}: sessions line does not parse`)
      continue
    }
    for (const sessions of bot.sessions) {
      if (sessions.desyncs !== 0) problems.push(`bot ${i}: desyncs=${sessions.desyncs}`)
      if (sessions.resultMismatches !== 0) {
        problems.push(`bot ${i}: resultMismatches=${sessions.resultMismatches}`)
      }
    }
  }

  for (let i = 0; i < count; i++) {
    const ledger = parsedLedgers[i]
    if (ledger === null) continue
    if (ledger.rounds.length === 0) {
      problems.push(`bot ${i}: ledger has no rounds`)
      continue
    }
    if (!roundFinal(ledger.rounds[ledger.rounds.length - 1]) && ledger.champion === null) {
      problems.push(`bot ${i}: last round is not final`)
    }
    const kinds = new Set(ledger.rounds.map(roundKind))
    if (!kinds.has('race')) problems.push(`bot ${i}: rounds include no race`)
    if (!kinds.has('survival')) problems.push(`bot ${i}: rounds include no survival`)
  }

  const chosen = parsedLedgers.find(ledger => ledger !== null) ?? null
  return {
    ok: problems.length === 0,
    problems,
    rounds: chosen?.rounds.length ?? 0,
    champion: chosen?.champion ?? null,
  }
}
