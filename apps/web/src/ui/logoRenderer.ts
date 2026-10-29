// The raster logo shares uaa's WebGPU canvas, layout, animation and screenshot path.
import type { AssetCommand, DrawList, Rect, UiRenderer } from '@etcito/uaa'

interface Texture { createView(): unknown; destroy(): void }
interface Buffer { destroy(): void }
interface Pipeline { getBindGroupLayout(index: number): unknown }
interface Pass {
  setPipeline(pipeline: Pipeline): void
  setBindGroup(index: number, group: unknown): void
  draw(vertices: number): void
  end(): void
}
export interface LogoDevice {
  createTexture(descriptor: unknown): Texture
  createBuffer(descriptor: unknown): Buffer
  createShaderModule(descriptor: unknown): unknown
  createRenderPipelineAsync(descriptor: unknown): Promise<Pipeline>
  createSampler(descriptor: unknown): unknown
  createBindGroup(descriptor: unknown): unknown
  createCommandEncoder(): { beginRenderPass(descriptor: unknown): Pass; finish(): unknown }
  queue: {
    copyExternalImageToTexture(source: unknown, destination: unknown, size: unknown): void
    writeBuffer(buffer: Buffer, offset: number, data: Float32Array): void
    submit(commands: unknown[]): void
  }
}

const SHADER = `
struct Globals {
  rect: vec4f,
  linear: vec4f,
  translateViewport: vec4f,
  opacity: vec4f,
};
@group(0) @binding(0) var<uniform> g: Globals;
@group(0) @binding(1) var image: texture_2d<f32>;
@group(0) @binding(2) var imageSampler: sampler;
struct Vertex { @builtin(position) position: vec4f, @location(0) uv: vec2f };
@vertex fn vertex(@builtin(vertex_index) index: u32) -> Vertex {
  let corners = array<vec2f, 6>(vec2f(0,0), vec2f(1,0), vec2f(0,1), vec2f(0,1), vec2f(1,0), vec2f(1,1));
  let uv = corners[index];
  let p = g.rect.xy + uv * g.rect.zw;
  let q = vec2f(g.linear.x * p.x + g.linear.z * p.y, g.linear.y * p.x + g.linear.w * p.y) + g.translateViewport.xy;
  return Vertex(vec4f(q.x / g.translateViewport.z * 2 - 1, 1 - q.y / g.translateViewport.w * 2, 0, 1), uv);
}
@fragment fn fragment(v: Vertex) -> @location(0) vec4f {
  return textureSample(image, imageSampler, v.uv) * g.opacity.x;
}`

export function containLogo(rect: Rect, width: number, height: number): Rect {
  const scale = Math.min(rect.w / width, rect.h / height)
  const w = width * scale
  const h = height * scale
  return { x: rect.x + (rect.w - w) / 2, y: rect.y + (rect.h - h) / 2, w, h }
}

export function logoFile(logo: { sha256: string; format: 'png' | 'svg' }): string {
  return `images/${logo.sha256}.${logo.format === 'svg' ? 'svg' : 'avif'}`
}

async function decodeLogo(blob: Blob): Promise<ImageBitmap> {
  // Decode through the browser's image loader, which accepts SVG as well as AVIF.
  // Some browsers reject an SVG Blob passed directly to createImageBitmap().
  const url = URL.createObjectURL(blob)
  try {
    const image = new Image()
    image.src = url
    await image.decode()
    return await createImageBitmap(image)
  } finally { URL.revokeObjectURL(url) }
}

export async function withLogo(
  renderer: UiRenderer, canvas: HTMLCanvasElement, device: LogoDevice,
  logo: { asset: string; sha256: string; format: 'png' | 'svg'; width: number; height: number }, baseUri: string,
): Promise<UiRenderer> {
  const response = await fetch(new URL(logoFile(logo), baseUri))
  if (!response.ok) throw new Error(`ui-logo: bundled image answered HTTP ${response.status}`)
  const bitmap = await decodeLogo(await response.blob())
  if (bitmap.width !== logo.width || bitmap.height !== logo.height) {
    bitmap.close()
    throw new Error('ui-logo: bundled image dimensions do not match ui/logo.json')
  }
  const texture = device.createTexture({ size: [logo.width, logo.height], format: 'rgba8unorm', usage: 0x16 })
  const globals = device.createBuffer({ size: 64, usage: 0x48 })
  try {
    // Premultiply once at upload; the pass uses the same premultiplied blend as uaa.
    device.queue.copyExternalImageToTexture({ source: bitmap }, { texture, premultipliedAlpha: true }, [logo.width, logo.height])
    const shader = device.createShaderModule({ label: 'royal-fiesta.logo', code: SHADER })
    const context = canvas.getContext('webgpu') as unknown as { getCurrentTexture(): Texture }
    const gpu = (navigator as Navigator & { gpu: { getPreferredCanvasFormat(): string } }).gpu
    const blend = { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' }
    const pipeline = await device.createRenderPipelineAsync({
      layout: 'auto',
      vertex: { module: shader, entryPoint: 'vertex' },
      fragment: { module: shader, entryPoint: 'fragment', targets: [{ format: gpu.getPreferredCanvasFormat(), blend: { color: blend, alpha: blend } }] },
      primitive: { topology: 'triangle-list' },
    })
    const group = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: globals } },
      { binding: 1, resource: texture.createView() },
      { binding: 2, resource: device.createSampler({ magFilter: 'linear', minFilter: 'linear' }) },
    ] })
    return {
      kind: renderer.kind,
      resize: viewport => renderer.resize(viewport),
      render(list: DrawList) {
        let command: AssetCommand | undefined
        const commands = list.commands.filter(c => {
          if (c.kind !== 'asset' || c.asset.id !== logo.asset) return true
          command = c
          return false
        })
        renderer.render({ ...list, commands })
        if (command === undefined || command.opacity <= 0) return
        const r = containLogo(command.rect, logo.width, logo.height)
        device.queue.writeBuffer(globals, 0, new Float32Array([
          r.x, r.y, r.w, r.h, ...command.transform.slice(0, 4),
          ...command.transform.slice(4), list.viewport.width, list.viewport.height,
          command.opacity, 0, 0, 0,
        ]))
        const encoder = device.createCommandEncoder()
        const pass = encoder.beginRenderPass({ colorAttachments: [{ view: context.getCurrentTexture().createView(), loadOp: 'load', storeOp: 'store' }] })
        pass.setPipeline(pipeline)
        pass.setBindGroup(0, group)
        pass.draw(6)
        pass.end()
        device.queue.submit([encoder.finish()])
      },
      destroy() { texture.destroy(); globals.destroy(); renderer.destroy() },
    }
  } catch (error) {
    texture.destroy()
    globals.destroy()
    throw error
  } finally {
    bitmap.close()
  }
}
