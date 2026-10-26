// Versioned wire format preserves typed arrays and shared transfer buffers exactly.
import type { MeshedAsset } from './mamaApi.ts'

export function encodeMesh(value: MeshedAsset): Uint8Array {
  const buffers: ArrayBuffer[] = []
  const index = (buffer: ArrayBuffer): number => {
    let i = buffers.indexOf(buffer)
    if (i < 0) { i = buffers.length; buffers.push(buffer) }
    return i
  }
  const json = JSON.stringify(value, (_key, v: unknown) => {
    if (v instanceof ArrayBuffer) return { $buffer: index(v) }
    if (ArrayBuffer.isView(v)) return { $array: v.constructor.name, buffer: index(v.buffer as ArrayBuffer), offset: v.byteOffset, length: v.byteLength }
    return v
  })
  const header = new TextEncoder().encode(json)
  const size = 9 + header.length + buffers.reduce((n, b) => n + 4 + b.byteLength, 0)
  const out = new Uint8Array(size)
  const view = new DataView(out.buffer)
  out[0] = 1
  view.setUint32(1, header.length)
  view.setUint32(5, buffers.length)
  out.set(header, 9)
  let offset = 9 + header.length
  for (const buffer of buffers) {
    view.setUint32(offset, buffer.byteLength)
    out.set(new Uint8Array(buffer), offset + 4)
    offset += 4 + buffer.byteLength
  }
  return out
}

export function decodeMesh(bytes: Uint8Array): MeshedAsset {
  if (bytes[0] !== 1) throw new Error('unsupported mesh format')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const length = view.getUint32(1)
  const count = view.getUint32(5)
  const buffers: ArrayBuffer[] = []
  let offset = 9 + length
  for (let i = 0; i < count; i++) {
    const size = view.getUint32(offset)
    offset += 4
    if (offset + size > bytes.length) throw new Error('truncated mesh')
    buffers.push(bytes.slice(offset, offset + size).buffer)
    offset += size
  }
  if (offset !== bytes.length) throw new Error('invalid mesh length')
  const types = { Float32Array, Float64Array, Uint32Array, Uint8Array, Int32Array, Uint16Array, Int16Array, Int8Array }
  return JSON.parse(new TextDecoder().decode(bytes.subarray(9, 9 + length)), (_key, v) => {
    if (v && typeof v === 'object' && '$buffer' in v) return buffers[v.$buffer]
    if (v && typeof v === 'object' && '$array' in v) {
      const Type = types[v.$array as keyof typeof types]
      if (!Type) throw new Error('unsupported mesh array')
      return new Type(buffers[v.buffer], v.offset, v.length / Type.BYTES_PER_ELEMENT)
    }
    return v
  }) as MeshedAsset
}
