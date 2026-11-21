import { createEngineHub } from '@royal-fiesta/game/ege/hub'
import type { HubRuntime } from '@royal-fiesta/game/ege/hub'
import { createEngineOnlineShow } from '@royal-fiesta/game/ege/online'
import { onlineMeasurements } from '@royal-fiesta/game/ege/onlineState'
import { createEngineShow } from '@royal-fiesta/game/ege/showRuntime'
import type { EngineShowConfig, EngineShowRuntime } from '@royal-fiesta/game/ege/showTypes'
import type { FlowBackend } from '@royal-fiesta/game/hub/flow'
import { onlineRoster } from '@royal-fiesta/game/net/onlineMatch'
import type { ResolvedCourse } from '@royal-fiesta/sim/course'
import { RefusalError, refuse } from '@royal-fiesta/sim/refusal'
import type { EngineModuleIdentity } from '../../../../tools/egeScripts.ts'
import schemaJson from '../../../../ege.schema.json' with { type: 'json' }
import type { AuthoredShow, PublishedEngine } from '../engineShow/page.ts'

const AREA = 'game-web'
const SEATS = 60
const MAX_HUMANS = 8

export type GameBackend = 'legacy' | 'engine'

/** The `?engine` switch: only an explicit 1 selects the engine; anything else explicit refuses. */
export function selectGameBackend(search: URLSearchParams): GameBackend {
  const values = search.getAll('engine')
  if (values.length === 0 || (values.length === 1 && values[0] === '0')) return 'legacy'
  if (values.length === 1 && values[0] === '1') return 'engine'
  const value = values.join(',')
  throw new RefusalError(AREA, 'query.engine', `'${value}' is not 0 or 1; use ?engine=1 for the engine backend or omit it`)
}

/** The page's exported loaders plus the test seam for the online show factory. */
export interface EngineBackendLoaders {
  publication(): Promise<PublishedEngine>
  authored(): Promise<AuthoredShow>
  onlineShow?: typeof createEngineOnlineShow
}

/** One show's head count, seating and plan; seats is 2..60 and humans 1..min(8, seats). */
export interface EngineShowOptions {
  seed: number
  humans: number
  seats: number
  plan?: readonly number[]
  testMode: boolean
}

export interface EngineBackend {
  readonly identity: EngineModuleIdentity
  readonly authored: AuthoredShow
  config(options: EngineShowOptions): EngineShowConfig
  createHub(spawn: number, bots: number): Promise<HubRuntime>
  createShow(options: EngineShowOptions): Promise<EngineShowRuntime>
  flowBackend(options: { seats: number; testMode: boolean }): FlowBackend
}

function checkOptions(options: EngineShowOptions): void {
  if (!Number.isInteger(options.seats) || options.seats < 2 || options.seats > SEATS) {
    refuse(AREA, 'options', `seats must be an integer in 2..${SEATS}; configured ${String(options.seats)}`)
  }
  const maxHumans = Math.min(MAX_HUMANS, options.seats)
  if (!Number.isInteger(options.humans) || options.humans < 1 || options.humans > maxHumans) {
    refuse(AREA, 'options', `humans must be an integer in 1..${maxHumans}; configured ${String(options.humans)}`)
  }
}

/**
 * Handoff: 'Game switch share 7/8: offline engine start, hub, show, podium and return in the shell' calls
 * loadEngineBackend here and keeps the returned backend. Today it awaits both page loaders and builds the
 * config factory, createHub (fixed seed 0, one human and sixty seats for the hub roster plus the lobby bots),
 * createShow over createEngineShow and the authored publication; selectGameBackend on the same module reads
 * the `?engine` query and createHub/createShow shape the shell's offline show. State passed: the publication
 * identity/script bytes and the authored courses, assets, zones, season, plaza and podium.
 * Handoff: 'Game switch share 8/8: online engine show in the shell through PlayFlow' calls loadEngineBackend
 * here and EngineBackend.flowBackend on the returned backend. flowBackend refuses any plaza other than the
 * authored hub plaza and builds createMatch over the online factory with localPeer from matched.youAre,
 * onlineRoster(matched.players, seats), onlineMeasurements and the matched seed. State passed: this backend's
 * identity and its config builder.
 */
export async function loadEngineBackend(loaders: EngineBackendLoaders): Promise<EngineBackend> {
  const [published, authored] = await Promise.all([loaders.publication(), loaders.authored()])
  const { engine, identity, scriptBytes } = published
  const onlineShow = loaders.onlineShow ?? createEngineOnlineShow
  const config = (options: EngineShowOptions): EngineShowConfig => {
    checkOptions(options)
    return {
      engine,
      schemaText: JSON.stringify(schemaJson),
      scriptBytes,
      identity,
      seed: options.seed,
      courses: authored.courses,
      assets: authored.assets,
      zones: authored.zones,
      season: authored.season,
      humans: Array.from({ length: options.seats }, (_, roomSeat) => roomSeat < options.humans),
      ...(options.plan === undefined ? {} : { plan: options.plan }),
      testMode: options.testMode,
    }
  }
  const createHub = (spawn: number, bots: number): Promise<HubRuntime> =>
    createEngineHub(config({ seed: 0, humans: 1, seats: SEATS, testMode: false }), authored.plaza, spawn, bots)
  const createShow = (options: EngineShowOptions): Promise<EngineShowRuntime> => createEngineShow(config(options))
  const flowBackend = (options: { seats: number; testMode: boolean }): FlowBackend => {
    const onlineConfig = (seed: number, humans: number): EngineShowConfig =>
      config({ seed, humans, seats: options.seats, testMode: options.testMode })
    return {
      identity,
      createHub: (plaza: ResolvedCourse, spawn: number) => {
        if (plaza.id !== authored.plaza.id) {
          refuse(AREA, 'flow.plaza', `expected plaza '${authored.plaza.id}', got '${plaza.id}'; pass the authored hub plaza`)
        }
        return createHub(spawn, 0)
      },
      createMatch: (matched, net) => {
        const roster = onlineRoster(matched.players, options.seats)
        return onlineShow(onlineConfig(matched.seed, matched.players), {
          localPeer: matched.youAre,
          roster,
          transport: net,
          measurements: onlineMeasurements(roster),
        })
      },
    }
  }
  return { identity, authored, config, createHub, createShow, flowBackend }
}
