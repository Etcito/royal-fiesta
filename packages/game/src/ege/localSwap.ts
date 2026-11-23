import { EgeError, EgeStatus } from '@etcito/game-engine/abi'
import { loadScript } from '@etcito/game-engine/script'
import type { ScriptModule } from '@etcito/game-engine/script'
import type { ScriptPublication } from '../../../../tools/egeScripts.ts'
import type { EngineShowRuntime, EngineWorldRef } from './showTypes.ts'

/** One local swap registry row: the applied module, its revision/generation and the faults it accumulated. */
interface LocalSwapState {
  generation: number
  revision: number
  requested: number
  moduleKey: string
  applied: ScriptModule | null
  faults: number
  unsubscribe: (() => void) | null
}

/** One source diagnostic in the shape the script tools publish it. */
export interface ScriptDiagnostic {
  file: string
  line: number
  column: number
  code: string
  message: string
}

export const LOCAL_SWAP_AREA: string = 'ege-local-swap'

const states = new WeakMap<EngineShowRuntime, LocalSwapState>()

function stateOf(runtime: EngineShowRuntime): LocalSwapState {
  let state = states.get(runtime)
  if (state === undefined) {
    state = {
      generation: 1,
      revision: 0,
      requested: 0,
      moduleKey: runtime.identity.moduleKey,
      applied: null,
      faults: 0,
      unsubscribe: null,
    }
    states.set(runtime, state)
  }
  return state
}

function refused(state: LocalSwapState, error: string): { applied: false; generation: number; error: string } {
  return { applied: false, generation: state.generation, error }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Counts a loaded module's faults once and disposes it; the same module is never disposed twice. */
function dropModule(state: LocalSwapState, module: ScriptModule): void {
  state.faults += module.faultCount
  module.dispose()
}

/** The live world references, or null when the runtime is disposed (its worlds() refuses). */
function liveRefs(runtime: EngineShowRuntime): readonly EngineWorldRef[] | null {
  try {
    return runtime.worlds()
  } catch {
    return null
  }
}

/**
 * Handoff: `applyLocalScript(runtime: EngineShowRuntime, publication: ScriptPublication, bytes: BufferSource):
 * Promise<{applied: boolean, generation: number, error: string | null}>`, exported by
 * packages/game/src/ege/localSwap.ts, is called by 'Local swap tests: refusals, atomicity, preserved state and
 * effects'. That card imports it directly, together with `localSwapState`, `releaseLocalSwap` and
 * `formatScriptDiagnostic`. The state they share is this file's module WeakMap registry keyed by
 * EngineShowRuntime -> {generation, revision, requested, moduleKey, applied ScriptModule, faults, presentation
 * unsubscribe}.
 * Handoff: `applyLocalScript(...)` (same signature) is the default apply of 'Saved-script reload: coalesced
 * publications, stale completions and disposal', and that card also calls `formatScriptDiagnostic(d: {file: string,
 * line: number, column: number, code: string, message: string}): string` for its diagnostic lines. It imports both
 * through '@royal-fiesta/game/ege/localSwap'. It passes the runtime, the publication and the fetched bytes, and
 * reads only the returned {applied, generation, error}. The state lives in the same registry.
 */
export async function applyLocalScript(
  runtime: EngineShowRuntime,
  publication: ScriptPublication,
  bytes: BufferSource,
): Promise<{ applied: boolean; generation: number; error: string | null }> {
  const state = stateOf(runtime)
  const refs = liveRefs(runtime)
  if (refs === null) return refused(state, 'ege-local-swap: the show runtime is disposed; nothing was swapped')
  if (runtime.mode === 'online') {
    return refused(state, 'ege-local-swap: online shows refuse script reload; switch to mode=local to apply saved scripts')
  }
  const revision = publication.revision
  const compileError = publication.diagnostics.find(diagnostic => diagnostic.severity === 'error')
  if (compileError !== undefined) {
    return refused(state, `ege-local-swap: revision ${revision} has compile errors; the running module is kept: ${formatScriptDiagnostic(compileError)}`)
  }
  if (revision <= state.revision) {
    return refused(state, `ege-local-swap: revision ${revision} is not newer than applied revision ${state.revision}; the newer module stays`)
  }
  state.requested = Math.max(state.requested, revision)
  if (publication.schemaKey !== runtime.identity.schemaKey) {
    return refused(state, `ege-local-swap: revision ${revision} was compiled for schema key ${publication.schemaKey} but the running show uses ${runtime.identity.schemaKey}; schema changes need a local restart (reload the page)`)
  }
  let module: ScriptModule
  try {
    module = await loadScript(refs[0].timeline.module.engine, bytes, { name: `rf-scripts-r${revision}` })
  } catch (error) {
    if (error instanceof EgeError && error.code === EgeStatus.SCHEMA) {
      return refused(state, `ege-local-swap: revision ${revision} was compiled for another schema; schema changes need a local restart (reload the page)`)
    }
    return refused(state, `ege-local-swap: revision ${revision} could not be loaded: ${messageOf(error)}; the running module is kept`)
  }
  const live = liveRefs(runtime)
  if (live === null) {
    dropModule(state, module)
    return refused(state, 'ege-local-swap: the show runtime is disposed; nothing was swapped')
  }
  if (revision < state.requested) {
    dropModule(state, module)
    return refused(state, `ege-local-swap: revision ${revision} was superseded by revision ${state.requested} while loading; the newer request wins`)
  }
  for (const ref of live) {
    try {
      module.validateFor(ref.world)
    } catch (error) {
      dropModule(state, module)
      return refused(state, `ege-local-swap: revision ${revision} does not serve world ${ref.world} (${ref.kind}): ${messageOf(error)}; no timeline was changed`)
    }
  }
  for (const ref of live) ref.timeline.swap(module)
  const previous = state.applied
  state.applied = module
  if (previous !== null) dropModule(state, previous)
  state.generation += 1
  state.revision = revision
  state.moduleKey = publication.moduleKey
  if (state.unsubscribe === null) {
    state.unsubscribe = runtime.onPresentation(observation => observeLaterWorlds(runtime, state, observation))
  }
  return { applied: true, generation: state.generation, error: null }
}

/**
 * Applies the module to every world created after the swap at its first post-tick observation; the creating
 * tick itself ran the factory's admitted module. A world the module cannot serve throws the E6 text.
 */
function observeLaterWorlds(
  runtime: EngineShowRuntime,
  state: LocalSwapState,
  observation: { readonly kind: 'post-tick' | 'before-release' },
): void {
  if (observation.kind !== 'post-tick') return
  const applied = state.applied
  if (applied === null) return
  const pending: EngineWorldRef[] = []
  for (const ref of runtime.worlds()) {
    if (ref.timeline.module === applied) continue
    try {
      applied.validateFor(ref.world)
    } catch (error) {
      throw new Error(`ege-local-swap: revision ${state.revision} does not serve world ${ref.world} (${ref.kind}): ${messageOf(error)}; no timeline was changed`)
    }
    pending.push(ref)
  }
  for (const ref of pending) ref.timeline.swap(applied)
}

/**
 * Handoff: `localSwapState(runtime: EngineShowRuntime): {generation: number, revision: number, moduleKey: string,
 * faults: number}` and `releaseLocalSwap(runtime: EngineShowRuntime): void` are called by 'Engine show dev page
 * with script status panel' from its onRuntime handler: the status faults and moduleKey come from localSwapState,
 * and the previous runtime is released through releaseLocalSwap. The state lives in the same registry.
 * Handoff: `localSwapState(...)` and `applyLocalScript(...)`, both exported by packages/game/src/ege/localSwap.ts,
 * are used by 'Saved-script capture scenario: rejected edit kept, saved edit applied in the current round'. That
 * card imports localSwapState through '@royal-fiesta/game/ege/localSwap' and reads it for its swap.generation,
 * swap.moduleChanged and swap.faults facts. It reaches applyLocalScript only as the default apply of
 * attachSavedScriptReload. The state lives in the same WeakMap registry keyed by EngineShowRuntime.
 */
export function localSwapState(
  runtime: EngineShowRuntime,
): { generation: number; revision: number; moduleKey: string; faults: number } {
  const state = stateOf(runtime)
  return {
    generation: state.generation,
    revision: state.revision,
    moduleKey: state.moduleKey,
    faults: state.faults + (state.applied === null ? 0 : state.applied.faultCount),
  }
}

/**
 * Stops observing the runtime and disposes the applied module once the runtime is disposed or no live timeline
 * references it; the state stays readable. Idempotent.
 */
export function releaseLocalSwap(runtime: EngineShowRuntime): void {
  const state = states.get(runtime)
  if (state === undefined) return
  if (state.unsubscribe !== null) {
    state.unsubscribe()
    state.unsubscribe = null
  }
  const applied = state.applied
  if (applied === null) return
  const refs = liveRefs(runtime)
  const referenced = refs !== null && refs.some(ref => ref.timeline.module === applied)
  if (referenced) return
  state.applied = null
  dropModule(state, applied)
}

/** Formats one diagnostic with the script tools' path mapping: components.gen.ts, ege/ -> sdk/, else scripts/ege/. */
export function formatScriptDiagnostic(d: ScriptDiagnostic): string {
  const path = d.file === 'components.gen.ts' ? 'generated/components.gen.ts'
    : d.file.startsWith('ege/') ? `sdk/${d.file.slice(4)}`
      : `scripts/ege/${d.file}`
  return `${path}:${d.line}:${d.column} ${d.code} ${d.message}`
}
