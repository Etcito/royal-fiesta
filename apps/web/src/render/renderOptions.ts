// The player's graphics options as the render ports see them: one page-wide record (MAMA's GameRenderOptions values,
// validated by game/graphicsSettings.ts) that every RAA port applies to its engine at creation, on every change and
// after every environment change, through @etcito/raa-sdfm's applyRenderOptions. Ports subscribe; nothing is threaded
// through the many places that create one (local play, the show's own canvas, the hub, lobbies, zones).
import { applyRenderOptions } from '@etcito/raa-sdfm'
import type { Engine } from '@etcito/raa'

export type RenderOptionValues = Readonly<Record<string, unknown>>

let current: RenderOptionValues = {}
const listeners = new Set<(options: RenderOptionValues) => void>()

export function renderOptions(): RenderOptionValues {
  return current
}

// Replaces the page's options and tells every live port.
export function setRenderOptions(options: RenderOptionValues): void {
  current = { ...options }
  for (const listener of listeners) listener(current)
}

// Calls `listener` on every change until the returned function is called.
export function onRenderOptions(listener: (options: RenderOptionValues) => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

// The options raa-sdfm applies to the engine (shading is the upload's, the frame options the page loop's).
const ENGINE_KEYS = ['aoQuality', 'renderScale', 'postBloom', 'postGrading', 'postStrength'] as const

// Applies the engine-side options to `engine`. `post`: whether the scene's environment has a post look (it turns
// bloom and grading on; an option only turns them off). A key the engine cannot apply is logged once per reason.
const warned = new Set<string>()
export function applyEngineOptions(engine: Engine, options: RenderOptionValues, post: boolean): void {
  const picked: Record<string, unknown> = {}
  for (const key of ENGINE_KEYS) if (options[key] !== undefined) picked[key] = options[key]
  const { skipped } = applyRenderOptions(engine, picked, { bloom: post, grading: post })
  for (const { key, reason } of skipped) {
    const line = `[graphics] ${key} not applied: ${reason}`
    if (warned.has(line)) continue
    warned.add(line)
    console.warn(line)
  }
}

// Surface shading for the next scene upload: 'vertex' draws vertex normals and colours (no per-pixel SDF);
// anything else keeps the per-pixel field. `?normals=vertex` in the address still wins (sdfPort normalsMode).
export function preferredNormals(): 'pixel' | 'vertex' {
  return current.shading === 'vertex' ? 'vertex' : 'pixel'
}
