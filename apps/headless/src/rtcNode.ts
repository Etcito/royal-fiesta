// RtcBackend for Node, on node-datachannel (libdatachannel). Node-only: lives in apps/headless.
import { PeerConnection, cleanup } from 'node-datachannel'
import type { DataChannel, DescriptionType } from 'node-datachannel'
import { RefusalError } from '@royal-fiesta/sim/refusal'
import type { IceServer } from '@royal-fiesta/game/net/roomsProtocol'
import type { IceCandidate, RtcBackend, RtcChannel, RtcPeer } from '@royal-fiesta/game/net/rtcBackend'

type Label = 'fast' | 'reliable'
type Chans = { fast: RtcChannel; reliable: RtcChannel }

// Measured in the sandbox (only `lo`): without a bindAddress libdatachannel gathers no candidate.
const DEFAULT_BIND = '127.0.0.1'

class NodeChannel implements RtcChannel {
  readonly label: Label
  private readonly dc: DataChannel
  private readonly msgFns: ((data: Uint8Array) => void)[] = []
  private readonly closeFns: (() => void)[] = []
  // Messages that arrive before the first onMessage handler.
  private pending: Uint8Array[] | null = []

  constructor(label: Label, dc: DataChannel) {
    this.label = label
    this.dc = dc
    dc.onMessage((m) => {
      // Copy: the Buffer may be a view into a pooled slab.
      const bytes = typeof m === 'string' ? new TextEncoder().encode(m) : new Uint8Array(m)
      if (this.pending) this.pending.push(bytes)
      else for (const fn of this.msgFns) fn(bytes)
    })
    dc.onClosed(() => { for (const fn of this.closeFns) fn() })
  }

  get open(): boolean { return this.dc.isOpen() }
  send(data: Uint8Array): void {
    if (!this.open) throw new RefusalError('webrtc', `channel.${this.label}`, 'send while not open; wait for channels() and stop sending after close')
    this.dc.sendMessageBinary(data)
  }

  onMessage(fn: (data: Uint8Array) => void): void {
    this.msgFns.push(fn)
    for (const d of this.pending ?? []) fn(d)
    this.pending = null
  }

  onClose(fn: () => void): void { this.closeFns.push(fn) }
  close(): void { this.dc.close() }
}

class NodePeer implements RtcPeer {
  private readonly pc: PeerConnection
  private readonly iceFns: ((c: IceCandidate | null) => void)[] = []
  private readonly chans: { fast?: NodeChannel; reliable?: NodeChannel } = {}
  private readonly earlyIce: IceCandidate[] = []
  private readonly descs: { type: DescriptionType; sdp: string }[] = []
  private descWait: ((d: { type: DescriptionType; sdp: string }) => void) | null = null
  private remoteSet = false
  private closed = false
  private readonly ready: Promise<Chans>
  private settle!: { resolve: (v: Chans) => void; reject: (e: Error) => void }

  constructor(config: ConstructorParameters<typeof PeerConnection>[1], initiator: boolean) {
    this.ready = new Promise((resolve, reject) => { this.settle = { resolve, reject } })
    this.ready.catch(() => {}) // the caller may never ask for channels()
    this.pc = new PeerConnection(initiator ? 'offerer' : 'answerer', config)
    this.pc.onLocalDescription((sdp, type) => {
      const d = { type, sdp }
      if (this.descWait) { const w = this.descWait; this.descWait = null; w(d) } else this.descs.push(d)
    })
    this.pc.onLocalCandidate((candidate, mid) => this.emitIce({ candidate: candidate.replace(/^a=/, ''), sdpMid: mid, sdpMLineIndex: null }))
    this.pc.onGatheringStateChange((s) => { if (s === 'complete') this.emitIce(null) })
    this.pc.onStateChange((s) => { if (s === 'failed') this.fail(`connection failed (bindAddress ${config.bindAddress ?? 'any'}); check the ICE servers and the network`) })
    if (!initiator) this.pc.onDataChannel((dc) => this.track(dc))
    else {
      // Auto-negotiation: the first channel triggers the offer through onLocalDescription.
      try {
        this.track(this.pc.createDataChannel('fast', { unordered: true, maxRetransmits: 0 }))
        this.track(this.pc.createDataChannel('reliable', {}))
      } catch (e) {
        this.pc.close()
        throw new RefusalError('webrtc', `bindAddress ${config.bindAddress ?? 'any'}`, `${String(e)}; pass a bindAddress of a local interface`)
      }
    }
  }

  private emitIce(c: IceCandidate | null): void { for (const fn of this.iceFns) fn(c) }

  private track(dc: DataChannel): void {
    const label = dc.getLabel()
    if (label !== 'fast' && label !== 'reliable') { this.fail(`unexpected data channel '${label}'; only 'fast' and 'reliable' are used`); return }
    this.chans[label] = new NodeChannel(label, dc)
    dc.onOpen(() => this.check())
    dc.onError((err) => this.fail(`channel '${label}' error: ${err}`))
    this.check() // an incoming channel is already open
  }
  private check(): void {
    const { fast, reliable } = this.chans
    if (fast?.open && reliable?.open) this.settle.resolve({ fast, reliable })
  }

  // No-op once resolved.
  private fail(reason: string): void { this.settle.reject(new RefusalError('webrtc', 'peer', reason)) }
  private nextDesc(want: DescriptionType): Promise<string> {
    return new Promise<{ type: DescriptionType; sdp: string }>((resolve) => {
      const d = this.descs.shift()
      if (d) resolve(d)
      else this.descWait = resolve
    }).then((d) => {
      if (d.type !== want) throw new RefusalError('webrtc', want, `libdatachannel produced a local '${d.type}' instead of '${want}'; the signaling order is wrong`)
      return d.sdp
    })
  }

  private setRemote(type: 'offer' | 'answer', sdp: string): void {
    this.pc.setRemoteDescription(sdp, type)
    this.remoteSet = true
    for (const c of this.earlyIce.splice(0)) this.applyIce(c)
  }

  private applyIce(c: IceCandidate): void {
    try { this.pc.addRemoteCandidate(c.candidate, c.sdpMid ?? '0') } catch (e) { this.fail(`addRemoteCandidate refused '${c.candidate}': ${String(e)}`) }
  }
  createOffer(): Promise<string> { return this.nextDesc('offer') }
  acceptOffer(sdp: string): Promise<string> {
    this.setRemote('offer', sdp)
    return this.nextDesc('answer')
  }

  async acceptAnswer(sdp: string): Promise<void> { this.setRemote('answer', sdp) }
  addIce(c: IceCandidate): void {
    if (!this.closed) { if (this.remoteSet) this.applyIce(c); else this.earlyIce.push(c) }
  }

  onIce(fn: (c: IceCandidate | null) => void): void { this.iceFns.push(fn) }
  channels(): Promise<Chans> { return this.ready }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.fail('peer closed before both channels were open')
    this.chans.fast?.close()
    this.chans.reliable?.close()
    this.pc.close()
  }
}

export function nodeRtcBackend(opts?: { bindAddress?: string; portRange?: [number, number] }): RtcBackend {
  const bindAddress = opts?.bindAddress ?? DEFAULT_BIND
  const range = opts?.portRange
  return {
    createPeer: (iceServers: IceServer[], initiator: boolean) => new NodePeer({
      iceServers: iceServers.flatMap((s) => s.urls), // url strings only
      bindAddress,
      ...(range ? { portRangeBegin: range[0], portRangeEnd: range[1] } : {}),
    }, initiator),
  }
}

// Stops libdatachannel's threads so the process can exit.
export function closeNodeRtc(): void { cleanup() }
