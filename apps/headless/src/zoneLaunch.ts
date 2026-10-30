// Launch every headless peer of one zone match together.
import { spawn } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { isRefusal, refuse } from '@royal-fiesta/sim/refusal'

export interface ZoneLaunchOptions {
  relay: string
  peers: number
  seats: number
  players: number
  course: string
  seconds: number
  namePrefix?: string
}

export interface ZoneLaunch {
  done: Promise<number[]>
  logs: string[]
  stop(): void
}

export function launchZoneBots(options: ZoneLaunchOptions): ZoneLaunch {
  let relay: URL
  try { relay = new URL(options.relay) } catch {
    refuse('zone', '--relay', 'missing or invalid websocket URL; pass --relay ws://host:port/ws')
  }
  if (relay.protocol !== 'ws:' && relay.protocol !== 'wss:') {
    refuse('zone', '--relay', 'expected a websocket URL; pass --relay ws://host:port/ws')
  }
  if (!Number.isInteger(options.peers) || options.peers < 1 || options.peers > 63) {
    refuse('zone', '--peers', 'expected an integer in 1..63; pass the number of bot peers')
  }
  if (!Number.isInteger(options.seats) || options.seats < 1 || options.seats > 4) {
    refuse('zone', '--seats', 'expected an integer in 1..4; pass the local seats per peer')
  }
  if (!Number.isInteger(options.players) || options.players < options.peers) {
    refuse('zone', '--players', 'expected an integer >= peers; pass the zone room peer count')
  }
  if (!Number.isFinite(options.seconds) || options.seconds < 0) {
    refuse('zone', '--seconds', 'expected a non-negative number; pass the seconds to play')
  }
  if (!options.course) refuse('zone', '--course', 'missing course id; pass --course race-sprint')
  const root = fileURLToPath(new URL('../../../', import.meta.url))
  const script = 'apps/headless/src/zoneBot.ts'
  // All bots belong to ONE match and must run concurrently: the NMC_CPUS sweep cap does not apply.
  const logs: string[] = []
  const children = Array.from({ length: options.peers }, (_, i) => {
    const child = spawn(process.execPath, ['--experimental-strip-types', script,
      '--relay', options.relay, '--players', String(options.players), '--seats', String(options.seats),
      '--course', options.course, '--seconds', String(options.seconds),
      '--name', `${options.namePrefix ?? 'zone-bot'}-${i}`,
    ], { cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    for (const [stream, output] of [[child.stdout, process.stdout], [child.stderr, process.stderr]] as const) {
      createInterface({ input: stream!, crlfDelay: Infinity }).on('line', line => {
        const message = `[bot ${i}] ${line}`
        logs.push(message)
        output.write(`${message}\n`)
      })
    }
    return child
  })
  const exited = children.map(() => false)
  const exits = children.map((child, i) => new Promise<number>(resolve => {
    child.once('error', error => {
      const message = `[bot ${i}] ${error.message}`
      logs.push(message)
      process.stderr.write(`${message}\n`)
      exited[i] = true
      resolve(1)
    })
    child.once('close', (code, signal) => {
      const message = `[bot ${i}] exit code=${code} signal=${signal} requestedStop=${stopping}`
      logs.push(message)
      process.stdout.write(`${message}\n`)
      exited[i] = true
      resolve(code ?? 1)
    })
  }))
  let killTimer: ReturnType<typeof setTimeout> | undefined
  let stopping = false
  const done = Promise.all(exits).finally(() => clearTimeout(killTimer))
  function stop(): void {
    if (stopping) return
    stopping = true
    children.forEach((child, i) => { if (!exited[i]) child.kill('SIGTERM') })
    killTimer = setTimeout(() => {
      children.forEach((child, i) => { if (!exited[i]) child.kill('SIGKILL') })
    }, 3000)
    killTimer.unref()
  }
  return { done, logs, stop }
}

async function runCli(): Promise<number> {
  try {
    const { values } = parseArgs({ options: {
      relay: { type: 'string' }, peers: { type: 'string', default: '6' },
      seats: { type: 'string', default: '2' }, players: { type: 'string' },
      course: { type: 'string', default: 'race-sprint' }, seconds: { type: 'string', default: '300' },
    } })
    const bots = launchZoneBots({ relay: values.relay ?? '', peers: Number(values.peers),
      seats: Number(values.seats), players: Number(values.players ?? values.peers),
      course: values.course, seconds: Number(values.seconds) })
    const stop = (): void => bots.stop()
    process.on('SIGINT', stop)
    try { return (await bots.done).some(code => code !== 0) ? 1 : 0 }
    finally { process.off('SIGINT', stop) }
  } catch (error) {
    console.error(isRefusal(error) ? error.message : String(error))
    return 1
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = await runCli()
}
