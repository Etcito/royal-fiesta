import assert from 'node:assert/strict'
import test from 'node:test'
import { asyncPipelineFallbacks, installAsyncLitPipelines, pendingPipelines } from '../src/render/asyncPipelines.ts'

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
  const b = device.createRenderPipeline({ label: 'raa.lit.pipeline', layout })
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
    const failed = device.createRenderPipeline({ label: 'raa.lit.pipeline', layout })
    await Promise.allSettled(promises)
    while (pendingPipelines() > 0) await new Promise(resolve => setTimeout(resolve, 0))
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
