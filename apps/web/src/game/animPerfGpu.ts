// Check-only WebGPU timestamp instrumentation. Installed before the check creates its RAA device.
// No engine API changes; unavailable timestamps are reported as null, never CPU time labelled GPU.
export function animPerfGpu() {
  // WebGPU types are intentionally not a dependency of the game.
  const gpu = (navigator as any).gpu
  const adapterProto = (globalThis as any).GPUAdapter?.prototype
  if (!gpu || !adapterProto)
    return { begin() { }, async end() { return null; }, dispose() { } }
  const original = adapterProto.requestDevice
  const records: any[] = []
  let active = false
  adapterProto.requestDevice = async function (desc: any = {}) {
    const supported = this.features.has('timestamp-query')
    const device = await original.call(this, supported ? { ...desc, requiredFeatures: [...new Set([...(desc.requiredFeatures ?? []), 'timestamp-query'])] } : desc)
    if (!supported)
      return device
    const queries = device.createQuerySet({ type: 'timestamp', count: 128 })
    const resolved = device.createBuffer({ size: 1024, usage: 512 | 4 }); // QUERY_RESOLVE | COPY_SRC
    const read = device.createBuffer({ size: 1024, usage: 8 | 1 }); // COPY_DST | MAP_READ
    const record = { device, queries, resolved, read, count: 0, create: device.createCommandEncoder.bind(device) }
    records.push(record)
    device.createCommandEncoder = (...args: any[]) => {
      const encoder = record.create(...args)
      for (const method of ['beginRenderPass', 'beginComputePass']) {
        const begin = encoder[method].bind(encoder)
        encoder[method] = (descriptor: any = {}) => {
          if (!active || record.count + 2 > 128)
            return begin(descriptor)
          const start = record.count
          record.count += 2
          return begin({ ...descriptor, timestampWrites: { querySet: queries, beginningOfPassWriteIndex: start, endOfPassWriteIndex: start + 1 } })
        }
      }
      return encoder
    }
    return device
  }
  return {
    begin() { for (const r of records)
      r.count = 0; active = true; },
    async end(): Promise<number | null> {
      active = false
      let ns = 0, found = false
      for (const r of records) {
        if (!r.count)
          continue
        found = true
        const encoder = r.create()
        encoder.resolveQuerySet(r.queries, 0, r.count, r.resolved, 0)
        encoder.copyBufferToBuffer(r.resolved, 0, r.read, 0, r.count * 8)
        r.device.queue.submit([encoder.finish()])
        await r.read.mapAsync(1)
        const values = new BigUint64Array(r.read.getMappedRange())
        for (let i = 0; i < r.count; i += 2)
          ns += Number(values[i + 1] - values[i])
        r.read.unmap()
      }
      return found ? ns / 1e6 : null
    },
    dispose() {
      adapterProto.requestDevice = original
      for (const r of records) {
        r.queries.destroy()
        r.resolved.destroy()
        r.read.destroy()
      }
    },
  }
}
