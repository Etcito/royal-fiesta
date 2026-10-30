// Wavedash SDK contract (docs/wavedash.md R3, "Loader contract"). The Wavedash shell keeps the game frame hidden
// behind its own "Still Loading 0%" screen until the game calls Wavedash.init() (which also signals loadComplete);
// Wavedash.updateLoadProgressZeroToOne(p) drives that screen's bar. The shell injects the global before the page's
// code runs; off Wavedash there is no global and every call here is a no-op. Nothing here throws: a missing or
// failing SDK must never stop the game. Pure over an injected global `g` so it runs in Node tests.

export interface WavedashSdk {
  init(config?: { debug?: boolean }): unknown
  updateLoadProgressZeroToOne?(progress: number): void
  getLaunchParams?(): unknown
  // docs.wavedash.com/sdk/players: the signed-in player's display name (sync), and the profile object.
  getUsername?(): unknown
  getUser?(): unknown
}

export interface PageGlobal {
  Wavedash?: unknown
  location?: { hostname?: string }
}

export type WavedashInit = 'called' | 'absent' | 'failed'

const WAVEDASH_HOST = 'builds.wavedashcdn.com'

/** R9: Wavedash serves the game from a subdomain of builds.wavedashcdn.com. */
export function onWavedashOrigin(hostname: string): boolean {
  return hostname === WAVEDASH_HOST || hostname.endsWith(`.${WAVEDASH_HOST}`)
}

export function wavedashSdk(g: PageGlobal = globalThis as PageGlobal): WavedashSdk | null {
  const sdk = g.Wavedash
  if (typeof sdk !== 'object' || sdk === null) return null
  return typeof (sdk as { init?: unknown }).init === 'function' ? sdk as WavedashSdk : null
}

interface Reported { progress: number; sent: boolean; init: WavedashInit | null }
const reported = new WeakMap<object, Reported>()

function stateOf(g: object): Reported {
  let s = reported.get(g)
  if (s === undefined) {
    s = { progress: 0, sent: false, init: null }
    reported.set(g, s)
  }
  return s
}

/** Reports load progress in [0, 1] to the shell's bar: never backwards, never after init(). */
export function wavedashProgress(fraction: number, g: PageGlobal = globalThis as PageGlobal): void {
  const sdk = wavedashSdk(g)
  const s = stateOf(g)
  if (sdk === null || s.init !== null || typeof sdk.updateLoadProgressZeroToOne !== 'function') return
  const p = Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0
  if (s.sent && p <= s.progress) return
  s.sent = true
  s.progress = p
  try {
    sdk.updateLoadProgressZeroToOne.call(sdk, s.progress)
  } catch (e) {
    console.warn('[wavedash] updateLoadProgressZeroToOne failed:', e)
  }
}

/**
 * Wavedash.init() once per page: the shell then drops its loading screen and shows the frame. Called when the title
 * (or the error screen) is up. Returns what happened; 'absent' off Wavedash. A second call returns the first result.
 */
export function wavedashReady(g: PageGlobal = globalThis as PageGlobal): WavedashInit {
  const s = stateOf(g)
  if (s.init === 'called' || s.init === 'failed') return s.init
  const sdk = wavedashSdk(g)
  if (sdk === null) {
    if (onWavedashOrigin(g.location?.hostname ?? '')) console.warn('[wavedash] no Wavedash.init on the Wavedash origin: the shell will keep its loading screen')
    return 'absent'
  }
  wavedashProgress(1, g)
  try {
    sdk.init.call(sdk, { debug: false })
    s.init = 'called'
    console.info('[wavedash] init() called: the shell shows the game')
  } catch (e) {
    s.init = 'failed'
    console.error('[wavedash] init() failed:', e)
  }
  return s.init
}

// --- boot stages ---

/**
 * Names each boot stage on the console with its time since page start, and when one stage lasts longer than
 * stallMs, reports it (onStall) so the loading screen says where a stuck boot is. done() stops the watch.
 */
export class BootStages {
  private stage = 'page'
  private since: number
  private readonly t0: number
  private timer: ReturnType<typeof setInterval> | null = null
  private stalledOn: string | null = null
  private readonly onStall: (stage: string, seconds: number) => void
  private readonly now: () => number
  private readonly stallMs: number
  private readonly log: (line: string) => void

  constructor(
    onStall: (stage: string, seconds: number) => void,
    now: () => number = () => performance.now(),
    stallMs = 10_000,
    log: (line: string) => void = line => console.info(line),
  ) {
    this.onStall = onStall
    this.now = now
    this.stallMs = stallMs
    this.log = log
    this.t0 = this.now()
    this.since = this.t0
    this.timer = setInterval(() => this.check(), 1000)
  }

  enter(stage: string): void {
    const t = this.now()
    this.log(`[boot] +${((t - this.t0) / 1000).toFixed(1)}s ${stage} (after ${this.stage}: ${((t - this.since) / 1000).toFixed(1)}s)`)
    this.stage = stage
    this.since = t
    this.stalledOn = null
  }

  /** The stall check, also driven by tests without the interval. */
  check(): void {
    const ms = this.now() - this.since
    if (this.timer === null || ms < this.stallMs) return
    const seconds = Math.round(ms / 1000)
    if (this.stalledOn !== this.stage) this.log(`[boot] stage '${this.stage}' has taken ${seconds}s`)
    this.stalledOn = this.stage
    this.onStall(this.stage, seconds)
  }

  done(): void {
    if (this.timer === null) return
    this.enter('done')
    clearInterval(this.timer)
    this.timer = null
  }

  get current(): string { return this.stage }
}

// --- player name ---

/**
 * The signed-in player's Wavedash display name (Wavedash.getUsername(), else getUser().username), for the name tag
 * the other players see; null off Wavedash or when the SDK has none. Only the public display name is read: never the
 * user id, avatar or anything else. Control characters are dropped and it is cut to 24 characters. Never throws.
 */
export function wavedashUsername(g: PageGlobal = globalThis as PageGlobal): string | null {
  const sdk = wavedashSdk(g)
  if (sdk === null) return null
  let raw: unknown = null
  try {
    if (typeof sdk.getUsername === 'function') raw = sdk.getUsername.call(sdk)
    if ((typeof raw !== 'string' || raw.trim() === '') && typeof sdk.getUser === 'function') {
      const user = sdk.getUser.call(sdk)
      raw = typeof user === 'object' && user !== null ? (user as { username?: unknown }).username : null
    }
  } catch (e) {
    console.warn('[wavedash] no player name:', e)
    return null
  }
  if (typeof raw !== 'string') return null
  let name = ''
  for (const ch of raw) {
    const c = ch.codePointAt(0)!
    if (c >= 0x20 && c !== 0x7f) name += ch
  }
  name = [...name.trim()].slice(0, 24).join('').trim()
  return name.length > 0 ? name : null
}
