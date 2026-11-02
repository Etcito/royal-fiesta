import type { AdapterInfo } from '../nmc/ops.ts'
import type { BootGame, TourDeps } from './uiTour.ts'

interface CheckModule {
  name: string
  run(input: unknown, deps: TourDeps): Promise<{ json: unknown; files: { name: string; blob: Blob }[] }>
}

async function adapterInfo(): Promise<AdapterInfo> {
  const gpu = (navigator as Navigator & { gpu?: {
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
  for (const check of Object.values(modules)) {
    if (names.has(check.name)) throw new Error(`Duplicate check op: ${check.name}`)
    names.add(check.name)
  }
  for (const { name, run } of Object.values(modules)) {
    ops[name] = input => (take(), run(input, { boot: bootGame, adapter: adapterInfo }))
  }
}
