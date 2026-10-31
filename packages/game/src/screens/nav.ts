// The game's navigation state machine: pure, headless, no DOM and no clock.
// dispatch() returns the effects the app must run; invalid events return [].
import type { LoadProgress } from '../content.ts'

export const SCREENS = Object.freeze([
  'title', 'hub', 'queue', 'countdown', 'round', 'spectate', 'result', 'podium',
  'pause', 'settings', 'credits', 'error', 'loading', 'lobbyChoice', 'lobbyLive',
  'start', 'vote', 'elimShow', 'endScreen',
] as const)
export type Screen = typeof SCREENS[number]

// Screens only an online session reaches (the online lobby): the offline UI tour cannot capture them.
// Single source of truth: the tour record requires exactly the other SCREENS ids and lists these as not captured.
export const ONLINE_ONLY_SCREENS = Object.freeze(['queue', 'lobbyChoice', 'lobbyLive'] as const satisfies readonly Screen[])
export const OFFLINE_SCREENS: readonly Screen[] = Object.freeze(SCREENS.filter(s => !(ONLINE_ONLY_SCREENS as readonly Screen[]).includes(s)))

// Screens the game itself moves between (with 'game' events).
export const GAME_SCREENS = Object.freeze([
  'hub', 'queue', 'countdown', 'round', 'spectate', 'result', 'podium', 'lobbyChoice', 'lobbyLive',
  'vote', 'elimShow', 'endScreen',
] as const)
export type GameScreen = typeof GAME_SCREENS[number]

export const ACTIONS = Object.freeze([
  'play', 'playOnline', 'settings', 'credits', 'queue', 'toHub', 'resume', 'leave', 'retry',
  'join', 'spectate', 'newLobby', 'shop', 'up', 'down', 'left', 'right', 'confirm',
] as const)
export type Action = typeof ACTIONS[number]

// Screens whose keys and pad events go to the screen model (the show flow) instead of uaa focus.
export const FLOW_SCREENS = Object.freeze(['start', 'vote', 'elimShow'] as const satisfies readonly Screen[])
export type FlowScreen = typeof FLOW_SCREENS[number]

// The flow action of a UI input event: focus -> up/down, adjust -> left/right, select -> confirm.
// Keyboard arrows/Enter and the pad d-pad/stick/A produce these UiEvents in apps/web/src/input/input.ts.
export function flowAction(
  ev: { k: 'focus' | 'adjust'; dir: -1 | 1 } | { k: 'select' } | { k: string },
): Action | null {
  const dir = (ev as { k: string; dir?: -1 | 1 }).dir
  switch (ev.k) {
    case 'focus':
      return dir === -1 ? 'up' : 'down'
    case 'adjust':
      return dir === -1 ? 'left' : 'right'
    case 'select':
      return 'confirm'
    default:
      return null
  }
}

export const Effect = Object.freeze({
  startHub: 'startHub',
  startOnline: 'startOnline',
  enqueue: 'enqueue',
  dequeue: 'dequeue',
  pause: 'pause',
  resume: 'resume',
  leaveMatch: 'leaveMatch',
  leaveGame: 'leaveGame',
  // The online lobby choice (GameSaloon timed lobbies): join it, watch it, or open a new lobby.
  pickJoin: 'pickJoin',
  pickSpectate: 'pickSpectate',
  pickNew: 'pickNew',
  // Back on the choice: take the default now (join a waiting lobby, else a new one).
  pickDefault: 'pickDefault',
  // Run GameContent.load and report it with progress, then loaded or error.
  load: 'load',
  // Open the shop from the start screen: a no-op in the app until M9 wires the shop.
  openShop: 'openShop',
} as const)
export type Effect = typeof Effect[keyof typeof Effect]

export type StartEffect = typeof Effect.startHub | typeof Effect.startOnline

// Where a successful load lands: the title menu, or straight into the hub.
export type LoadNext = 'title' | 'hub'

export type NavEvent =
  | { kind: 'action', action: Action }
  | { kind: 'back' }
  | { kind: 'game', screen: GameScreen }
  | { kind: 'error', message: string }
  | { kind: 'load', next: LoadNext }
  | { kind: 'progress', progress: LoadProgress }
  | { kind: 'loaded' }

const BUTTONS: Readonly<Partial<Record<Screen, readonly Action[]>>> = Object.freeze({
  title: ['play', 'playOnline', 'settings', 'credits'],
  pause: ['resume', 'settings', 'leave'],
  error: ['retry', 'leave'],
  loading: [],
  podium: ['toHub'],
  hub: ['queue'],
  // A player arriving while a lobby waits (lobbyChoice) or plays its round (lobbyLive).
  lobbyChoice: ['join', 'spectate', 'newLobby'],
  lobbyLive: ['spectate', 'newLobby'],
  start: ['play', 'shop'],
  vote: [],
  elimShow: [],
  endScreen: ['confirm'],
})

// Game screens outside a match: the hub, the queue and the lobby choice.
const OUTSIDE_MATCH: readonly Screen[] = ['hub', 'queue', 'lobbyChoice', 'lobbyLive']

// Game screens of a match, where back pauses the game.
const PAUSABLE: readonly Screen[] = ['countdown', 'round', 'spectate', 'result', 'vote', 'elimShow']

export function isGameScreen(s: Screen): s is GameScreen {
  return (GAME_SCREENS as readonly Screen[]).includes(s)
}

export class Nav {
  screen: Screen = 'title'
  // The game screen pause returns to.
  resumeTo: GameScreen = 'hub'
  settingsFrom: 'title' | 'pause' = 'title'
  // A hub or match session is running.
  live = false
  inMatch = false
  error: string | null = null
  lastStart: StartEffect | null = null
  // A build with a baked relay: Play IS Play online (the lobby), and the separate button is not offered.
  onlineOnly = false
  // The latest progress of the running load (null before its first report).
  progress: LoadProgress | null = null
  // The target of a running or failed load; null once content is loaded.
  loadNext: LoadNext | null = null

  clone(): Nav {
    const n = new Nav()
    n.screen = this.screen
    n.resumeTo = this.resumeTo
    n.settingsFrom = this.settingsFrom
    n.live = this.live
    n.inMatch = this.inMatch
    n.error = this.error
    n.lastStart = this.lastStart
    n.onlineOnly = this.onlineOnly
    n.progress = this.progress === null ? null : { ...this.progress }
    n.loadNext = this.loadNext
    return n
  }

  // A stable identity of the whole state, for exploration and tests.
  key(): string {
    return JSON.stringify([this.screen, this.resumeTo, this.settingsFrom, this.live,
      this.inMatch, this.error, this.lastStart, this.progress, this.loadNext, this.onlineOnly])
  }

  // False while a load runs or after it failed: nothing may start without content.
  contentReady(): boolean {
    return this.loadNext === null
  }

  actions(): readonly Action[] {
    // A failed load offers no play button: retry reloads instead.
    if (this.screen === 'title' && !this.contentReady()) return ['retry', 'settings', 'credits']
    const buttons = BUTTONS[this.screen] ?? []
    return this.onlineOnly && this.screen === 'title' ? buttons.filter(a => a !== 'playOnline') : buttons
  }

  dispatch(ev: NavEvent): Effect[] {
    if (ev.kind === 'error') {
      const fx: Effect[] = this.live ? [Effect.leaveGame] : []
      this.screen = 'error'
      this.error = ev.message
      this.live = false
      this.inMatch = false
      this.resumeTo = 'hub'
      return fx
    }
    if (ev.kind === 'load') return this.load(ev.next)
    if (ev.kind === 'progress') {
      if (this.screen !== 'loading') return []
      this.progress = { ...ev.progress }
      return []
    }
    if (ev.kind === 'loaded') return this.loaded()
    // Loading ends only in loaded or error: no back, action or game event skips it.
    if (this.screen === 'loading') return []
    if (ev.kind === 'game') return this.game(ev.screen)
    if (ev.kind === 'back') return this.back()
    if (!this.actions().includes(ev.action)) return []
    return this.action(ev.action)
  }

  private game(to: GameScreen): Effect[] {
    if (!this.live) return []
    const inMatch = !OUTSIDE_MATCH.includes(to)
    if (this.screen === 'pause' || this.screen === 'settings') {
      // The game is paused, so this is rare: only remember where to return.
      this.resumeTo = to
      this.inMatch = inMatch
      return []
    }
    if (!isGameScreen(this.screen) || this.screen === to) return []
    this.screen = to
    this.inMatch = inMatch
    return []
  }

  private back(): Effect[] {
    const s = this.screen
    if (s === 'hub' || PAUSABLE.includes(s)) {
      this.resumeTo = s as GameScreen
      this.screen = 'pause'
      return [Effect.pause]
    }
    switch (s) {
      case 'queue':
        this.screen = 'hub'
        return [Effect.dequeue]
      case 'lobbyChoice':
      case 'lobbyLive':
        // Back takes the default answer and returns to the walkable hub while the lobby replies.
        this.screen = 'hub'
        return [Effect.pickDefault]
      case 'podium':
        return this.toHub()
      case 'start':
        this.screen = 'title'
        return []
      case 'endScreen':
        return this.leaveEndScreen()
      case 'pause':
        this.screen = this.resumeTo
        return [Effect.resume]
      case 'settings':
        this.screen = this.settingsFrom
        return []
      case 'credits':
      case 'error':
        this.screen = 'title'
        return []
      default:
        return []
    }
  }

  private action(a: Action): Effect[] {
    switch (a) {
      case 'play':
        // Title Play opens the start screen; start's Play runs the existing start (hub, or online).
        if (this.screen === 'title') {
          this.screen = 'start'
          return []
        }
        return this.start(this.onlineOnly ? Effect.startOnline : Effect.startHub)
      case 'shop':
        return [Effect.openShop]
      case 'confirm':
        return this.screen === 'endScreen' ? this.leaveEndScreen() : []
      case 'playOnline':
        return this.start(Effect.startOnline)
      case 'settings':
        this.settingsFrom = this.screen === 'pause' ? 'pause' : 'title'
        this.screen = 'settings'
        return []
      case 'credits':
        this.screen = 'credits'
        return []
      case 'queue':
        return [Effect.enqueue]
      case 'join':
        return [Effect.pickJoin]
      case 'spectate':
        return [Effect.pickSpectate]
      case 'newLobby':
        return [Effect.pickNew]
      case 'toHub':
        return this.toHub()
      case 'resume':
        return this.back()
      case 'leave':
        return this.leave()
      case 'retry':
        if (this.loadNext !== null) return this.load(this.loadNext)
        return this.lastStart === null ? [] : this.start(this.lastStart)
      // Flow actions belong to the show flow, not to a nav button.
      case 'up':
      case 'down':
      case 'left':
      case 'right':
        return []
    }
  }

  // Loading starts from a menu with no game running (page boot, or retry).
  private load(next: LoadNext): Effect[] {
    if (this.live || (this.screen !== 'title' && this.screen !== 'error')) return []
    this.screen = 'loading'
    this.loadNext = next
    this.progress = null
    this.error = null
    return [Effect.load]
  }

  private loaded(): Effect[] {
    if (this.screen !== 'loading' || this.loadNext === null) return []
    const next = this.loadNext
    this.loadNext = null
    this.progress = null
    if (next === 'hub') return this.start(this.onlineOnly ? Effect.startOnline : Effect.startHub)
    this.screen = 'title'
    return []
  }

  // Enters the hub screen for a start the app already armed (the online start), WITHOUT replacing lastStart: a
  // retry after an online failure must go online again, never fall back to the in-page loopback hub.
  enterHub(): Effect[] {
    const last = this.lastStart
    const fx = this.start(Effect.startHub)
    this.lastStart = last
    return fx
  }

  private start(fx: StartEffect): Effect[] {
    this.lastStart = fx
    this.error = null
    if (fx === Effect.startHub) {
      this.screen = 'hub'
      this.live = true
      this.inMatch = false
      this.resumeTo = 'hub'
    } else {
      // The app later sends an error or leaves the page.
      this.screen = 'title'
    }
    return [fx]
  }

  private toHub(): Effect[] {
    this.screen = 'hub'
    this.inMatch = false
    this.resumeTo = 'hub'
    return [Effect.leaveMatch]
  }

  // The end screen's Continue (or back) leaves the finished game for the start menu.
  private leaveEndScreen(): Effect[] {
    this.screen = 'start'
    this.live = false
    this.inMatch = false
    this.resumeTo = 'hub'
    return [Effect.leaveGame]
  }

  private leave(): Effect[] {
    if (this.screen === 'error') {
      this.screen = 'title'
      return []
    }
    if (this.inMatch) return [...this.toHub(), Effect.resume]
    this.screen = 'title'
    this.live = false
    this.resumeTo = 'hub'
    return [Effect.leaveGame]
  }
}

// The fixed event list fed to every state when exploring the graph.
export const PROBE_EVENTS: readonly NavEvent[] = Object.freeze([
  ...ACTIONS.map((action): NavEvent => ({ kind: 'action', action })),
  { kind: 'back' },
  ...GAME_SCREENS.map((screen): NavEvent => ({ kind: 'game', screen })),
  { kind: 'error', message: 'x' },
  { kind: 'load', next: 'title' },
  { kind: 'load', next: 'hub' },
  { kind: 'progress', progress: { phase: 'assets', done: 1, total: 2, label: 'x' } },
  { kind: 'loaded' },
])

// Every Nav state reachable from a fresh Nav, in BFS order.
export function navStates(): Nav[] {
  const start = new Nav()
  const seen = new Set([start.key()])
  const order = [start]
  for (let i = 0; i < order.length; i++) {
    for (const ev of PROBE_EVENTS) {
      const n = order[i].clone()
      n.dispatch(ev)
      const k = n.key()
      if (seen.has(k)) continue
      seen.add(k)
      order.push(n)
    }
  }
  return order
}

// For each screen, the sorted distinct other screens one event away.
export function navGraph(): Record<Screen, Screen[]> {
  const edges = new Map<Screen, Set<Screen>>(SCREENS.map((s) => [s, new Set<Screen>()]))
  for (const state of navStates()) {
    for (const ev of PROBE_EVENTS) {
      const n = state.clone()
      n.dispatch(ev)
      if (n.screen !== state.screen) edges.get(state.screen)!.add(n.screen)
    }
  }
  const out = {} as Record<Screen, Screen[]>
  for (const s of SCREENS) out[s] = [...edges.get(s)!].sort()
  return out
}
