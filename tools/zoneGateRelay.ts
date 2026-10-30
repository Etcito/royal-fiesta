import { existsSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { dirname, join } from 'node:path'
import { launchZoneBots } from '../apps/headless/src/zoneLaunch.ts'
import type { ZoneLaunch } from '../apps/headless/src/zoneLaunch.ts'
import { startGameSaloon } from '../apps/headless/src/gamesaloon.ts'
import { refuse } from '@royal-fiesta/sim/refusal'
import { repoRoot } from './bricks.ts'

export interface ZoneGateRelay {
  localUrl: string
  browserUrl: string
  port: number
  stop(): Promise<void>
}

export interface GateBotOptions {
  peers?: number
  seatsPerPeer?: number
  players?: number
  course?: string
  seconds?: number
  namePrefix?: string
}

function relayDir(): string {
  const root = repoRoot()
  const candidates = [
    process.env.GAMESALOON_RELAY_DIR,
    join(dirname(root), 'gamesaloon-relay'),
    join(dirname(root), 'gamesaloon'),
  ].filter((dir): dir is string => Boolean(dir))
  for (const dir of candidates) {
    if (existsSync(join(dir, 'src', 'relay', 'binary.ts')) && existsSync(join(dir, 'src', 'relay', 'gameQueues.ts'))) return dir
  }
  refuse('zone-gate', 'GAMESALOON_RELAY_DIR', 'no linked gamesaloon-relay checkout with src/relay/binary.ts and src/relay/gameQueues.ts; link the zone-capable relay next to this repo or set GAMESALOON_RELAY_DIR')
}

function browserHost(): string {
  const override = process.env.RF_GATE_RELAY_HOST
  if (override) return override
  for (const infos of Object.values(networkInterfaces())) {
    for (const info of infos ?? []) {
      if (info.family === 'IPv4' && !info.internal) return info.address
    }
  }
  refuse('zone-gate', 'RF_GATE_RELAY_HOST', 'no address the GPU client browser can reach; set RF_GATE_RELAY_HOST')
}

export async function startZoneGateRelay(): Promise<ZoneGateRelay> {
  const host = browserHost()
  const dir = relayDir()
  process.env.GAMESALOON_DIR = dir
  const server = await startGameSaloon({ env: { HOST: '0.0.0.0', RELAY_GAMES: 'royal-fiesta:64' }, timeoutMs: 20000 })
  return {
    localUrl: `ws://127.0.0.1:${server.port}/ws`,
    browserUrl: `ws://${host}:${server.port}/ws`,
    port: server.port,
    stop: () => server.stop(),
  }
}

export function startGateBots(localUrl: string, options: GateBotOptions = {}): ZoneLaunch {
  return launchZoneBots({
    relay: localUrl,
    peers: options.peers ?? 6,
    seats: options.seatsPerPeer ?? 2,
    players: options.players ?? 8,
    course: options.course ?? 'race-sprint',
    seconds: options.seconds ?? 600,
    namePrefix: options.namePrefix ?? 'gate-bot',
  })
}
