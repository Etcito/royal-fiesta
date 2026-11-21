import { EventBridge, worldEventSource } from '@etcito/game-engine/events'
import type { BridgeEvent, EventSource } from '@etcito/game-engine/events'
import { schemaLayout } from '@etcito/game-engine/script'
import type { LayoutDecl, SchemaLayout } from '@etcito/game-engine/script'
import type {
  EnginePresentationWorld,
  EngineRoundResult,
  EngineShowObservation,
  EngineShowPresentation,
  EngineShowRuntime,
} from './showTypes.ts'

/** External-effect sinks; the sound sink receives decoded payload fields, the grant sink the confirmed result. */
export interface EngineShowEffectSinks {
  sound: (name: string, payload: Readonly<Record<string, number>>) => void
  grant: (receipt: string, result: EngineRoundResult) => void
}

/** Diagnostics of one effects instance; copied on read, reset only with a changed show identity. */
export interface EngineShowDeliveryStats {
  droppedRecords: number
  repeatedSoundDeliveries: number
  repeatedGrantDeliveries: number
}

/** One record as the event source reports it (`EventRecord` of the engine's formats). */
type EventRecord = ReturnType<EventSource['events']>['records'][number]

const RULES_PUBLISHER = 'rules'

/**
 * G7-CONFIRMED-EFFECTS: delivers confirmed engine events of each live physics world and the confirmed
 * round results to external sinks, once per receipt. Receipts and the delivered audit set live here,
 * outside rollback and the disposable world records; they clear only when the show identity changes.
 * Presentation observations drain every affected world after its ticks and before its release.
 */
export class EngineShowEffects {
  private readonly runtime: EngineShowRuntime
  private readonly sinks: EngineShowEffectSinks
  private readonly lanes = new Map<string, EventBridge>()
  private readonly receipts = new Set<string>()
  private readonly delivered = new Set<string>()
  private readonly unsubscribe: () => void
  private stats: EngineShowDeliveryStats = { droppedRecords: 0, repeatedSoundDeliveries: 0, repeatedGrantDeliveries: 0 }
  private showId: string | null = null
  private round = 0
  private disposed = false

  constructor(runtime: EngineShowRuntime, sinks: EngineShowEffectSinks) {
    this.runtime = runtime
    this.sinks = sinks
    this.unsubscribe = runtime.onPresentation((observation) => this.observe(observation))
  }

  /** Drains every live world and the confirmed results again; repeated calls deliver nothing twice. */
  pump(): void {
    if (this.disposed) throw new Error('show effects are disposed: pump is not allowed')
    this.drain(this.runtime.presentation())
  }

  /** Copied diagnostics; reading neither pumps nor drains events. */
  deliveryStats(): Readonly<EngineShowDeliveryStats> {
    return { ...this.stats }
  }

  /** Unsubscribes from the runtime and disposes the event bridges; receipts are kept for the show. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.unsubscribe()
    for (const lane of this.lanes.values()) lane.dispose()
    this.lanes.clear()
  }

  private observe(observation: EngineShowObservation): void {
    this.drain(observation.presentation)
    if (observation.kind !== 'before-release') return
    for (const world of observation.presentation.worlds) {
      const key = laneKey(world)
      this.lanes.get(key)?.dispose()
      this.lanes.delete(key)
    }
  }

  private drain(presentation: EngineShowPresentation): void {
    this.checkShow(presentation)
    for (const world of presentation.worlds) {
      this.laneOf(world).pump(world.ref.confirmedTick)
    }
    this.deliverGrants()
    this.forgetReleased(presentation)
  }

  private checkShow(presentation: EngineShowPresentation): void {
    this.round = presentation.round
    if (this.showId === presentation.showId) return
    this.receipts.clear()
    this.delivered.clear()
    this.stats = { droppedRecords: 0, repeatedSoundDeliveries: 0, repeatedGrantDeliveries: 0 }
    this.showId = presentation.showId
  }

  private forgetReleased(presentation: EngineShowPresentation): void {
    const live = new Set(presentation.worlds.map(laneKey))
    for (const [key, lane] of this.lanes) {
      if (live.has(key)) continue
      lane.dispose()
      this.lanes.delete(key)
    }
  }

  private laneOf(world: EnginePresentationWorld): EventBridge {
    const key = laneKey(world)
    const existing = this.lanes.get(key)
    if (existing !== undefined) return existing
    const engine = world.ref.timeline.module.engine
    const layout = schemaLayout(engine)
    const names = eventNames(layout)
    const decls = new Map(layout.events.map((decl) => [decl.id, decl] as const))
    const raw = worldEventSource(engine, world.ref.world)
    let pending: string[] = []
    let cursor = 0
    const source: EventSource = {
      events: (fromTick: number, confirmedTick: number) => {
        const read = raw.events(fromTick, confirmedTick)
        if (read.dropped > 0) {
          this.stats.droppedRecords += read.dropped
          throw new Error(`show effects: ${read.dropped} event record(s) dropped from world ${world.ref.world}`)
        }
        pending = []
        cursor = 0
        return { dropped: read.dropped, records: confirmedSequenced(read.records, names, pending) }
      },
    }
    const lane = new EventBridge(source, {
      names,
      isResimulating: () => world.ref.binding.resimulating,
    })
    for (const name of names) {
      lane.on(
        name,
        (event: BridgeEvent) => {
          const sequence = pending[cursor]
          cursor += 1
          this.deliverSound(world, event, sequence, decls.get(event.kind))
        },
        'confirmed',
      )
    }
    this.lanes.set(key, lane)
    return lane
  }

  private deliverSound(
    world: EnginePresentationWorld,
    event: BridgeEvent,
    sequence: string,
    decl: LayoutDecl | undefined,
  ): void {
    const publisher = world.publishers.get(event.entity)
    if (publisher === undefined) {
      throw new Error(`show effects: entity ${event.entity} has no publisher for event '${event.name}'`)
    }
    const receipt = this.receiptOf(publisher, sequence, `sound:${event.name}`)
    if (this.receipts.has(receipt)) return
    this.receipts.add(receipt)
    if (this.delivered.has(receipt)) {
      this.stats.repeatedSoundDeliveries += 1
      return
    }
    this.delivered.add(receipt)
    this.sinks.sound(event.name, decodePayload(decl, event.payload))
  }

  private deliverGrants(): void {
    const refs = this.runtime.worlds()
    const rules = refs.filter((ref) => ref.kind === 'global')
    if (rules.some((ref) => ref.resimulating)) return
    for (const result of this.runtime.snapshot().results) {
      if (!rules.some((ref) => ref.confirmedTick > result.endTick)) continue
      const receipt = this.receiptOf(RULES_PUBLISHER, `${result.endTick}`, 'grant')
      if (this.receipts.has(receipt)) continue
      this.receipts.add(receipt)
      if (this.delivered.has(receipt)) {
        this.stats.repeatedGrantDeliveries += 1
        continue
      }
      this.delivered.add(receipt)
      this.sinks.grant(receipt, result)
    }
  }

  private receiptOf(publisher: string, sequence: string, kind: string): string {
    return [this.showId, this.round, publisher, sequence, kind].join('|')
  }
}

function laneKey(world: EnginePresentationWorld): string {
  return `${world.ref.domain}:${world.ref.world}:${world.incarnation}`
}

function eventNames(layout: SchemaLayout): string[] {
  const names: string[] = []
  for (const decl of layout.events) names[decl.id] = decl.name
  return names.filter((name) => name !== undefined)
}

/**
 * Keeps the confirmed records whose kind has a name, in buffer order, and records each one's sequence:
 * its stable tick plus its index among every record of that tick in the raw buffer.
 */
function confirmedSequenced(records: EventRecord[], names: readonly string[], sequences: string[]): EventRecord[] {
  const indexByTick = new Map<number, number>()
  const kept: EventRecord[] = []
  for (const record of records) {
    const index = indexByTick.get(record.tick) ?? 0
    indexByTick.set(record.tick, index + 1)
    if (!record.confirmed || names[record.kind] === undefined) continue
    kept.push(record)
    sequences.push(`${record.tick}.${index}`)
  }
  return kept
}

const SIZES: Record<LayoutDecl['fields'][number]['type'], number> = {
  u8: 1,
  i8: 1,
  u16: 2,
  i16: 2,
  u32: 4,
  i32: 4,
  f32: 4,
  f64: 8,
  entity: 4,
}

function decodePayload(decl: LayoutDecl | undefined, payload: DataView): Record<string, number> {
  const out: Record<string, number> = {}
  if (decl === undefined) return out
  for (const field of decl.fields) {
    const size = SIZES[field.type]
    for (let index = 0; index < field.count; index++) {
      const offset = field.offset + index * size
      if (offset + size > payload.byteLength) {
        throw new Error(`show effects: payload of '${decl.name}' is shorter than field '${field.name}'`)
      }
      const name = field.count === 1 ? field.name : `${field.name}${index}`
      out[name] = readField(payload, field.type, offset)
    }
  }
  return out
}

function readField(payload: DataView, type: LayoutDecl['fields'][number]['type'], offset: number): number {
  switch (type) {
    case 'u8':
      return payload.getUint8(offset)
    case 'i8':
      return payload.getInt8(offset)
    case 'u16':
      return payload.getUint16(offset, true)
    case 'i16':
      return payload.getInt16(offset, true)
    case 'u32':
    case 'entity':
      return payload.getUint32(offset, true)
    case 'i32':
      return payload.getInt32(offset, true)
    case 'f32':
      return payload.getFloat32(offset, true)
    case 'f64':
      return payload.getFloat64(offset, true)
  }
}
