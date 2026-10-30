import { existsSync } from 'node:fs'
import { Agent, request as httpRequest } from 'node:http'
import { networkInterfaces } from 'node:os'
import { dirname, join } from 'node:path'
import { launchZoneBots } from '../apps/headless/src/zoneLaunch.ts'
import type { ZoneLaunch } from '../apps/headless/src/zoneLaunch.ts'
import { startGameSaloon } from '../apps/headless/src/gamesaloon.ts'
import { refuse } from '@royal-fiesta/sim/refusal'
import { repoRoot } from './bricks.ts'

export interface ZoneGateRelay {
  localUrl: string
  port: number
  /** One fresh address for the GPU browser; each browser connection gets its own exposed listener. */
  expose(): Promise<string>
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

// The card sandbox has loopback only. The harness exposes one of its ports to the GPU browser
// (bridge.py's --expose: POST NMC_EXPOSE_URL/<port> gives the host-side address the page connects to).
function exposeAddress(port: number): Promise<string> {
  const base = process.env.NMC_EXPOSE_URL!.replace(/\/+$/, '')
  let url: URL
  try { url = new URL(`${base}/${port}`) } catch {
    refuse('zone-gate', 'NMC_EXPOSE_URL', `is not a URL (${base}); fix it or set RF_GATE_RELAY_HOST`)
  }
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method: 'POST', agent: new Agent(), timeout: 15000 }, res => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => {
        text += chunk
        if (text.length > 4096) req.destroy(new Error(`expose ${port}: answer is too large`))
      })
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`expose ${port} refused: HTTP ${res.statusCode} ${text.slice(0, 200)}`))
          return
        }
        let value: unknown
        try { value = JSON.parse(text) } catch {
          reject(new Error(`expose ${port}: not JSON: ${text.slice(0, 200)}`))
          return
        }
        const address = (value as { address?: unknown } | null)?.address
        if (typeof address !== 'string' || !/^\S+:\d+$/.test(address)) {
          reject(new Error(`expose ${port}: missing a host:port address`))
          return
        }
        resolve(address)
      })
    })
    req.on('timeout', () => req.destroy(new Error(`expose ${port}: no answer within 15 s`)))
    req.on('error', reject)
    req.end()
  })
}

async function browserAddress(port: number): Promise<string> {
  const override = process.env.RF_GATE_RELAY_HOST
  if (override) return `${override}:${port}`
  if (process.env.NMC_EXPOSE_URL) return exposeAddress(port)
  for (const infos of Object.values(networkInterfaces())) {
    for (const info of infos ?? []) {
      if (info.family === 'IPv4' && !info.internal) return `${info.address}:${port}`
    }
  }
  refuse('zone-gate', 'RF_GATE_RELAY_HOST', 'no address the GPU client browser can reach; set RF_GATE_RELAY_HOST')
}

export async function startZoneGateRelay(): Promise<ZoneGateRelay> {
  const dir = relayDir()
  process.env.GAMESALOON_DIR = dir
  const server = await startGameSaloon({ env: { HOST: '0.0.0.0', RELAY_GAMES: 'royal-fiesta:64' }, timeoutMs: 20000 })
  return {
    localUrl: `ws://127.0.0.1:${server.port}/ws`,
    port: server.port,
    expose: async () => `ws://${await browserAddress(server.port)}/ws`,
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
