// Shared S19 param readers: every refusal names the feature pointer, expected unit and range.

import type { Box, FeatureSpec } from '../course.ts'
import type { Vec3 } from '../vec.ts'
import { refuse } from '../refusal.ts'

function keyOf(ptr: string): string {
  return ptr.slice(ptr.lastIndexOf('/') + 1)
}

function unitOf(key: string): string {
  if (key.endsWith('DegS')) return ' deg/s'
  if (key.endsWith('Deg')) return ' deg'
  if (key.endsWith('Mps')) return ' m/s'
  if (key.endsWith('S')) return ' s'
  if (key.endsWith('M')) return ' m'
  if (key === 'mass') return ' kg'
  if (key === 'boost' || key === 'speed') return ' m/s'
  if (key === 'radius' || key.endsWith('Radius')) return ' m'
  if (key === 'length' || key === 'height' || key === 'width' || key === 'depth') return ' m'
  return ''
}

function rangeOf(min: number, max: number, unit: string): string {
  const lo = Number.isFinite(min)
  const hi = Number.isFinite(max)
  if (lo && hi) return `in ${min}..${max}${unit}`
  if (lo) return `>= ${min}${unit}`
  if (hi) return `<= ${max}${unit}`
  return `a finite number${unit}`
}

function read(spec: FeatureSpec, path: string, key: string, expected: string, fallback: unknown): unknown {
  const value = spec.params[key]
  if (value === undefined && fallback === undefined) {
    refuse('feature', `${path}/${key}`, `missing ${key}; expected ${expected}`)
  }
  return value === undefined ? fallback : value
}

export function numOf(value: unknown, ptr: string, min: number, max: number): number {
  const name = keyOf(ptr)
  const range = rangeOf(min, max, unitOf(name))
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    refuse('feature', ptr, `expected ${name} as a finite number ${range}; write a number in that range`)
  }
  return value
}

export function numParam(spec: FeatureSpec, path: string, key: string, min: number, max: number, fallback?: number): number {
  const expected = rangeOf(min, max, unitOf(key))
  const value = read(spec, path, key, expected, fallback)
  return numOf(value, `${path}/${key}`, min, max)
}

export function intParam(spec: FeatureSpec, path: string, key: string, min: number, max: number, fallback?: number): number {
  const expected = `a whole number ${rangeOf(min, max, unitOf(key))}`
  const value = read(spec, path, key, expected, fallback)
  const n = numOf(value, `${path}/${key}`, min, max)
  if (!Number.isInteger(n)) {
    refuse('feature', `${path}/${key}`, `expected ${key} as ${expected}; write an integer in that range`)
  }
  return n
}

export function boolParam(spec: FeatureSpec, path: string, key: string, fallback?: boolean): boolean {
  const value = read(spec, path, key, 'a boolean (true or false)', fallback)
  if (typeof value !== 'boolean') {
    refuse('feature', `${path}/${key}`, `expected ${key} as a boolean; write true or false`)
  }
  return value
}

export function stringParam(spec: FeatureSpec, path: string, key: string, pattern?: RegExp): string {
  const value = read(spec, path, key, 'a string', undefined)
  if (typeof value !== 'string') {
    refuse('feature', `${path}/${key}`, `expected ${key} as a string; write text`)
  }
  if (pattern !== undefined) {
    pattern.lastIndex = 0
    if (!pattern.test(value)) {
      refuse('feature', `${path}/${key}`, `expected ${key} matching ${String(pattern)}; write text in that form`)
    }
  }
  return value
}

export function enumParam<T extends string>(spec: FeatureSpec, path: string, key: string, values: readonly T[], fallback?: T): T {
  const expected = `one of ${values.join(', ')}`
  const value = read(spec, path, key, expected, fallback)
  if (typeof value !== 'string' || !values.includes(value as T)) {
    refuse('feature', `${path}/${key}`, `expected ${key} as ${expected}; write one of those values`)
  }
  return value as T
}

export function vec3Of(value: unknown, ptr: string): Vec3 {
  if (!Array.isArray(value) || value.length !== 3) {
    refuse('feature', ptr, 'expected [x,y,z] in metres; write a three-number position')
  }
  const x = value[0]
  const y = value[1]
  const z = value[2]
  if (typeof x !== 'number' || typeof y !== 'number' || typeof z !== 'number' ||
      !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
    refuse('feature', ptr, 'expected finite [x,y,z] metres; replace NaN or Infinity with metre coordinates')
  }
  return { x, y, z }
}

export function vec3Param(spec: FeatureSpec, path: string, key: string): Vec3 {
  const value = read(spec, path, key, '[x,y,z] in metres', undefined)
  return vec3Of(value, `${path}/${key}`)
}

export function boxParam(spec: FeatureSpec, path: string, centerKey = 'center', halfKey = 'half'): Box {
  const center = vec3Param(spec, path, centerKey)
  const half = vec3Param(spec, path, halfKey)
  if (half.x <= 0 || half.y <= 0 || half.z <= 0) {
    refuse('feature', `${path}/${halfKey}`, 'expected half extents > 0 in metres; write three positive numbers')
  }
  return { center, half }
}

export function ticksParam(spec: FeatureSpec, path: string, key: string, minS: number, maxS: number, fallbackS?: number): number {
  const expected = `seconds ${rangeOf(minS, maxS, ' s')}`
  const value = read(spec, path, key, expected, fallbackS)
  const seconds = numOf(value, `${path}/${key}`, minS, maxS)
  return Math.max(1, Math.round(seconds * 60))
}

export function listParam(spec: FeatureSpec, path: string, key: string, min: number, max: number): readonly unknown[] {
  const value = read(spec, path, key, `${min}..${max} entries`, undefined)
  if (!Array.isArray(value)) {
    refuse('feature', `${path}/${key}`, `expected ${key} as an array of ${min}..${max} entries; write a list`)
  }
  if (value.length < min || value.length > max) {
    refuse('feature', `${path}/${key}`, `expected ${min}..${max} ${key} entries, got ${value.length}; add or remove entries`)
  }
  return value
}

export function objOf(value: unknown, ptr: string): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    refuse('feature', ptr, 'expected an object; write an object with named fields')
  }
  return value as Readonly<Record<string, unknown>>
}
