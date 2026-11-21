/// <reference types="vite/client" />
import wasmUrl from '@etcito/game-engine/wasm/ege.wasm?url'
import type { EngineShowPageOptions } from './page.ts'
import { mountEngineShow, setEngineShowWasmUrl } from './page.ts'
import { registerEngineShowOps } from './ops.ts'

const AREA = 'engine-show'
const DEFAULT_SEED = 7
const DEFAULT_HUMANS = 1

// The Vite build emits the engine wasm as a hashed asset; page.ts stays independent of that import.
setEngineShowWasmUrl(wasmUrl)

/** Reads the dedicated page's query, defaulting to the locally controlled show: local, sixty seats, one human. */
export function pageOptions(params: URLSearchParams): EngineShowPageOptions {
  const mode = params.get('mode') === 'online' ? 'online' : 'local'
  const humans = integer(params.get('humans'), DEFAULT_HUMANS, 'humans')
  const seed = integer(params.get('seed'), DEFAULT_SEED, 'seed')
  // Captures mount this page without a query; test mode is the default so preparation uses the runtime's
  // minimum presentation waits. `test=0` still offers the same live animation with full presentation waits.
  const testMode = params.get('test') !== '0' && params.get('testMode') !== '0'
  return { mode, testMode, seed, humans }
}

function integer(text: string | null, fallback: number, name: string): number {
  if (text === null || text === '') return fallback
  if (!/^\d+$/.test(text)) throw new Error(`[${AREA}] ${name}: '${text}' is not a non-negative integer`)
  return Number(text)
}

function failure(root: HTMLElement, error: unknown): void {
  const status = root.querySelector<HTMLElement>('#status') ?? root.appendChild(root.ownerDocument.createElement('div'))
  status.id = 'status'
  status.dataset.state = 'error'
  status.textContent = error instanceof Error ? error.message : String(error)
}

function boot(): void {
  const root = document.querySelector<HTMLElement>('#stage')
  if (root === null) throw new Error(`[${AREA}] engine-show.html needs #stage`)
  let options: EngineShowPageOptions
  try {
    options = pageOptions(new URLSearchParams(location.search))
  } catch (error) {
    failure(root, error)
    return
  }
  const mounted = mountEngineShow(root, options)
  // Scenario modules register themselves when they load, so they load before the operation is installed.
  import.meta.glob('./scenarios/*.ts', { eager: true })
  registerEngineShowOps(mounted)
  mounted.then(
    page => { page.ready.catch(() => undefined) },
    error => { failure(root, error) },
  )
}

boot()
