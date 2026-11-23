/// <reference types="vite/client" />
import wasmUrl from '@etcito/game-engine/wasm/ege.wasm?url'
import { localSwapState, releaseLocalSwap } from '@royal-fiesta/game/ege/localSwap'
import type { EngineShowRuntime } from '@royal-fiesta/game/ege/showTypes'
import type { EngineShowPage, EngineShowPageOptions } from '../engineShow/page.ts'
import { mountEngineShow, setEngineShowWasmUrl } from '../engineShow/page.ts'
import { attachSavedScriptReload, hotPublicationSource, type ScriptReloadStatus } from './reload.ts'
import { createScriptStatus } from './status.ts'

const AREA = 'engine-show-dev'
const DEFAULT_SEED = 7
const DEFAULT_HUMANS = 1
const STATUS_INTERVAL_MS = 500
const NO_SOURCE = 'no live publication source: open engine-show-dev.html through the Vite dev server so saved scripts publish'

// The Vite build emits the engine wasm as a hashed asset; page.ts stays independent of that import.
setEngineShowWasmUrl(wasmUrl)

/** The dev page always mounts the local show; seed and humans are non-negative integers from the query. */
function devOptions(params: URLSearchParams): EngineShowPageOptions {
  return {
    mode: 'local',
    testMode: params.get('test') === '1',
    seed: count(params.get('seed'), DEFAULT_SEED, 'seed'),
    humans: count(params.get('humans'), DEFAULT_HUMANS, 'humans'),
  }
}

function count(text: string | null, fallback: number, name: string): number {
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
  if (root === null) throw new Error(`[${AREA}] engine-show-dev.html needs #stage`)
  let options: EngineShowPageOptions
  try {
    options = devOptions(new URLSearchParams(location.search))
  } catch (error) {
    failure(root, error)
    return
  }
  const panel = createScriptStatus(root)
  let page: EngineShowPage | null = null
  let queued: EngineShowRuntime | null = null
  let attached: { runtime: EngineShowRuntime; detach: () => void } | null = null
  let latest: ScriptReloadStatus | null = null

  const refresh = (): void => {
    if (page === null || attached === null || latest === null) return
    panel.update(latest, page.state().faults + localSwapState(attached.runtime).faults)
  }

  const attach = (mounted: EngineShowPage, runtime: EngineShowRuntime): void => {
    latest = null
    const hot = import.meta.hot
    const current = { runtime, detach: (): void => undefined }
    attached = current
    if (hot === undefined) {
      latest = {
        state: 'rejected',
        revision: 0,
        appliedRevision: 0,
        generation: 1,
        moduleKey: runtime.identity.moduleKey,
        error: NO_SOURCE,
        diagnostics: [],
        applies: 0,
      }
      refresh()
      return
    }
    current.detach = attachSavedScriptReload(mounted, runtime, hotPublicationSource(hot, document.baseURI), {
      onStatus: status => {
        latest = status
        refresh()
      },
    })
  }

  // Each new runtime replaces the previous attachment; the previous runtime's swap state is released.
  const onRuntime = (runtime: EngineShowRuntime): void => {
    if (attached !== null) {
      attached.detach()
      releaseLocalSwap(attached.runtime)
      attached = null
    }
    if (queued !== null) releaseLocalSwap(queued)
    queued = runtime
    if (page !== null) {
      const next = queued
      queued = null
      attach(page, next)
    }
  }

  mountEngineShow(root, { ...options, onRuntime }).then(
    mounted => {
      page = mounted
      mounted.ready.catch(() => undefined)
      if (queued !== null) {
        const next = queued
        queued = null
        attach(mounted, next)
      }
    },
    error => {
      failure(root, error)
    },
  )
  setInterval(refresh, STATUS_INTERVAL_MS)
}

boot()
