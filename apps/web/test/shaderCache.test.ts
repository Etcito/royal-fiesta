import assert from 'node:assert/strict'
import test from 'node:test'
import { installShaderCache, shaderHash, shaderTimings, stableShaderSource } from '../src/render/shaderCache.ts'

test('release compositor registration metadata does not change compiled source or line numbers', () => {
  const source = (name: string, id: number): string => `// raa variant: material "${name}" (id ${id}), pass Forward, msaa 4, flags 0x0, slots 123\n// raa section: material "${name}"\nfn material_main() {}`
  assert.equal(stableShaderSource(source('asset.a', 7)), stableShaderSource(source('asset.b', 42)))
  assert.equal(stableShaderSource(source('asset.a', 7)).split('\n').length, 3)
})

test('shader cache respects device, source, layout and pipeline state', () => {
  class Handle {}
  class Device {
    modules = 0
    pipelines = 0
    createShaderModule(_desc: unknown): Handle { this.modules++; return new Handle() }
    createRenderPipeline(_desc: unknown): Handle { this.pipelines++; return new Handle() }
    createBindGroupLayout(_desc: unknown): Handle { return new Handle() }
    createPipelineLayout(_desc: unknown): Handle { return new Handle() }
  }
  installShaderCache(Device.prototype)
  installShaderCache(Device.prototype)
  const device = new Device()
  const module = device.createShaderModule({ code: 'shader', label: 'first' })
  assert.equal(module, device.createShaderModule({ label: 'second', code: 'shader' }))
  assert.notEqual(module, device.createShaderModule({ code: 'changed' }))
  assert.notEqual(module, new Device().createShaderModule({ code: 'shader' }))
  const layout = device.createPipelineLayout({ bindGroupLayouts: [device.createBindGroupLayout({ entries: [] })] })
  const sameLayout = device.createPipelineLayout({ bindGroupLayouts: [device.createBindGroupLayout({ entries: [] })] })
  assert.equal(layout, sameLayout)
  const desc = { layout, vertex: { module }, primitive: { cullMode: 'back' } }
  const pipeline = device.createRenderPipeline(desc)
  assert.equal(pipeline, device.createRenderPipeline({ ...desc, layout: sameLayout }))
  assert.notEqual(pipeline, device.createRenderPipeline({ ...desc, layout: new Handle() }))
  assert.notEqual(pipeline, device.createRenderPipeline({ ...desc, primitive: { cullMode: 'front' } }))
  assert.equal(device.modules, 2)
  assert.equal(device.pipelines, 3)
  assert.deepEqual(shaderTimings.at(-1)?.modules, [shaderHash('shader')])
})

test('concurrent async pipeline requests share work and rejected requests can retry', async () => {
  class Device {
    builds = 0
    createComputePipelineAsync(_desc: unknown): Promise<object> {
      this.builds++
      return this.builds === 1 ? Promise.reject(new Error('compile failed')) : Promise.resolve({})
    }
  }
  installShaderCache(Device.prototype)
  const device = new Device()
  const a = device.createComputePipelineAsync({ layout: 'auto' })
  const b = device.createComputePipelineAsync({ layout: 'auto' })
  assert.equal(a, b)
  await assert.rejects(a, /compile failed/)
  const c = await device.createComputePipelineAsync({ layout: 'auto' })
  assert.equal(await device.createComputePipelineAsync({ layout: 'auto' }), c)
  assert.equal(device.builds, 2)
})
