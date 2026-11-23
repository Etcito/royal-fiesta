import { applyLocalScript, formatScriptDiagnostic } from '@royal-fiesta/game/ege/localSwap'
import type { EngineShowRuntime } from '@royal-fiesta/game/ege/showTypes'
import type { PublicationEvent, ScriptPublication } from '../../../../tools/egeScripts.ts'
import type { EngineShowPage } from '../engineShow/page.ts'

/** The Vite custom event that carries a publication; the publisher sends it through server.ws.send. */
export const SCRIPT_PUBLICATION_EVENT = 'rf:script-publication'

/** The transport the reload reads: one publication listener and one byte fetcher. */
export interface SavedScriptSource {
  subscribe: (listener: (publication: ScriptPublication) => void) => () => void
  fetchBytes: (url: string) => Promise<BufferSource>
}

/** The visible reload state: the newest revision, the applied module and the last rejection. */
export interface ScriptReloadStatus {
  state: 'idle' | 'loading' | 'applied' | 'rejected' | 'disposed'
  revision: number
  appliedRevision: number
  generation: number
  moduleKey: string
  error: string | null
  diagnostics: readonly string[]
  applies: number
}

/** The reload's two injectable seams: the swap itself and the status receiver. */
export interface ScriptReloadOptions {
  apply?: (runtime: EngineShowRuntime, publication: ScriptPublication, bytes: BufferSource) => Promise<{ applied: boolean; generation: number; error: string | null }>
  onStatus?: (status: ScriptReloadStatus) => void
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** A failure publication keeps the retained publication's identity and replaces its revision/diagnostics. */
export function publicationOfEvent(event: PublicationEvent): ScriptPublication {
  if (event.status === 'success' && event.publication !== null) return event.publication
  return {
    ...(event.publication ?? { moduleKey: '', schemaKey: 0, wasmUrl: '' }),
    revision: event.revision,
    diagnostics: event.diagnostics,
  }
}

/**
 * Handoff: `attachSavedScriptReload(page: EngineShowPage, runtime: EngineShowRuntime, source: SavedScriptSource,
 * options?: ScriptReloadOptions): () => void` and `hotPublicationSource(hot, base: string): SavedScriptSource`,
 * exported by apps/web/src/engineShowDev/reload.ts, are called by 'Engine show dev page with script status panel'.
 * That card makes one attachment per runtime from its onRuntime handler, receives every ScriptReloadStatus through
 * options.onStatus, and calls the idempotent disposer before attaching the next runtime.
 * Handoff: `attachSavedScriptReload(...)` (same signature) and `publicationOfEvent(event: PublicationEvent):
 * ScriptPublication` are called by 'Saved-script capture scenario: rejected edit kept, saved edit applied in the
 * current round'. That card uses a static SavedScriptSource over the staged events and receives the statuses
 * through options.onStatus.
 */
export function attachSavedScriptReload(
  page: EngineShowPage,
  runtime: EngineShowRuntime,
  source: SavedScriptSource,
  options: ScriptReloadOptions = {},
): () => void {
  const apply = options.apply ?? applyLocalScript
  const status: ScriptReloadStatus = {
    state: 'idle',
    revision: 0,
    appliedRevision: 0,
    generation: 1,
    moduleKey: runtime.identity.moduleKey,
    error: null,
    diagnostics: [],
    applies: 0,
  }
  const publish = (): void => {
    options.onStatus?.({ ...status, diagnostics: [...status.diagnostics] })
  }
  let newest = 0
  let appliedModuleKey = runtime.identity.moduleKey
  let pending: ScriptPublication | null = null
  let busy = false
  let disposed = false
  let settled: ScriptReloadStatus['state'] = 'idle'
  publish()

  const process = async (publication: ScriptPublication): Promise<void> => {
    busy = true
    try {
      status.state = 'loading'
      publish()
      let bytes: BufferSource
      try {
        bytes = await source.fetchBytes(publication.wasmUrl)
      } catch (error) {
        if (disposed) return
        status.state = 'rejected'
        settled = 'rejected'
        status.error = `ege-dev-swap: revision ${publication.revision} bytes could not be fetched from ${publication.wasmUrl}: ${messageOf(error)}`
        status.diagnostics = []
        publish()
        return
      }
      if (disposed) return
      if (publication.revision <= status.appliedRevision) {
        status.state = settled
        publish()
        return
      }
      let result: { applied: boolean; generation: number; error: string | null }
      try {
        result = await apply(runtime, publication, bytes)
      } catch (error) {
        if (disposed) return
        status.state = 'rejected'
        settled = 'rejected'
        status.error = `ege-dev-swap: revision ${publication.revision} could not be applied: ${messageOf(error)}`
        status.diagnostics = []
        publish()
        return
      }
      if (disposed) return
      if (result.applied) {
        status.state = 'applied'
        settled = 'applied'
        status.applies += 1
        status.generation = result.generation
        status.appliedRevision = publication.revision
        status.moduleKey = publication.moduleKey
        status.error = null
        status.diagnostics = []
        appliedModuleKey = publication.moduleKey
      } else {
        status.state = 'rejected'
        settled = 'rejected'
        status.error = result.error
        status.generation = result.generation
        status.diagnostics = []
      }
      publish()
    } finally {
      busy = false
      if (!disposed && pending !== null) {
        const next = pending
        pending = null
        void process(next)
      }
    }
  }

  const unsubscribe = source.subscribe(publication => {
    if (disposed) return
    const previousNewest = newest
    newest = Math.max(newest, publication.revision)
    status.revision = newest
    const compileError = publication.diagnostics.find(diagnostic => diagnostic.severity === 'error')
    if (compileError !== undefined) {
      status.state = 'rejected'
      settled = 'rejected'
      status.error = null
      status.diagnostics = publication.diagnostics.map(formatScriptDiagnostic)
      publish()
      return
    }
    if (publication.moduleKey === appliedModuleKey) {
      publish()
      return
    }
    if (busy) {
      if (publication.revision > previousNewest) pending = publication
      return
    }
    void process(publication)
  })

  return () => {
    if (disposed) return
    disposed = true
    pending = null
    unsubscribe()
    status.state = 'disposed'
    publish()
  }
}

/**
 * Reads publications from the Vite hot channel: subscribe registers on SCRIPT_PUBLICATION_EVENT and unsubscribe
 * removes the same listener through off. fetchBytes resolves new URL(url, base) and refuses a non-ok answer.
 */
export function hotPublicationSource(
  hot: { on(event: string, listener: (data: PublicationEvent) => void): void; off?(event: string, listener: (data: PublicationEvent) => void): void },
  base: string,
): SavedScriptSource {
  return {
    subscribe(listener) {
      const handle = (data: PublicationEvent): void => listener(publicationOfEvent(data))
      hot.on(SCRIPT_PUBLICATION_EVENT, handle)
      return () => { hot.off?.(SCRIPT_PUBLICATION_EVENT, handle) }
    },
    async fetchBytes(url) {
      const href = new URL(url, base)
      const response = await fetch(href, { cache: 'no-cache' })
      if (!response.ok) throw new Error(`ege-dev-swap: ${href} answered ${response.status} ${response.statusText}`)
      return response.arrayBuffer()
    },
  }
}
