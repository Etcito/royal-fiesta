// The title's 'Play online': probe the GameSaloon relay, then hand over to play.html or show why not.
import { isRefusal, refuse } from '@royal-fiesta/sim/refusal'
import { RelayClient } from '../net/relayClient.ts'
import type { WsFactory } from '../net/ws.ts'

export type ProbeResult = { ok: true } | { ok: false; message: string }

export const PROBE_TIMEOUT_MS = 3000

// Never throws: every failure becomes a message the error screen can show.
export async function probeRelay(url: string, ws: WsFactory, timeoutMs = PROBE_TIMEOUT_MS): Promise<ProbeResult> {
  if (!/^wss?:\/\/./.test(url)) {
    return { ok: false, message: `[online] server: '${url}' is not a ws:// or wss:// URL; pass ?server=ws://host:port/ws on game.html` }
  }
  try {
    const client = new RelayClient(url, ws)
    await client.connect(timeoutMs)
    client.close()
    return { ok: true }
  } catch (e) {
    const cause = isRefusal(e) ? e.reason : e instanceof Error ? e.message : String(e)
    return { ok: false, message: `[online] ${url}: could not reach the GameSaloon relay (${cause}); start a GameSaloon server or choose Play to play against bots` }
  }
}

// Same limits as play/main.ts parseQuery, so play.html never refuses what this builds.
export function onlinePlayUrl(server: string, name: string, colour: number): string {
  if (name.length < 1 || name.length > 24) refuse('online', 'name', `has ${name.length} characters; choose a name of 1..24 characters`)
  if (!Number.isInteger(colour) || colour < 0 || colour > 7) refuse('online', 'colour', `${colour} is not an integer in 0..7; pick one of the 8 palette colours`)
  return `play.html?server=${encodeURIComponent(server)}&name=${encodeURIComponent(name)}&colour=${colour}`
}
