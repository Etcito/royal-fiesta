// WebRTC backend contract plus the browser implementation (RTCPeerConnection, read at call time).
import { RefusalError } from '@royal-fiesta/sim/refusal'
import type { IceServer } from './roomsProtocol.ts'

export interface RtcChannel { readonly label: 'fast' | 'reliable'; readonly open: boolean; send(data: Uint8Array): void; onMessage(fn: (data: Uint8Array) => void): void; onClose(fn: () => void): void; close(): void }
export interface IceCandidate { candidate: string; sdpMid: string | null; sdpMLineIndex: number | null }
export interface RtcPeer { createOffer(): Promise<string>; acceptOffer(sdp: string): Promise<string>; acceptAnswer(sdp: string): Promise<void>; addIce(c: IceCandidate): void; onIce(fn: (c: IceCandidate | null) => void): void; channels(): Promise<{ fast: RtcChannel; reliable: RtcChannel }>; close(): void }
export interface RtcBackend { createPeer(iceServers: IceServer[], initiator: boolean): RtcPeer }

type Label = 'fast' | 'reliable'

function toBytes(d: unknown): Uint8Array {
  if (d instanceof ArrayBuffer) return new Uint8Array(d)
  if (ArrayBuffer.isView(d)) return new Uint8Array(d.buffer, d.byteOffset, d.byteLength)
  return new TextEncoder().encode(String(d))
}

class BrowserChannel implements RtcChannel {
  readonly label: Label
  private readonly dc: RTCDataChannel
  private readonly msgFns: ((data: Uint8Array) => void)[] = []
  private readonly closeFns: (() => void)[] = []
  // Messages that arrive before the first onMessage handler (the other channel may still be opening).
  private pending: Uint8Array[] | null = []

  constructor(label: Label, dc: RTCDataChannel) {
    this.label = label
    this.dc = dc
    dc.binaryType = 'arraybuffer'
    dc.onmessage = (e) => {
      const bytes = toBytes(e.data)
      if (this.pending) this.pending.push(bytes)
      else for (const fn of this.msgFns) fn(bytes)
    }
    dc.onclose = () => { for (const fn of this.closeFns) fn() }
  }

  get open(): boolean { return this.dc.readyState === 'open' }

  send(data: Uint8Array): void {
    if (!this.open) throw new RefusalError('webrtc', `channel.${this.label}`, `send while ${this.dc.readyState}; wait for channels() and stop sending after close`)
    this.dc.send(data as Uint8Array<ArrayBuffer>)
  }

  onMessage(fn: (data: Uint8Array) => void): void {
    this.msgFns.push(fn)
    for (const d of this.pending ?? []) fn(d)
    this.pending = null
  }

  onClose(fn: () => void): void { this.closeFns.push(fn) }
  close(): void { this.dc.close() }
}

class BrowserPeer implements RtcPeer {
  private readonly pc: RTCPeerConnection
  private readonly iceFns: ((c: IceCandidate | null) => void)[] = []
  private readonly chans: { fast?: BrowserChannel; reliable?: BrowserChannel } = {}
  private readonly earlyIce: IceCandidate[] = []
  private remoteSet = false
  private closed = false
  private readonly ready: Promise<{ fast: RtcChannel; reliable: RtcChannel }>
  private settle!: { resolve: (v: { fast: RtcChannel; reliable: RtcChannel }) => void; reject: (e: Error) => void }

  constructor(Ctor: typeof RTCPeerConnection, iceServers: IceServer[], initiator: boolean) {
    this.ready = new Promise((resolve, reject) => { this.settle = { resolve, reject } })
    this.ready.catch(() => {}) // the caller may never ask for channels()
    this.pc = new Ctor({ iceServers: iceServers.map((s) => ({ ...s })) })
    this.pc.onicecandidate = (e) => {
      const c = e.candidate
      const out = c ? { candidate: c.candidate, sdpMid: c.sdpMid, sdpMLineIndex: c.sdpMLineIndex } : null
      for (const fn of this.iceFns) fn(out)
    }
    this.pc.onconnectionstatechange = () => { if (this.pc.connectionState === 'failed') this.fail('connection failed; check the ICE servers and the network') }
    if (!initiator) this.pc.ondatachannel = (e) => this.track(e.channel)
    else {
      this.track(this.pc.createDataChannel('fast', { ordered: false, maxRetransmits: 0 }))
      this.track(this.pc.createDataChannel('reliable', { ordered: true }))
    }
  }

  private track(dc: RTCDataChannel): void {
    const label = dc.label
    if (label !== 'fast' && label !== 'reliable') { this.fail(`unexpected data channel '${label}'; only 'fast' and 'reliable' are used`); return }
    const ch = new BrowserChannel(label, dc)
    this.chans[label] = ch
    dc.addEventListener('open', () => this.check())
    dc.addEventListener('close', () => this.fail(`channel '${label}' closed before both channels were open`))
    this.check()
  }

  private check(): void {
    const { fast, reliable } = this.chans
    if (fast?.open && reliable?.open) this.settle.resolve({ fast, reliable })
  }

  // No-op once resolved.
  private fail(reason: string): void { this.settle.reject(new RefusalError('webrtc', 'peer', reason)) }

  private async setRemote(type: 'offer' | 'answer', sdp: string): Promise<void> {
    await this.pc.setRemoteDescription({ type, sdp })
    this.remoteSet = true
    for (const c of this.earlyIce.splice(0)) this.applyIce(c)
  }

  private applyIce(c: IceCandidate): void {
    this.pc.addIceCandidate(c).catch((e: unknown) => this.fail(`addIceCandidate refused '${c.candidate}': ${String(e)}`))
  }

  async createOffer(): Promise<string> {
    await this.pc.setLocalDescription(await this.pc.createOffer())
    return this.localSdp('offer')
  }

  async acceptOffer(sdp: string): Promise<string> {
    await this.setRemote('offer', sdp)
    await this.pc.setLocalDescription(await this.pc.createAnswer())
    return this.localSdp('answer')
  }

  acceptAnswer(sdp: string): Promise<void> { return this.setRemote('answer', sdp) }

  private localSdp(what: string): string {
    const sdp = this.pc.localDescription?.sdp
    if (!sdp) throw new RefusalError('webrtc', what, 'no local description after setLocalDescription; the browser WebRTC stack is broken')
    return sdp
  }

  addIce(c: IceCandidate): void {
    if (!this.closed) { if (this.remoteSet) this.applyIce(c); else this.earlyIce.push(c) }
  }

  onIce(fn: (c: IceCandidate | null) => void): void { this.iceFns.push(fn) }
  channels(): Promise<{ fast: RtcChannel; reliable: RtcChannel }> { return this.ready }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.fail('peer closed before both channels were open')
    this.chans.fast?.close()
    this.chans.reliable?.close()
    this.pc.close()
  }
}

export function browserRtcBackend(): RtcBackend {
  const Ctor = (globalThis as { RTCPeerConnection?: typeof RTCPeerConnection }).RTCPeerConnection
  if (typeof Ctor !== 'function') throw new RefusalError('webrtc', 'globalThis.RTCPeerConnection', 'not available in this runtime; use a browser, or the node-datachannel backend in Node')
  return { createPeer: (iceServers, initiator) => new BrowserPeer(Ctor, iceServers, initiator) }
}
