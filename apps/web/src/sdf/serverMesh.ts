import type { MeshedAsset } from './mamaApi.ts'
import { decodeMesh } from './meshWire.ts'

// An absent mesh service falls back locally; an explicit refusal remains a refusal.
export async function fetchServerMesh(root: string, key: string, waiting: () => void, fetcher = globalThis.fetch, limitMs = 300000): Promise<MeshedAsset | null> {
  const url = root.replace(/\/?$/, '/') + 'meshes/' + key
  let deadline = Date.now() + limitMs
  let started = false
  for (;;) {
    let response: Response
    try { response = await fetcher(url, { cache: 'no-store', signal: AbortSignal.timeout(Math.max(1, Math.min(10000, deadline - Date.now()))) }) }
    catch {
      if (!started) return null
      throw new Error('mesh server became unavailable while building meshes')
    }
    if (response.status === 404) return null
    if (response.status === 422) throw new Error(await response.text())
    if (response.status === 200) {
      try { return decodeMesh(new Uint8Array(await response.arrayBuffer())) } catch { return null }
    }
    if (response.status !== 202) return null
    if (!started) {
      const serverLimit = Number(response.headers.get('x-mesh-timeout-ms'))
      if (Number.isFinite(serverLimit) && serverLimit > 0) deadline = Date.now() + serverLimit
      started = true
    }
    waiting()
    if (Date.now() >= deadline) throw new Error('timed out waiting for meshes on the server')
    await new Promise(resolve => setTimeout(resolve, Math.min(1000, deadline - Date.now())))
  }
}
