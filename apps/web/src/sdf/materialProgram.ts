import { mapMaterial } from '@etcito/raa-sdfm'
import type { SdfmCompiledMaterial, SdfmMappedMaterial } from '@etcito/raa-sdfm'
import { shaderHash } from '../render/shaderCache.ts'

// Strip nested WGSL comments before comparing programs. Asset/node names in comments are
// diagnostics, and must never select a different GPU program.
export function shaderCode(source: string): string {
  let out = ''
  for (let i = 0; i < source.length;) {
    if (source.startsWith('//', i)) {
      while (i < source.length && source[i] !== '\n') i++
      out += ' '
    } else if (source.startsWith('/*', i)) {
      let depth = 1
      i += 2
      while (i < source.length && depth > 0) {
        if (source.startsWith('/*', i)) { depth++; i += 2 }
        else if (source.startsWith('*/', i)) { depth--; i += 2 }
        else i++
      }
      if (depth !== 0) throw new Error('Unterminated WGSL comment')
      out += ' '
    } else out += source[i++]
  }
  return out.replace(/\s+/g, ' ').trim() + '\n'
}

export interface MaterialProgram extends SdfmMappedMaterial {
  desc: SdfmMappedMaterial['desc'] & { params?: Record<string, number[]> }
}

export function materialProgram(material: SdfmCompiledMaterial): MaterialProgram {
  const mapped = mapMaterial(material)
  const reads = [...material.body.matchAll(/extra_words\s*\[\s*b\s*\+\s*(\d+)u?\s*\]/g)]
  const indices = [...new Set(reads.map(read => Number(read[1])))].sort((a, b) => a - b)
  // RAA 0.3 has eight vec4 material parameters. Two exact 16-bit halves per word avoid
  // NaNs, subnormal flushing and loss of integer bits in the float parameter transport.
  // Larger graphs keep the adapter's validated path until RAA provides a larger buffer.
  if (indices.length > 16 || material.helpers.some(helper => /\bextra_words\b/.test(shaderCode(helper.wgsl)))) {
    const wgsl = shaderCode(mapped.wgsl)
    const functionName = `sdfm.code_${shaderHash(wgsl)}`
    return { ...mapped, wgsl, functionName, desc: { ...mapped.desc, function: functionName } }
  }
  const values = indices.flatMap(index => [material.constants[index] & 0xffff, material.constants[index] >>> 16])
  const params: Record<string, number[]> = {}
  for (let i = 0; i < values.length; i += 4) params[`p${i / 4}`] = values.slice(i, i + 4)
  const slots = new Map(indices.map((index, slot) => [index, slot * 2]))
  const read = (slot: number): string => `u32(record.p[${Math.floor(slot / 4)}u][${slot % 4}u])`
  let wgsl = mapped.wgsl.replace(/^const SDFM_K = array<u32, \d+>\([^\n]*\);\n/m, '')
    .replace('fn sdfm_graph(b:', 'fn sdfm_graph(record: SurfaceMaterialGpu, b:')
    .replace('sdfm_graph(0u,', 'sdfm_graph(in.record, 0u,')
    .replace(/SDFM_K\[\s*(\d+)u?\s*\]/g, (_expression, index: string) => {
      const slot = slots.get(Number(index))
      if (slot === undefined) throw new Error(`Unmapped material word ${index}`)
      return `(${read(slot)} | (${read(slot + 1)} << 16u))`
    })
  wgsl = shaderCode(wgsl)
  const functionName = `sdfm.buffer_${shaderHash(wgsl)}`
  return { ...mapped, wgsl, functionName, desc: { ...mapped.desc, function: functionName, params } }
}
