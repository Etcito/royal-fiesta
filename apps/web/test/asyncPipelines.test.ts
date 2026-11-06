import assert from 'node:assert/strict'
import test from 'node:test'
import { asyncPipelineFallbacks, createPreparationQueue, deviceOfCanvas, fieldReadiness, fieldReady, installAsyncLitPipelines, materialKey, pendingPipelines } from '../src/render/asyncPipelines.ts'

test('lit pipelines compile concurrently, omit pending draws and bind the resolved pipeline', async () => {
  const pending: { resolve(value: object): void; promise: Promise<object> }[] = []
  class Device {
    sync = 0
    createPipelineLayout(_descriptor: unknown): object { return {} }
    createRenderPipeline(_descriptor: unknown): object { this.sync++; return {} }
    createRenderPipelineAsync(_descriptor: unknown): Promise<object> {
      let resolve!: (value: object) => void
      const promise = new Promise<object>(done => { resolve = done })
      pending.push({ resolve, promise })
      return promise
    }
  }
  class Pass {
    pipeline: unknown
    draws = 0
    setPipeline(value: unknown): void { this.pipeline = value }
    drawIndexed(): void { this.draws++ }
  }
  installAsyncLitPipelines(Device.prototype, Pass.prototype)
  const device = new Device()
  const group = {}
  const layout = device.createPipelineLayout({ bindGroupLayouts: [group] })
  const a = device.createRenderPipeline({ label: 'raa.lit.pipeline', layout }) as { getBindGroupLayout(index: number): object }
  const duplicate = device.createRenderPipeline({ label: 'raa.lit.pipeline', layout })
  assert.equal(duplicate, a, 'a duplicate lit request shares the outstanding pipeline')
  const b = device.createRenderPipeline({ label: 'raa.lit.pipeline', layout: device.createPipelineLayout({ bindGroupLayouts: [group, group] }) })
  assert.equal(pending.length, 2, 'both compiles started before either completed')
  assert.equal(device.sync, 0)
  assert.equal(a.getBindGroupLayout(0), group)
  const pass = new Pass()
  pass.setPipeline(a)
  pass.drawIndexed()
  assert.equal(pass.draws, 0)
  const ready = {}
  pending[0].resolve(ready)
  pending[1].resolve({})
  await Promise.all(pending.map(entry => entry.promise))
  assert.equal(pendingPipelines(), 0)
  pass.setPipeline(a)
  pass.drawIndexed()
  assert.equal(pass.pipeline, ready)
  assert.equal(pass.draws, 1)
  pass.setPipeline(b)
  pass.drawIndexed()
  assert.equal(pass.draws, 2)
  device.createRenderPipeline({ label: 'one-shot pass', layout })
  assert.equal(device.sync, 1, 'unrelated pipelines retain native semantics')
})

test('preparation batches share duplicate work and yield to an interactive callback between batches', async () => {
  const renderer = {}
  const started: string[] = []
  const pending: { resolve(value: object): void; reject(error: unknown): void }[] = []
  const queue = createPreparationQueue({ batch: 2, yield: resume => { setTimeout(resume, 0) } })
  const work = (key: string) => () => new Promise<object>((resolve, reject) => {
    started.push(key)
    pending.push({ resolve, reject })
  })
  const first = queue.request(renderer, 'a', work('a'))
  const duplicate = queue.request(renderer, 'a', work('a'))
  const second = queue.request(renderer, 'b', work('b'))
  const third = queue.request(renderer, 'c', work('c'))
  assert.equal(duplicate, first, 'a duplicate request shares the outstanding preparation')
  assert.deepEqual(started, ['a', 'b'], 'only one batch starts before the browser gets a turn')
  let interactive = 0
  setTimeout(() => { interactive++ }, 0)
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(interactive, 1, 'a scheduled interactive callback runs while preparation is pending')
  assert.deepEqual(started, ['a', 'b', 'c'], 'the next batch resumes after the interactive turn')
  pending[0].resolve({})
  pending[1].resolve({})
  assert.deepEqual(await Promise.all([first, duplicate, second]), [{}, {}, {}])
  pending[2].reject(new Error('shader failed'))
  await assert.rejects(third, /shader failed/)
})

// Owner 2026-11-04: start-screen cosmetics, then course assets, showed at about 5% opacity for seconds. Every variant of a
// part is a lit pipeline compiled here; the shadow one was ready long before the forward one and drew alone (its shadow
// and prepass ghost with no surface).
test('a material draws in no pass until every variant requested for it is compiled; fieldReady needs its forward variant', async () => {
  const pending = new Map<string, () => void>()
  class Device {
    createShaderModule(descriptor: { code: string }): object { return { code: descriptor.code } }
    createPipelineLayout(_descriptor: unknown): object { return {} }
    createRenderPipeline(_descriptor: unknown): object { return {} }
    createRenderPipelineAsync(descriptor: { vertex: { module: { code: string } } }): Promise<object> {
      return new Promise<object>(done => { pending.set(descriptor.vertex.module.code, () => done({})) })
    }
  }
  class Pass {
    draws = 0
    setPipeline(_value: unknown): void {}
    drawIndexed(): void { this.draws++ }
  }
  class Context {
    canvas = {}
    configure(_config: unknown): void {}
  }
  installAsyncLitPipelines(Device.prototype, Pass.prototype, Context.prototype)
  const device = new Device()
  const context = new Context()
  context.configure({ device })
  assert.equal(deviceOfCanvas(context.canvas), device)
  const layout = device.createPipelineLayout({ bindGroupLayouts: [] })
  const body = (part: string): string => `// sdff: part ${part}\nfn material_main() {}\n`
  const variant = (part: string, pass: string): object => {
    const code = `// raa variant: pass ${pass}, msaa 1\n\n// raa section: prelude\n\n// raa section: material\n${body(part)}\n// raa section: pass ${pass}\n`
    return device.createRenderPipeline({ label: 'raa.lit.pipeline', layout, vertex: { module: device.createShaderModule({ code }) } })
  }
  const settle = async (part: string, pass: string): Promise<void> => {
    const found = [...pending].find(([code]) => code.includes(`part ${part}\n`) && code.startsWith(`// raa variant: pass ${pass},`))
    assert.ok(found, `${part} ${pass}`)
    found[1]()
    pending.delete(found[0])
    await new Promise(resolve => setTimeout(resolve, 0))
  }
  const frame = (pipelines: object[]): number => {
    const pass = new Pass()
    for (const pipeline of pipelines) { pass.setPipeline(pipeline); pass.drawIndexed() }
    return pass.draws
  }
  const hat = materialKey(body('hat'))
  const shadow = variant('hat', 'Shadow')
  assert.deepEqual(fieldReadiness(device, hat), { status: 'pending' })
  assert.equal(fieldReady(device, hat), false)
  await settle('hat', 'Shadow')
  assert.equal(fieldReady(device, hat), false, 'a shadow variant alone is not the part drawn')
  const forward = variant('hat', 'Forward')
  const prepass = variant('hat', 'Prepass')
  assert.equal(frame([shadow, prepass, forward]), 0, 'the compiled shadow never draws while the forward variant compiles')
  await settle('hat', 'Forward')
  assert.equal(frame([shadow, prepass, forward]), 0, 'nor while the prepass compiles')
  assert.equal(fieldReady(device, hat), false)
  await settle('hat', 'Prepass')
  assert.deepEqual(fieldReadiness(device, hat), { status: 'ready' })
  assert.equal(fieldReady(device, hat), true)
  assert.equal(frame([shadow, prepass, forward]), 3)
  assert.equal(fieldReady({}, hat), false, 'another device compiles its own pipelines')
  const late = variant('hat', 'Transparent')
  assert.equal(frame([shadow, prepass, forward, late]), 3, 'once drawn, a variant requested later omits only its own draws')
  assert.equal(fieldReady(device, hat), true)
  await settle('hat', 'Transparent')
  assert.equal(frame([late]), 1)
  assert.equal(pendingPipelines(), 0)
})

test('validation errors surface and only internal backend errors use the sync fallback', async () => {
  let reason = 'validation'
  const error = { reason }
  const promises: Promise<object>[] = []
  class Device {
    sync = 0
    createPipelineLayout(_descriptor: unknown): object { return {} }
    createRenderPipeline(_descriptor: unknown): object { this.sync++; return {} }
    createRenderPipelineAsync(_descriptor: unknown): Promise<object> {
      const promise = Promise.reject<object>({ ...error, reason })
      promises.push(promise)
      return promise
    }
  }
  class Pass { setPipeline(_value: unknown): void {} }
  installAsyncLitPipelines(Device.prototype, Pass.prototype)
  const device = new Device()
  const desc = { label: 'raa.lit.pipeline', layout: device.createPipelineLayout({ bindGroupLayouts: [] }) }
  const failed = device.createRenderPipeline(desc)
  await Promise.allSettled(promises)
  assert.throws(() => new Pass().setPipeline(failed), (e: unknown) => (e as { reason: string }).reason === 'validation')
  assert.equal(device.sync, 0)
  reason = 'internal'
  const before = asyncPipelineFallbacks()
  const retried = device.createRenderPipeline(desc)
  await Promise.allSettled(promises)
  new Pass().setPipeline(retried)
  assert.equal(device.sync, 1)
  assert.equal(asyncPipelineFallbacks(), before + 1)
})

test('a lit pipeline rejected on an invalid layout names the layout\'s own validation error', async () => {
  const scopes: (string | null)[][] = []
  const promises: Promise<object>[] = []
  class Device {
    createShaderModule(_descriptor: { code: string }): object { return {} }
    pushErrorScope(_filter: string): void { scopes.push([]) }
    popErrorScope(): Promise<{ message: string } | null> {
      const errors = scopes.pop() ?? []
      return Promise.resolve(errors[0] === undefined || errors[0] === null ? null : { message: errors[0] })
    }
    createBindGroupLayout(descriptor: { entries: unknown[] }): object {
      if (descriptor.entries.length > 8) scopes[scopes.length - 1].push('exceeds maxStorageBuffersPerShaderStage (8)')
      return {}
    }
    createPipelineLayout(_descriptor: unknown): object { return {} }
    createRenderPipeline(_descriptor: unknown): object { return {} }
    createRenderPipelineAsync(_descriptor: unknown): Promise<object> {
      const promise = Promise.reject<object>(Object.assign(new Error('[Invalid PipelineLayout "raa.lit.pipeline_layout"] is invalid due to a previous error.'), { reason: 'validation' }))
      promises.push(promise)
      return promise
    }
  }
  class Pass { setPipeline(_value: unknown): void {} }
  installAsyncLitPipelines(Device.prototype, Pass.prototype)
  const device = new Device()
  const good = device.createBindGroupLayout({ entries: [] })
  const bad = device.createBindGroupLayout({ label: 'raa.lit.extra', entries: new Array(9).fill({}) } as { entries: unknown[] })
  const layout = device.createPipelineLayout({ label: 'raa.lit.pipeline_layout', bindGroupLayouts: [good, null, bad] })
  const errors: string[] = []
  const log = console.error
  console.error = (m: string) => { errors.push(m) }
  try {
    const wgsl = 'fn field_material() {}'
    const module = device.createShaderModule({ code: `// raa variant: pass Forward, msaa 1\n// raa section: material \"field_material\"\n${wgsl}\n// raa section: pass Forward\n` })
    const failed = device.createRenderPipeline({ label: 'raa.lit.pipeline', layout, vertex: { module } })
    assert.deepEqual(fieldReadiness(device, materialKey(wgsl)), { status: 'pending' })
    await Promise.allSettled(promises)
    while (pendingPipelines() > 0) await new Promise(resolve => setTimeout(resolve, 0))
    const readiness = fieldReadiness(device, materialKey(wgsl))
    assert.equal(readiness.status, 'failed')
    assert.equal(fieldReady(device, materialKey(wgsl)), false, 'rejected work never becomes ready')
    assert.ok(readiness.status === 'failed' && readiness.reason.includes('previous error: createBindGroupLayout \"raa.lit.extra\": exceeds maxStorageBuffersPerShaderStage (8)'))
    assert.throws(() => new Pass().setPipeline(failed), (e: unknown) => {
      const error = e as Error & { reason?: string }
      return error.reason === 'validation' && error.message.includes('is invalid due to a previous error')
        && error.message.includes('previous error: createBindGroupLayout "raa.lit.extra": exceeds maxStorageBuffersPerShaderStage (8)')
    })
  } finally {
    console.error = log
  }
  assert.deepEqual(errors, ['[webgpu] createBindGroupLayout "raa.lit.extra": exceeds maxStorageBuffersPerShaderStage (8)'])
})
