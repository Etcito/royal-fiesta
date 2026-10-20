export interface RaaStatus { available: boolean; reason: string; apiVersion: string | null }

export const RAA_REASON_PREFIX = 'RAA API v0 not found in '

export async function raaStatus(): Promise<RaaStatus> {
  const engine = await import('@raa/engine')
  const marker = engine.RAA_API_VERSION
  if (engine.RAA_ABSENT !== true && typeof marker === 'string' && marker.startsWith('0')) {
    return { available: true, reason: 'RAA API v0 available', apiVersion: marker }
  }
  const dir = engine.RAA_ABSENT === true ? 'no raa repo' : 'raa repo'
  return { available: false, reason: RAA_REASON_PREFIX + dir, apiVersion: null }
}
