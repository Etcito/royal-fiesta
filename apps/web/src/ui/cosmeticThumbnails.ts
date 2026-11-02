import type { AssetCommand, UiRenderer } from '@etcito/uaa'
import { SHADER, containLogo, decodeLogo, type LogoDevice } from './logoRenderer.ts'

// Bundle saved sidecars verbatim; each variant has its own independently tinted image.
let files: Record<string, string> = {}
try { files = import.meta.glob<string>('../../../../assets/**/*.thumb.avif', { query: '?url', import: 'default', eager: true }) } catch { /* Node model tests have no Vite loader. */ }
const urls = new Map(Object.entries(files).map(([path, url]) => [path.split('/').pop()!.replace('.thumb.avif', ''), url]))
export function thumbnailUrl(id: string): string | undefined { return urls.get(id) }

export async function withCosmeticThumbnails(renderer: UiRenderer, canvas: HTMLCanvasElement, device: LogoDevice,
  selected: ReadonlyMap<string, string>): Promise<UiRenderer> {
  const shader = device.createShaderModule({ label: 'cosmetic-thumbnails', code: SHADER })
  const gpu = (navigator as Navigator & { gpu: { getPreferredCanvasFormat(): string } }).gpu
  const blend = { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' }
  const pipeline = await device.createRenderPipelineAsync({ layout: 'auto',
    vertex: { module: shader, entryPoint: 'vertex' },
    fragment: { module: shader, entryPoint: 'fragment', targets: [{ format: gpu.getPreferredCanvasFormat(), blend: { color: blend, alpha: blend } }] },
    primitive: { topology: 'triangle-list' } })
  const context = canvas.getContext('webgpu') as unknown as { getCurrentTexture(): { createView(): unknown } }
  const textures = new Map<string, { texture: ReturnType<LogoDevice['createTexture']>; width: number; height: number }>()
  // Only real sidecars are requested: absent art becomes a name card, never a fallback box.
  for (const [id, url] of urls) {
    const response = await fetch(new URL(url, document.baseURI))
    if (!response.ok) continue
    const bitmap = await decodeLogo(await response.blob())
    const texture = device.createTexture({ size: [bitmap.width, bitmap.height], format: 'rgba8unorm', usage: 0x16 })
    device.queue.copyExternalImageToTexture({ source: bitmap }, { texture, premultipliedAlpha: true }, [bitmap.width, bitmap.height])
    textures.set(id, { texture, width: bitmap.width, height: bitmap.height }); bitmap.close()
  }
  const uniforms = new Map<string, ReturnType<LogoDevice['createBuffer']>>()
  const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' })
  return {
    kind: renderer.kind, resize: v => renderer.resize(v),
    render(list) {
      const images: AssetCommand[] = []
      renderer.render({ ...list, commands: list.commands.filter(c => {
        if (c.kind !== 'asset' || !c.widget.startsWith('thumb-')) return true
        if (selected.has(c.widget)) images.push(c)
        return false
      }) })
      if (!images.length) return
      const encoder = device.createCommandEncoder()
      const pass = encoder.beginRenderPass({ colorAttachments: [{ view: context.getCurrentTexture().createView(), loadOp: 'load', storeOp: 'store' }] })
      pass.setPipeline(pipeline)
      for (const c of images) {
        const image = textures.get(selected.get(c.widget)!)
        if (!image || c.opacity <= 0) continue
        let buffer = uniforms.get(c.widget)
        if (!buffer) { buffer = device.createBuffer({ size: 64, usage: 0x48 }); uniforms.set(c.widget, buffer) }
        const r = containLogo(c.rect, image.width, image.height)
        device.queue.writeBuffer(buffer, 0, new Float32Array([r.x, r.y, r.w, r.h, ...c.transform.slice(0, 4), ...c.transform.slice(4), list.viewport.width, list.viewport.height, c.opacity, 0, 0, 0]))
        pass.setBindGroup(0, device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
          { binding: 0, resource: { buffer } }, { binding: 1, resource: image.texture.createView() }, { binding: 2, resource: sampler },
        ] }))
        pass.draw(6)
      }
      pass.end(); device.queue.submit([encoder.finish()])
    },
    destroy() { for (const t of textures.values()) t.texture.destroy(); for (const b of uniforms.values()) b.destroy(); renderer.destroy() },
  }
}
