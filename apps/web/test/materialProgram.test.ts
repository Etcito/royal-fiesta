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
  assert.equal(shaderCode('fn/* asset /* nested */ name */f() {// node ID\nreturn; }'), 'fn f() { return; }\n')
  assert.throws(() => shaderCode('/* incomplete'), /Unterminated/)
})
