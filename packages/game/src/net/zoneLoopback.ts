import { NetSim } from '@gamesaloon/rollback'
import type { NetSimOptions } from '@gamesaloon/rollback'
import type { GroupTransport } from '@gamesaloon/rollback/zones'

/** In-process group transport for zone tests: one GroupTransport per peer over one NetSim. */
export class ZoneLoopback {
  readonly net: NetSim

  constructor(peers: number, opts: NetSimOptions)
  constructor(net: NetSim)
  constructor(peersOrNet: number | NetSim, opts?: NetSimOptions) {
    if (typeof peersOrNet === 'number') {
      if (!opts) throw new Error('[zones] zoneLoopback: options are required with a peer count')
      this.net = new NetSim(peersOrNet, opts)
    } else {
      this.net = peersOrNet
    }
  }

  transport(peer: number): GroupTransport {
    const net = this.net.transport(peer)
    return {
      send: (to, ch, data) => net.send(to, ch, data),
      drain: (out) => net.drain(out),
      closed: (other) => net.closed(other),
      now: () => net.now(),
      // NetSim copies the bytes into its packet, so the caller may reuse `data` right after the call.
      sendMany: (peers, ch, data) => {
        for (const to of peers) net.send(to, ch, data)
      },
    }
  }

  advance(ms: number): void {
    this.net.advance(ms)
  }

  now(): number {
    return this.net.now()
  }
}
