type Descriptor = Record<string, unknown>
type Method = (this: object, ...args: unknown[]) => unknown
interface Prototype { [name: string]: Method }
const installed = new WeakSet<object>()
let compiling = 0
let internalFallbacks = 0
export function pendingPipelines(): number { return compiling }
export function asyncPipelineFallbacks(): number { return internalFallbacks }

// The release engine asks for lit pipelines synchronously. Keep that handle private to
// this bridge until WebGPU finishes the async pipeline, and omit its draws meanwhile.
// Explicit layouts let getBindGroupLayout work immediately. One-shot compute passes and
// auto-layout pipelines retain their native behaviour; skipping them would lose GPU work.
export function installAsyncLitPipelines(devicePrototype: object, passPrototype?: object): void {
  if (passPrototype === undefined || installed.has(devicePrototype)) return
  installed.add(devicePrototype)
  const layouts = new WeakMap<object, unknown[]>()
  const handles = new WeakMap<object, { pipeline?: object; error?: unknown }>()
  const byPromise = new WeakMap<Promise<object>, object>()
  const waiting = new WeakSet<object>()
  const device = devicePrototype as Prototype
  const createLayout = device.createPipelineLayout
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
    const promise = device.createRenderPipelineAsync.call(this, descriptor) as Promise<object>
    const known = byPromise.get(promise)
    if (known !== undefined) return known
    const state: { pipeline?: object; error?: unknown } = {}
    const handle = { getBindGroupLayout(index: number): unknown {
      if (groups[index] == null) throw new Error(`Lit pipeline has no bind group layout ${index}`)
      return groups[index]
    } }
    handles.set(handle, state)
    byPromise.set(promise, handle)
    compiling++
    void promise.then(pipeline => { state.pipeline = pipeline; compiling-- }, error => {
      // Some release-engine devices reject even trivial async pipelines with an internal
      // backend error. Retry those through the release API; validation errors stay visible.
      if ((error as { reason?: string })?.reason === 'internal') {
        try { state.pipeline = createPipeline.call(this, descriptor) as object; internalFallbacks++ }
        catch (retryError) { state.error = retryError }
      } else state.error = error
      compiling--
    })
    return handle
  }
  const pass = passPrototype as Prototype
  const setPipeline = pass.setPipeline
  pass.setPipeline = function(pipeline: unknown): unknown {
    const state = typeof pipeline === 'object' && pipeline !== null ? handles.get(pipeline) : undefined
    waiting.delete(this)
    if (state === undefined) return setPipeline.call(this, pipeline)
    if (state.error !== undefined) throw state.error
    if (state.pipeline !== undefined) return setPipeline.call(this, state.pipeline)
    waiting.add(this)
  }
  for (const name of ['draw', 'drawIndexed', 'drawIndirect', 'drawIndexedIndirect']) {
    const draw = pass[name]
    if (typeof draw !== 'function') continue
    pass[name] = function(...args: unknown[]): unknown {
      if (!waiting.has(this)) return draw.apply(this, args)
    }
  }
}
