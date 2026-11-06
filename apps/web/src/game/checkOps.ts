import type { AdapterInfo } from '../nmc/ops.ts'
import type { BootGame, TourDeps } from './uiTour.ts'

interface CheckModule {
  name: string
  run(input: unknown, deps: TourDeps): Promise<{ json: unknown; files: { name: string; blob: Blob }[] }>
}

async function adapterInfo(): Promise<AdapterInfo> {
  const gpu = (navigator as { gpu?: {
    requestAdapter(): Promise<{ info?: Partial<AdapterInfo> & { isFallbackAdapter?: boolean }; isFallbackAdapter?: boolean } | null>
  } }).gpu
  const adapter = await gpu?.requestAdapter()
  if (!adapter) throw new Error('WebGPU adapter unavailable')
  const { vendor = '', architecture = '', description = '', isFallbackAdapter } = adapter.info ?? {}
  return { vendor, architecture, description,
    software: isFallbackAdapter === true || adapter.isFallbackAdapter === true || /swiftshader/i.test(`${vendor} ${architecture} ${description}`) }
}

export function installCheckOps(take: () => void, bootGame: BootGame): void {
  const modules = import.meta.glob<CheckModule>('./checks/*.ts', { eager: true })
  const ops = window.nmcGpu!.ops as unknown as Record<string, (input: unknown) => ReturnType<CheckModule['run']>>
  // The entry's waiting placeholders (marked pending) are not ops yet: the checks replace them.
  const names = new Set(Object.keys(ops).filter(name => !(ops[name] as { pending?: boolean }).pending))
  for (const [file, check] of Object.entries(modules)) {
    // a helper left in checks/ has no `name`: two of them read as one duplicate op `undefined` and no op registered
    if (typeof check.name !== 'string') throw new Error(`${file} is in checks/ but exports no op name: helpers belong in checkSupport/`)
    if (names.has(check.name)) throw new Error(`Duplicate check op: ${check.name}`)
    names.add(check.name)
  }
  for (const { name, run } of Object.values(modules)) {
    ops[name] = input => (take(), run(input, { boot: bootGame, adapter: adapterInfo }))
  }
}
