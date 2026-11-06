type Descriptor = Record<string, unknown>
type Method = (this: object, ...args: unknown[]) => unknown
interface Prototype { [name: string]: Method }
const installed = new WeakSet<object>()
let compiling = 0
let internalFallbacks = 0
export function pendingPipelines(): number { return compiling }
export function asyncPipelineFallbacks(): number { return internalFallbacks }

// Preparation (shader and pipeline compilation) runs in small batches: a frame that requests many
// pipelines still returns to the browser between them, so input and animation keep running.
export type PreparationYield = (resume: () => void) => void
export interface PreparationQueue {
  request<T>(renderer: object, key: string, work: () => Promise<T>): Promise<T>
}

const yieldToInteractiveFrame: PreparationYield = resume => {
  const scheduler = (globalThis as { scheduler?: { yield?: () => Promise<unknown> } }).scheduler
  if (scheduler !== undefined && typeof scheduler.yield === 'function') {
    void scheduler.yield().then(resume, resume)
    return
  }
  setTimeout(resume, 0)
}

/** A batch queue that shares duplicate outstanding work and yields a turn between batches. */
export function createPreparationQueue(options: { batch?: number; yield?: PreparationYield } = {}): PreparationQueue {
  const batch = Math.max(1, Math.floor(options.batch ?? 8))
  const yieldFrame = options.yield ?? yieldToInteractiveFrame
  const outstanding = new WeakMap<object, Map<string, Promise<unknown>>>()
  const queue: (() => void)[] = []
  let pumping = false
  let scheduled = false
  let started = 0
  const pump = (): void => {
    if (pumping) return
    pumping = true
    try {
      while (queue.length > 0 && started < batch) { started++; queue.shift()!() }
    } finally {
      pumping = false
    }
    if (!scheduled && (queue.length > 0 || started >= batch)) {
      scheduled = true
      yieldFrame(() => { scheduled = false; started = 0; pump() })
    }
  }
  return {
    request<T>(renderer: object, key: string, work: () => Promise<T>): Promise<T> {
      let pending = outstanding.get(renderer)
      if (pending === undefined) outstanding.set(renderer, pending = new Map())
      const known = pending.get(key)
      if (known !== undefined) return known as Promise<T>
      let resolve!: (value: T) => void
      let reject!: (error: unknown) => void
      const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
      const finish = (): void => {
        const jobs = outstanding.get(renderer)
        if (jobs?.get(key) === promise) jobs.delete(key)
      }
      pending.set(key, promise)
      queue.push(() => {
        let operation: Promise<T>
        try { operation = work() } catch (error) { finish(); reject(error); return }
        void operation.then(value => { finish(); resolve(value) }, error => { finish(); reject(error) })
      })
      if (!pumping && !scheduled) pump()
      return promise
    },
  }
}

const preparation = createPreparationQueue()

export type PipelineReadiness = { status: 'pending' } | { status: 'ready' } | { status: 'failed'; reason: string }

// One lit pipeline handle: material = the key of the material function its module was composed from (null when the
// module is not an RAA lit variant), device = the GPUDevice that compiles it.
interface State { pipeline?: object; error?: unknown; device: object; material: string | null; pass: string | null }
// Every lit pipeline requested so far per material function, per device (its shadow, prepass and forward variants);
// shown once the material has drawn: a variant requested later (a caster entering the shadow map) then only omits its
// own draws instead of hiding the whole object again.
interface Material { states: Set<State>; shown: boolean }
const materialsOf = new WeakMap<object, Map<string, Material>>()

/** The key of a material function's WGSL (the text given to addMaterialFunction, the module's material section). */
export function materialKey(wgsl: string): string {
  const text = wgsl.trim()
  let a = 0x811c9dc5, b = 0x9dc5811c
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    a = Math.imul(a ^ c, 0x01000193)
    b = Math.imul(b ^ c, 0x01000193) ^ (b >>> 15)
  }
  return `${text.length}:${(a >>> 0).toString(16)}${(b >>> 0).toString(16)}`
}

/**
 * True when the material function `key` (materialKey of its WGSL) has drawn on `device`, or has a forward variant and
 * every pipeline requested for it there is compiled: a part's shading then draws whole from this frame on. A true
 * answer latches the material as shown, so a variant first requested in the frame that swaps its vertex-colour copy
 * out omits only its own draws.
 */
export function fieldReady(device: object | undefined, key: string): boolean {
  return fieldReadiness(device, key).status === 'ready'
}

/** Device-scoped readiness of the variants composed from materialKey(WGSL), including layout rejection causes. */
export function fieldReadiness(device: object | undefined, key: string): PipelineReadiness {
  const material = device === undefined ? undefined : materialsOf.get(device)?.get(key)
  if (material === undefined) return { status: 'pending' }
  if (material.shown) return { status: 'ready' }
  for (const state of material.states) {
    if (state.error !== undefined) {
      const error = state.error as { message?: unknown }
      return { status: 'failed', reason: typeof error?.message === 'string' ? error.message : String(state.error) }
    }
  }
  let forward = false
  for (const state of material.states) {
    if (state.pipeline === undefined) return { status: 'pending' }
    if (state.pass === 'Forward') forward = true
  }
  material.shown = forward
  return { status: forward ? 'ready' : 'pending' }
}

// The device each canvas was configured with (GPUCanvasContext.configure), for a port to find its pipelines.
const canvasDevices = new WeakMap<object, object>()
export function deviceOfCanvas(canvas: object): object | undefined {
  return canvasDevices.get(canvas)
}

// The material section of an RAA lit variant module (the material function, between its section line and the next)
// and the pass of its header line.
const MATERIAL_SECTION = /^\/\/ raa section: material(?: "[^\n]*")?$/m
const VARIANT = /^\/\/ raa variant: (?:material .+?, )?pass (\w+)/m
function moduleInfo(code: string): ModuleInfo | null {
  const variant = VARIANT.exec(code)
  if (variant === null) return null
  const start = MATERIAL_SECTION.exec(code)
  if (start === null) return null
  const from = start.index + start[0].length
  const end = code.indexOf('\n// raa section: ', from)
  return { material: materialKey(code.slice(from, end < 0 ? code.length : end)), pass: variant[1] }
}
interface ModuleInfo { material: string; pass: string }

// A lit draw goes through when its pipeline is compiled and its material has drawn already, or every pipeline
// requested for that material on its device is compiled (it is then shown from this draw on).
function drawable(state: State): boolean {
  if (state.pipeline === undefined) return false
  if (state.material === null) return true
  const material = materialsOf.get(state.device)!.get(state.material)!
  if (material.shown) return true
  for (const other of material.states) if (other.pipeline === undefined) return false
  material.shown = true
  return true
}

// The release engine asks for lit pipelines synchronously. Keep that handle private to
// this bridge until WebGPU finishes the async pipeline, and omit its draws meanwhile.
// Explicit layouts let getBindGroupLayout work immediately. One-shot compute passes and
// auto-layout pipelines retain their native behaviour; skipping them would lose GPU work.
//
// A lit draw is all or nothing per material function (owner 2026-11-04: start-screen cosmetics, then course assets,
// showed at about 5% opacity for seconds). Every variant of a part (shadow, prepass, forward) is a 'raa.lit.pipeline'
// and compiles here asynchronously, but the shadow one (no fragment stage) is ready in about a second and the prepass
// and forward ones (they carry the part's SDF field) in up to tens of seconds. Drawing the ready ones alone left the
// part's shadow and its prepass depth/normals (ambient occlusion, fog, edges) on screen with no surface: the ghost. So
// a lit draw goes through only when every pipeline requested for its material function on its device is compiled; a
// new material's variants all start pending, so the shadow pass, which draws first in a frame, never draws it before
// its forward variant exists. Meanwhile the SDF port draws the part's vertex-colour copy (sdfPort fallbacks).
export function installAsyncLitPipelines(devicePrototype: object, passPrototype?: object, contextPrototype?: object): void {
  if (passPrototype === undefined || installed.has(devicePrototype)) return
  installed.add(devicePrototype)
  const layouts = new WeakMap<object, unknown[]>()
  const handles = new WeakMap<object, State>()
  const sources = new WeakMap<object, string>()
  const pendingHandles = new WeakMap<object, Map<string, object>>()
  const modules = new WeakMap<object, ModuleInfo | null>()
  const current = new WeakMap<object, State>()
  const device = devicePrototype as Prototype
  const createModule = device.createShaderModule
  if (typeof createModule === 'function') {
    device.createShaderModule = function(descriptor: unknown): unknown {
      const value = createModule.call(this, descriptor)
      const code = (descriptor as { code?: unknown })?.code
      if (typeof value === 'object' && value !== null && typeof code === 'string') {
        if (!modules.has(value)) modules.set(value, moduleInfo(code))
        if (!sources.has(value)) sources.set(value, code)
      }
      return value
    }
  }
  const infoOf = (desc: Descriptor): ModuleInfo | null => {
    const stage = (desc.fragment ?? desc.vertex) as { module?: unknown } | undefined
    return typeof stage?.module === 'object' && stage.module !== null ? modules.get(stage.module) ?? null : null
  }
  // A lit pipeline's work key: every field of its descriptor, with shader modules keyed by their source and layouts by
  // the identity of their bind group layouts. Two requests for compatible work then share one compilation.
  const identities = new WeakMap<object, number>()
  let nextIdentity = 0
  const identity = (value: object): string => {
    let id = identities.get(value)
    if (id === undefined) identities.set(value, id = ++nextIdentity)
    return `o${id}`
  }
  const workKey = (value: unknown, depth = 0): string => {
    if (value === null || typeof value !== 'object') return typeof value === 'string' ? JSON.stringify(value) : String(value)
    if (depth > 8) return identity(value)
    if (Array.isArray(value)) return `[${value.map(item => workKey(item, depth + 1)).join(',')}]`
    const source = sources.get(value)
    if (source !== undefined) return `s:${materialKey(source)}`
    const groups = layouts.get(value)
    if (groups !== undefined) return `l:[${groups.map(item => workKey(item, depth + 1)).join(',')}]`
    const proto = Object.getPrototypeOf(value)
    if (proto === Object.prototype || proto === null) {
      return `{${Object.keys(value).sort().map(name => `${name}:${workKey((value as Descriptor)[name], depth + 1)}`).join(',')}}`
    }
    return identity(value)
  }
  const context = contextPrototype as Prototype | undefined
  const configure = context?.configure
  if (context !== undefined && typeof configure === 'function') {
    context.configure = function(config: unknown): unknown {
      const canvas = (this as { canvas?: unknown }).canvas
      const gpu = (config as { device?: unknown })?.device
      if (typeof canvas === 'object' && canvas !== null && typeof gpu === 'object' && gpu !== null) canvasDevices.set(canvas, gpu)
      return configure.call(this, config)
    }
  }
  // Dawn rejects a lit pipeline on an invalid layout with only "is invalid due to a previous error" (M1 judge,
  // 4 clients, 2026-10-29). Each layout's own validation error is caught in an error scope and named in that rejection.
  const causes = new WeakMap<object, Promise<string | null>>()
  const scoped = (name: string, create: Method): Method => function(this: object, descriptor: unknown): unknown {
    const self = this as { pushErrorScope?: (filter: string) => void; popErrorScope?: () => Promise<{ message: string } | null> }
    if (typeof self.pushErrorScope !== 'function' || typeof self.popErrorScope !== 'function') return create.call(this, descriptor)
    self.pushErrorScope('validation')
    let value: unknown
    try { value = create.call(this, descriptor) } finally {
      const label = (descriptor as { label?: unknown })?.label
      const cause = self.popErrorScope().then(error => {
        if (error === null) return null
        const message = `${name}${typeof label === 'string' ? ` "${label}"` : ''}: ${error.message}`
        console.error(`[webgpu] ${message}`)
        return message
      }, () => null)
      if (typeof value === 'object' && value !== null && !causes.has(value)) causes.set(value, cause)
    }
    return value
  }
  // null when no layout object of the descriptor ran in an error scope (the rejection then stays synchronous).
  const causesOf = (descriptor: Descriptor): Promise<string[]> | null => {
    const layout = typeof descriptor.layout === 'object' && descriptor.layout !== null ? descriptor.layout : null
    if (layout === null) return null
    const scopedCauses = [layout, ...(layouts.get(layout) ?? [])].flatMap(o => {
      const cause = typeof o === 'object' && o !== null ? causes.get(o) : undefined
      return cause === undefined ? [] : [cause]
    })
    if (scopedCauses.length === 0) return null
    return Promise.all(scopedCauses).then(found => found.filter((m): m is string => m !== null))
  }
  if (typeof device.createBindGroupLayout === 'function') device.createBindGroupLayout = scoped('createBindGroupLayout', device.createBindGroupLayout)
  const createLayout = scoped('createPipelineLayout', device.createPipelineLayout)
  device.createPipelineLayout = function(descriptor: unknown): unknown {
    const value = createLayout.call(this, descriptor) as object
    layouts.set(value, Array.from((descriptor as { bindGroupLayouts: unknown[] }).bindGroupLayouts))
    return value
  }
  const createPipeline = device.createRenderPipeline
  device.createRenderPipeline = function(descriptor: unknown): unknown {
    const desc = descriptor as Descriptor
    const groups = typeof desc.layout === 'object' && desc.layout !== null ? layouts.get(desc.layout) : undefined
    if (desc.label !== 'raa.lit.pipeline' || groups === undefined) return createPipeline.call(this, descriptor)
    const key = workKey(desc)
    let pending = pendingHandles.get(this)
    if (pending === undefined) pendingHandles.set(this, pending = new Map())
    const known = pending.get(key)
    if (known !== undefined) return known
    const info = infoOf(desc)
    const state: State = { device: this, material: info?.material ?? null, pass: info?.pass ?? null }
    if (state.material !== null) {
      let materials = materialsOf.get(this)
      if (materials === undefined) materialsOf.set(this, materials = new Map())
      let material = materials.get(state.material)
      if (material === undefined) materials.set(state.material, material = { states: new Set(), shown: false })
      material.states.add(state)
    }
    const handle = { getBindGroupLayout(index: number): unknown {
      if (groups[index] == null) throw new Error(`Lit pipeline has no bind group layout ${index}`)
      return groups[index]
    } }
    handles.set(handle, state)
    pending.set(key, handle)
    compiling++
    const finish = (): void => {
      const handlesOf = pendingHandles.get(this)
      if (handlesOf?.get(key) === handle) handlesOf.delete(key)
      compiling--
    }
    void preparation.request(this, key, () => device.createRenderPipelineAsync.call(this, descriptor) as Promise<object>)
      .then(pipeline => { state.pipeline = pipeline; finish() }, error => {
        // Some release-engine devices reject even trivial async pipelines with an internal
        // backend error. Retry those through the release API; validation errors stay visible.
        if ((error as { reason?: string })?.reason === 'internal') {
          try { state.pipeline = createPipeline.call(this, descriptor) as object; internalFallbacks++ }
          catch (retryError) { state.error = retryError }
          finish()
          return
        }
        const pendingCauses = causesOf(desc)
        if (pendingCauses === null) {
          state.error = error
          finish()
          return
        }
        void pendingCauses.then(found => {
          state.error = found.length === 0 ? error : withCauses(error, found)
          finish()
        })
      })
    return handle
  }
  const pass = passPrototype as Prototype
  const setPipeline = pass.setPipeline
  pass.setPipeline = function(pipeline: unknown): unknown {
    const state = typeof pipeline === 'object' && pipeline !== null ? handles.get(pipeline) : undefined
    if (state === undefined) {
      current.delete(this)
      return setPipeline.call(this, pipeline)
    }
    if (state.error !== undefined) throw state.error
    current.set(this, state)
    if (state.pipeline !== undefined) return setPipeline.call(this, state.pipeline)
  }
  for (const name of ['draw', 'drawIndexed', 'drawIndirect', 'drawIndexedIndirect']) {
    const draw = pass[name]
    if (typeof draw !== 'function') continue
    pass[name] = function(...args: unknown[]): unknown {
      const state = current.get(this)
      if (state === undefined || drawable(state)) return draw.apply(this, args)
    }
  }
}

// The rejection with the layout's own validation errors appended; reason (and the error's name) are kept.
function withCauses(error: unknown, causes: readonly string[]): Error {
  const base = error instanceof Error ? error : null
  const message = base?.message ?? (typeof (error as { message?: unknown })?.message === 'string' ? (error as { message: string }).message : String(error))
  const named = new Error(`${message}; previous error: ${causes.join('; ')}`)
  named.name = base?.name ?? 'GPUPipelineError'
  const reason = (error as { reason?: unknown })?.reason
  if (reason !== undefined) (named as Error & { reason?: unknown }).reason = reason
  return named
}
