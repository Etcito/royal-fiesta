import type { EngineInstance } from '@etcito/game-engine/loader'
import type { SchemaLayout } from '@etcito/game-engine/script'
import { decodeRecord } from '@etcito/game-engine/world-state'
import type { RecordValues, WorldState } from '@etcito/game-engine/world-state'

/**
 * The seat-world components the show's views read each frame (EngineShowView, EngineSeatPresenter). The engine's own
 * readWorldState decodes EVERY simulation component of EVERY entity of the world (60 seats, the whole course and the
 * mechanisms) into JS objects, and the view and the presenter each did it on every observation. This reader walks the
 * same snapshot blocks (same layout, same offsets) and decodes only these.
 */
export const SHOW_VIEW_COMPONENTS: ReadonlySet<string> = new Set([
  'character', 'seat', 'ege.velocity', 'surface', 'ege.mech.signal', 'show_control',
])

const MAGIC = [0x45, 0x47, 0x57, 0x31]
const HEADER_BYTES = 48
const HEADER_TICK_AT = 12
const HEADER_ENTITY_COUNT_AT = 24
const BLOCK_HEADER_BYTES = 8

interface Memo { tick: number; state: WorldState }
const memos = new WeakMap<EngineInstance, Map<number, Memo>>()

/** Forget what was read from `world` (it is released or replaced: its id and tick may come back for a new world). */
export function forgetWorldReads(engine: EngineInstance, world?: number): void {
  const worlds = memos.get(engine)
  if (worlds === undefined) return
  if (world === undefined) worlds.clear()
  else worlds.delete(world)
}

/**
 * The state of `world` restricted to `SHOW_VIEW_COMPONENTS` (entities, those components, resources empty), read once
 * per engine tick of the world: a second read in the same tick is the same object, without a snapshot copy.
 */
export function readShowViewState(engine: EngineInstance, world: number, layout: SchemaLayout): WorldState {
  const tick = engine.tick(world)
  let worlds = memos.get(engine)
  if (worlds === undefined) memos.set(engine, worlds = new Map())
  const memo = worlds.get(world)
  if (memo !== undefined && memo.tick === tick) return memo.state
  const bytes = engine.snapshot(world)
  if (bytes.byteLength < HEADER_BYTES || MAGIC.some((byte, i) => bytes[i] !== byte)) {
    throw new Error('the world snapshot does not start with the magic EGW1')
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const entityCount = view.getUint32(HEADER_ENTITY_COUNT_AT, true)
  const state: WorldState = { tick: view.getUint32(HEADER_TICK_AT, true), entities: [], components: {}, resources: {} }
  for (let i = 0; i < entityCount; i++) state.entities.push(view.getUint32(HEADER_BYTES + i * 4, true))
  let at = HEADER_BYTES + entityCount * 4
  const decls = layout.components.filter(decl => decl.lane === 'simulation').sort((a, b) => a.id - b.id)
  for (const decl of decls) {
    const count = view.getUint32(at, true)
    const recordSize = view.getUint32(at + 4, true)
    if (recordSize !== decl.size) throw new Error(`snapshot record '${decl.name}' has ${recordSize} bytes; the layout has ${decl.size}`)
    const first = at + BLOCK_HEADER_BYTES + count * 4
    if (SHOW_VIEW_COMPONENTS.has(decl.name)) {
      const rows: Record<string, RecordValues> = {}
      for (let i = 0; i < count; i++) {
        const id = view.getUint32(at + BLOCK_HEADER_BYTES + i * 4, true)
        const start = first + i * recordSize
        rows[String(id)] = decodeRecord(decl, bytes.subarray(start, start + recordSize))
      }
      state.components[decl.name] = rows
    }
    at = first + count * recordSize
  }
  worlds.set(world, { tick, state })
  return state
}
