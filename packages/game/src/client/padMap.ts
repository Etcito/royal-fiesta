import type { RawControls } from './inputMap.ts'

export type PadAction = 'jump' | 'dive' | 'grab' | 'pause' | 'join'

export interface PadMap {
  v: 1
  buttons: Record<PadAction, number>
  axes: { x: number; y: number }
  invertY: boolean
  dead: number
}

const ACTIONS: readonly PadAction[] = ['jump', 'dive', 'grab', 'pause', 'join']
const TOP_KEYS: readonly string[] = ['v', 'buttons', 'axes', 'invertY', 'dead']

export const DEFAULT_PAD_MAP: PadMap = Object.freeze({
  v: 1,
  buttons: Object.freeze({ jump: 0, dive: 1, grab: 2, pause: 9, join: 9 }),
  axes: Object.freeze({ x: 0, y: 1 }),
  invertY: false,
  dead: 0.15
})

export function padMapKey(gamepadId: string): string {
  return 'rf.padmap.' + gamepadId
}

function copy(map: PadMap): PadMap {
  return {
    v: 1,
    buttons: {
      jump: map.buttons.jump,
      dive: map.buttons.dive,
      grab: map.buttons.grab,
      pause: map.buttons.pause,
      join: map.buttons.join
    },
    axes: { x: map.axes.x, y: map.axes.y },
    invertY: map.invertY,
    dead: map.dead
  }
}

function defaults(problem: string): { map: PadMap; problem: string } {
  return { map: copy(DEFAULT_PAD_MAP), problem }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function show(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number' || typeof value === 'boolean' || value === null || value === undefined) return String(value)
  try {
    return JSON.stringify(value) ?? typeof value
  } catch {
    return typeof value
  }
}

function isIntInRange(value: unknown, lo: number, hi: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= lo && value <= hi
}

function unknownKeys(obj: Record<string, unknown>, allowed: readonly string[], path: string): string | null {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      const at = path === '' ? key : path + '.' + key
      return `${at}: unknown key; fix: remove it (allowed: ${allowed.join(', ')})`
    }
  }
  return null
}

export function parsePadMap(json: unknown): { map: PadMap; problem: string | null } {
  let value = json
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      return defaults(`json: invalid JSON (${detail}); fix: clear the stored pad map or write a valid one`)
    }
  }
  if (!isRecord(value)) {
    return defaults(`json: expected a pad map object, got ${show(value)}; fix: store an object with v, buttons, axes, invertY, dead`)
  }
  const unknownTop = unknownKeys(value, TOP_KEYS, '')
  if (unknownTop !== null) return defaults(unknownTop)

  if (value.v !== 1) {
    return defaults(`v: expected 1, got ${show(value.v)}; fix: set "v": 1`)
  }
  if (!isRecord(value.buttons)) {
    return defaults(`buttons: expected an object, got ${show(value.buttons)}; fix: add all five button indices`)
  }
  const unknownButtons = unknownKeys(value.buttons, ACTIONS, 'buttons')
  if (unknownButtons !== null) return defaults(unknownButtons)
  for (const action of ACTIONS) {
    const button = value.buttons[action]
    if (!isIntInRange(button, 0, 31)) {
      return defaults(`buttons.${action}: expected an integer 0..31, got ${show(button)}; fix: set "buttons.${action}" to a gamepad button index 0..31`)
    }
  }
  if (!isRecord(value.axes)) {
    return defaults(`axes: expected an object, got ${show(value.axes)}; fix: add "axes": { "x": 0, "y": 1 }`)
  }
  const unknownAxes = unknownKeys(value.axes, ['x', 'y'], 'axes')
  if (unknownAxes !== null) return defaults(unknownAxes)
  for (const axis of ['x', 'y'] as const) {
    const index = value.axes[axis]
    if (!isIntInRange(index, 0, 7)) {
      return defaults(`axes.${axis}: expected an integer 0..7, got ${show(index)}; fix: set "axes.${axis}" to an axis index 0..7`)
    }
  }
  if (typeof value.invertY !== 'boolean') {
    return defaults(`invertY: expected a boolean, got ${show(value.invertY)}; fix: set "invertY": true or false`)
  }
  if (typeof value.dead !== 'number' || !Number.isFinite(value.dead) || value.dead < 0 || value.dead >= 0.9) {
    return defaults(`dead: expected a number in [0, 0.9), got ${show(value.dead)}; fix: set "dead" between 0 and 0.9`)
  }
  return {
    map: {
      v: 1,
      buttons: {
        jump: value.buttons.jump as number,
        dive: value.buttons.dive as number,
        grab: value.buttons.grab as number,
        pause: value.buttons.pause as number,
        join: value.buttons.join as number
      },
      axes: { x: value.axes.x as number, y: value.axes.y as number },
      invertY: value.invertY,
      dead: value.dead
    },
    problem: null
  }
}

export interface PadLike {
  buttons: readonly { pressed: boolean }[]
  axes: readonly number[]
}

function axis(pad: PadLike, index: number): number {
  const value = pad.axes[index]
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function pressed(pad: PadLike, index: number): boolean {
  return pad.buttons[index]?.pressed === true
}

export function padControls(pad: PadLike, map: PadMap, out: RawControls): RawControls {
  const x = axis(pad, map.axes.x)
  const y = axis(pad, map.axes.y)
  const stickY = map.invertY ? y : -y
  out.left = false
  out.right = false
  out.forward = false
  out.back = false
  const magnitude = Math.sqrt(x * x + stickY * stickY)
  if (magnitude <= map.dead || magnitude === 0) {
    out.stickX = 0
    out.stickY = 0
  } else {
    const scaled = Math.min((magnitude - map.dead) / (1 - map.dead), 1)
    out.stickX = (x / magnitude) * scaled
    out.stickY = (stickY / magnitude) * scaled
  }
  out.jump = pressed(pad, map.buttons.jump)
  out.dive = pressed(pad, map.buttons.dive)
  out.grab = pressed(pad, map.buttons.grab)
  return out
}

export interface PadMapStore {
  get(id: string): PadMap
  set(id: string, m: PadMap): void
  reset(id: string): void
}

export function localPadMapStore(storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null): PadMapStore {
  const memory = new Map<string, string>()
  let useMemory = storage === null
  let warnedFallback = false
  const warnedProblem = new Set<string>()

  function fallback(err: unknown): void {
    useMemory = true
    if (warnedFallback) return
    warnedFallback = true
    const detail = err instanceof Error ? err.message : String(err)
    console.warn(`padMap: storage failed (${detail}); keeping pad maps in memory`)
  }

  function warn(key: string, problem: string): void {
    if (warnedProblem.has(key)) return
    warnedProblem.add(key)
    console.warn(`padMap: ignoring ${key}: ${problem}`)
  }

  function read(key: string): string | null {
    if (useMemory) return memory.get(key) ?? null
    try {
      return storage!.getItem(key)
    } catch (err) {
      fallback(err)
      return memory.get(key) ?? null
    }
  }

  return {
    get(id: string): PadMap {
      const key = padMapKey(id)
      const raw = read(key)
      if (raw === null) return copy(DEFAULT_PAD_MAP)
      let value: unknown
      try {
        value = JSON.parse(raw)
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err)
        warn(key, `json: invalid JSON (${detail}); fix: reset the pad map`)
        return copy(DEFAULT_PAD_MAP)
      }
      const { map, problem } = parsePadMap(value)
      if (problem !== null) {
        warn(key, problem)
        return copy(DEFAULT_PAD_MAP)
      }
      return map
    },
    set(id: string, m: PadMap): void {
      const key = padMapKey(id)
      const raw = JSON.stringify(m)
      warnedProblem.delete(key)
      if (useMemory) {
        memory.set(key, raw)
        return
      }
      try {
        storage!.setItem(key, raw)
      } catch (err) {
        fallback(err)
        memory.set(key, raw)
      }
    },
    reset(id: string): void {
      const key = padMapKey(id)
      warnedProblem.delete(key)
      if (useMemory) {
        memory.delete(key)
        return
      }
      try {
        storage!.removeItem(key)
      } catch (err) {
        fallback(err)
        memory.delete(key)
      }
    }
  }
}
