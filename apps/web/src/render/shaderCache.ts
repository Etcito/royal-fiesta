// Device objects stay inside a WeakMap: a disposed renderer never seeds another device's cache.
import { installAsyncLitPipelines } from './asyncPipelines.ts'
type Descriptor = Record<string, unknown>
type Method = (descriptor: Descriptor) => unknown
interface Device { [name: string]: Method }
export interface ShaderTiming {
  kind: string
  hash: string
  modules: string[]
  hit: boolean
  ms: number
  async: boolean
}

export function shaderHash(source: string): string {
  let hash = 0x811c9dc5
  for (const byte of new TextEncoder().encode(source)) hash = Math.imul(hash ^ byte, 0x01000193)
  return (hash >>> 0).toString(16).padStart(8, '0')
}

export function stableShaderSource(source: string): string {
  // The 0.3 release composer puts registry metadata in diagnostic comments. Keep line
  // numbers intact while removing names and IDs that do not affect shader execution.
  return source.replace(/^\/\/ raa variant: material .+?, pass /m, '// raa variant: pass ')
    .replace(/^\/\/ raa section: material "[^\n]*"$/gm, '// raa section: material')
}

const installed = new WeakSet<object>()
export const shaderTimings: ShaderTiming[] = []

export function shaderReport(): {
  modules: { hash: string; requests: number; created: number; moduleMs: number; pipelineMs: number }[]
  pipelines: { requests: number; created: number; ms: number }
} {
  const modules = new Map<string, { hash: string; requests: number; created: number; moduleMs: number; pipelineMs: number }>()
  const pipelines = { requests: 0, created: 0, ms: 0 }
  for (const timing of shaderTimings) {
    const module = timing.kind === 'createShaderModule'
    if (!module) {
      pipelines.requests++
      if (!timing.hit) pipelines.created++
      pipelines.ms += timing.ms
    }
    for (const hash of timing.modules) {
      let row = modules.get(hash)
      if (row === undefined) modules.set(hash, row = { hash, requests: 0, created: 0, moduleMs: 0, pipelineMs: 0 })
      if (module) {
        row.requests++
        if (!timing.hit) row.created++
        row.moduleMs += timing.ms
      } else row.pipelineMs += timing.ms
    }
  }
  return { modules: [...modules.values()], pipelines }
}

// Hashes identify measurements. Full descriptor equality, including source and layout, keys reuse.
// This also observes the WebGPU calls made by wasm and uaa on the page.
export function installShaderCache(prototype: object | undefined = (globalThis as unknown as {
  GPUDevice?: { prototype: object }
}).GPUDevice?.prototype): void {
  if (prototype === undefined || installed.has(prototype)) return
  installed.add(prototype)
  const devices = new WeakMap<object, Map<string, Map<string, unknown>>>()
  const identities = new WeakMap<object, number>()
  const modules = new WeakMap<object, string>()
  let nextIdentity = 0
  const keyOf = (value: unknown): string => {
    if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined'
    if (Array.isArray(value)) return `[${value.map(keyOf).join(',')}]`
    if (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null) {
      return `{${Object.keys(value).filter(key => key !== 'label').sort().map(key => `${JSON.stringify(key)}:${keyOf((value as Descriptor)[key])}`).join(',')}}`
    }
    let id = identities.get(value)
    if (id === undefined) identities.set(value, id = ++nextIdentity)
    return `object:${id}`
  }
  for (const name of ['createBindGroupLayout', 'createPipelineLayout', 'createShaderModule',
    'createRenderPipeline', 'createComputePipeline', 'createRenderPipelineAsync', 'createComputePipelineAsync']) {
    const original = (prototype as Device)[name]
    if (typeof original !== 'function') continue
    Object.defineProperty(prototype, name, { configurable: true, writable: true, value: function(this: object, descriptor: Descriptor): unknown {
      if (name === 'createShaderModule' && typeof descriptor.code === 'string') {
        descriptor = { ...descriptor, code: stableShaderSource(descriptor.code) }
      }
      let caches = devices.get(this)
      if (caches === undefined) devices.set(this, caches = new Map())
      let cache = caches.get(name)
      if (cache === undefined) caches.set(name, cache = new Map())
      const key = keyOf(descriptor)
      const hit = cache.has(key)
      const start = performance.now()
      const value = hit ? cache.get(key) : original.call(this, descriptor)
      const hash = shaderHash(typeof descriptor.code === 'string' ? descriptor.code : key)
      if (name === 'createShaderModule' && typeof value === 'object' && value !== null) modules.set(value, hash)
      const sources = name === 'createShaderModule' ? [hash] : ['vertex', 'fragment', 'compute'].flatMap(stage => {
        const module = (descriptor[stage] as Descriptor | undefined)?.module
        const hash = typeof module === 'object' && module !== null ? modules.get(module) : undefined
        return hash === undefined ? [] : [hash]
      })
      const timing: ShaderTiming = { kind: name, hash, modules: [...new Set(sources)], hit, ms: performance.now() - start, async: name.endsWith('Async') }
      if (!name.endsWith('Layout')) shaderTimings.push(timing)
      if (!hit) {
        cache.set(key, value)
        if (value instanceof Promise) {
          void value.then(() => { timing.ms = performance.now() - start }, () => {
            timing.ms = performance.now() - start
            cache!.delete(key)
          })
        }
      }
      return value
    } })
  }
  installAsyncLitPipelines(prototype, (globalThis as unknown as {
    GPURenderPassEncoder?: { prototype: object }
  }).GPURenderPassEncoder?.prototype)
}
