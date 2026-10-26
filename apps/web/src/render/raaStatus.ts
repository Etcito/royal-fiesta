export interface RaaStatus { available: boolean; reason: string; apiVersion: string | null }

export const RAA_REASON_PREFIX = 'RAA not available: '
// The public API of @etcito/raa 0.3.0 (see its index.d.ts): loadRaa() and createEngine().
export const RAA_API_VERSION = '0.1.0'

// RAA draws with WebGPU only. The package is a normal dependency, so its presence is not checked
// here: a browser without navigator.gpu (or a Node process) reports the reason instead.
export async function raaStatus(): Promise<RaaStatus> {
  const nav = (globalThis as { navigator?: { gpu?: unknown } }).navigator
  if (nav === undefined || nav.gpu === undefined || nav.gpu === null) {
    return { available: false, reason: RAA_REASON_PREFIX + 'no WebGPU (navigator.gpu) in this environment', apiVersion: null }
  }
  return { available: true, reason: 'RAA API v0 available', apiVersion: RAA_API_VERSION }
}
