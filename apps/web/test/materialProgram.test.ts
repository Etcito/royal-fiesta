import assert from 'node:assert/strict'
import test from 'node:test'
import { materialProgram, shaderCode } from '../src/sdf/materialProgram.ts'

test('material words survive finite float transport exactly, including NaN and subnormal bit patterns', () => {
  const words = [0xffffffff, 0x7fc00001, 0x00000001, 0x80000000]
  const material = {
    name: 'first asset', key: 'a'.repeat(64), helpers: [], fields: ['base_color'], constants: words,
    body: 'let unused = bitcast<f32>(extra_words[b + 3u]); return MaterialFull(vec3f(bitcast<f32>(extra_words[b + 0u]), bitcast<f32>(extra_words[b + 1u]), bitcast<f32>(extra_words[b + 2u])));',
  }
  const mapped = materialProgram(material)
  const values = Object.values(mapped.desc.params ?? {}).flat().map(Math.fround)
  assert.ok(values.every(value => Number.isFinite(value) && value >= 0 && value <= 65535))
  assert.deepEqual(words.map((_word, i) => (values[i * 2] | (values[i * 2 + 1] << 16)) >>> 0), words)
  const changed = materialProgram({ ...material, name: 'second asset', key: 'b'.repeat(64), constants: words.map(word => (word ^ 1) >>> 0) })
  assert.equal(mapped.wgsl, changed.wgsl)
  assert.equal(mapped.functionName, changed.functionName)
  assert.notDeepEqual(mapped.desc.params, changed.desc.params)
})

test('comment removal keeps tokens separate and handles nested block comments', () => {
  assert.equal(shaderCode('fn/* asset /* nested */ name */f() {// node ID\nreturn; }'), 'fn f() {\nreturn; }\n')
  assert.throws(() => shaderCode('/* incomplete'), /Unterminated/)
})

// RAA refuses a bitwise operator mixed with another operator on one source line. Folding the
// program onto one line made pcg_hash's top-level `^` meet other statements' `*` (card 8774,
// candy.checkpoint-gate: material.fn_invalid on the Forward msaa 4 variant).
test('programs keep one statement per line, so no line mixes a bitwise with another operator', () => {
  const helper = 'fn pcg_hash(x: u32) -> u32 {\n  let state = x * 747796405u + 2891336453u;\n  let word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;\n  return (word >> 22u) ^ word;\n}'
  const material = {
    name: 'paint', key: 'c'.repeat(64), helpers: [{ id: 'hash', wgsl: helper }], fields: ['base_color'], constants: [1, 2],
    body: 'let n = f32(pcg_hash(1u) >> 8u) * 2.0;\n  return MaterialFull(vec3f(bitcast<f32>(extra_words[b + 0u]) * n, bitcast<f32>(extra_words[b + 1u]), 0.0));',
  }
  const { wgsl } = materialProgram(material)
  assert.ok(wgsl.includes("\nreturn (word >> 22u) ^ word;\n"), wgsl)
  for (const line of wgsl.split('\n')) {
    // Top-level text of the line (nested groups removed), as RAA's guard sees it.
    let top = line
    for (let prev = ''; prev !== top;) { prev = top; top = top.replace(/\([^()]*\)|\[[^[\]]*\]/g, ' ') }
    const bitwise = [' ^ ', ' | ', ' & '].filter(op => top.includes(op))
    const other = [' * ', ' / ', ' % ', ' + ', ' - ', ' << ', ' >> '].some(op => top.includes(op))
    assert.ok(bitwise.length === 0 || (bitwise.length === 1 && !other), `operator mix on one line: ${line}`)
  }
})
