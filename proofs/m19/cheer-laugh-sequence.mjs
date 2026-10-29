// Package the MCP-authored emotes into one playable review timeline, without
// authoring clips or rendering frames. The GPU review remains a separate gate.
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { loadRaaAnim } from '@etcito/raa-anim'

const source = readFileSync('proofs/m19/penguin-cheer-laugh.glb')
const jsonLength = source.readUInt32LE(12)
const gltf = JSON.parse(source.subarray(20, 20 + jsonLength))
const sourceBinary = source.subarray(28 + jsonLength, 28 + jsonLength + gltf.buffers[0].byteLength)
const owner = JSON.parse(readFileSync('assets/common/penguin.body.asset.json')).document.nodes.penguin
const names = ['emote.cheer', 'emote.laugh']
assert.deepEqual(gltf.animations.map(a => a.name), names)
const limitArg = process.argv.find(a => a.startsWith('--frames='))
const limit = limitArg ? Number(limitArg.slice(9)) : Infinity
assert([1, 2, Infinity].includes(limit), 'Probe one frame, then two, before the full sequence')
const output = limit === Infinity ? 'proofs/m19/penguin-cheer-laugh-sequence.glb'
  : `/tmp/penguin-cheer-laugh-sequence-${limit}.glb`
const definitions = names.map(name => owner.clips.find(c => c.name === name))
assert(definitions.every(c => c && !c.loop && c.rootMotion === 'none'))
const { bindings, smooth, ...preset } = owner.rig
const api = await loadRaaAnim(), rig = api.loadRig(JSON.stringify(preset))
const clips = []
const binary = [sourceBinary]
let bytes = sourceBinary.length
function floats(values, type) {
  const padding = (4 - bytes % 4) % 4
  if (padding) { binary.push(Buffer.alloc(padding)); bytes += padding }
  const data = Buffer.alloc(values.length * 4)
  values.forEach((v, i) => { assert(Number.isFinite(v)); data.writeFloatLE(v, i * 4) })
  const bufferView = gltf.bufferViews.push({ buffer: 0, byteOffset: bytes, byteLength: data.length }) - 1
  binary.push(data); bytes += data.length
  const width = { SCALAR: 1, VEC3: 3, VEC4: 4 }[type]
  return gltf.accessors.push({ bufferView, componentType: 5126, count: values.length / width, type,
    ...(type === 'SCALAR' ? { min: [values[0]], max: [values.at(-1)] } : {}) }) - 1
}
const readFloats = (doc, bin, id) => {
  const a = doc.accessors[id], v = doc.bufferViews[a.bufferView]
  const width = { SCALAR: 1, VEC3: 3, VEC4: 4 }[a.type]
  return Array.from({ length: a.count * width }, (_, i) => bin.readFloatLE((v.byteOffset ?? 0) + (a.byteOffset ?? 0) + i * 4))
}
try {
  clips.push(...definitions.map(c => api.loadClip(rig, JSON.stringify(c))))
  // Share the neutral boundary pose: cheer ends exactly where laugh starts.
  assert.deepEqual(api.sampleClip(clips[0], definitions[0].lengthTicks).local,
    api.sampleClip(clips[1], 0).local)
  const samples = definitions.flatMap((c, index) => Array.from({ length: c.lengthTicks + (index === 0 ? 1 : 0) },
    (_, i) => ({ clip: index, tick: i + (index === 0 ? 0 : 1) }))).slice(0, limit)
  const animation = { name: 'cheer-then-laugh', samplers: [], channels: [], extras: {
    ...gltf.animations[0].extras, clips: names, sampleHz: 60,
    segments: definitions.map((c, i) => ({ name: c.name,
      startSeconds: i === 0 ? 0 : definitions[0].lengthTicks / 60,
      durationSeconds: c.lengthTicks / 60 })),
  } }
  const input = floats(samples.map((_, tick) => tick / 60), 'SCALAR')
  const channels = gltf.animations[0].channels
  assert.deepEqual(channels.map(c => c.target), gltf.animations[1].channels.map(c => c.target))
  for (const channel of channels) {
    const { node, path } = channel.target
    const bone = gltf.skins[0].joints.indexOf(node)
    assert.equal(gltf.nodes[node].name, preset.bones[bone].name)
    const [offset, width] = { translation: [0, 3], rotation: [3, 4], scale: [7, 3] }[path]
    const values = samples.flatMap(s => Array.from(api.sampleClip(clips[s.clip], s.tick).local
      .slice(bone * 10 + offset, bone * 10 + offset + width)))
    const output = floats(values, width === 4 ? 'VEC4' : 'VEC3')
    const sampler = animation.samplers.push({ input, output, interpolation: 'LINEAR' }) - 1
    animation.channels.push({ sampler, target: { node, path } })
  }
  gltf.animations = [animation]
  gltf.scenes[0].name = 'Penguin cheer then laugh review sequence'
  gltf.buffers[0].byteLength = bytes
  const json = Buffer.from(JSON.stringify(gltf)), jsonPadding = (4 - json.length % 4) % 4
  const bin = Buffer.concat(binary), binPadding = (4 - bin.length % 4) % 4
  const header = Buffer.alloc(20), binHeader = Buffer.alloc(8)
  header.writeUInt32LE(0x46546c67); header.writeUInt32LE(2, 4)
  header.writeUInt32LE(28 + json.length + jsonPadding + bin.length + binPadding, 8)
  header.writeUInt32LE(json.length + jsonPadding, 12); header.writeUInt32LE(0x4e4f534a, 16)
  binHeader.writeUInt32LE(bin.length + binPadding); binHeader.writeUInt32LE(0x004e4942, 4)
  writeFileSync(output, Buffer.concat([header, json, Buffer.alloc(jsonPadding, 32), binHeader, bin, Buffer.alloc(binPadding)]))
  // Verify the saved binary against the S17 runtime, including the gesture boundary.
  const saved = readFileSync(output), savedJsonLength = saved.readUInt32LE(12)
  assert.equal(saved.readUInt32LE(8), saved.length)
  const doc = JSON.parse(saved.subarray(20, 20 + savedJsonLength)), savedBin = saved.subarray(28 + savedJsonLength)
  assert.deepEqual(doc.meshes, gltf.meshes); assert.deepEqual(doc.skins, gltf.skins)
  assert.deepEqual(doc.nodes, gltf.nodes)
  assert.deepEqual(savedBin.subarray(0, sourceBinary.length), sourceBinary)
  const times = readFloats(doc, savedBin, input)
  let checkedValues = 0
  for (const channel of doc.animations[0].channels) {
    const sampler = doc.animations[0].samplers[channel.sampler]
    const values = readFloats(doc, savedBin, sampler.output)
    const bone = doc.skins[0].joints.indexOf(channel.target.node)
    const [offset, width] = { translation: [0, 3], rotation: [3, 4], scale: [7, 3] }[channel.target.path]
    samples.forEach((s, tick) => {
      assert(Math.abs(times[tick] - tick / 60) < 1e-6)
      const local = api.sampleClip(clips[s.clip], s.tick).local
      for (let k = 0; k < width; k++) {
        assert.equal(values[tick * width + k], local[bone * 10 + offset + k]); checkedValues++
      }
    })
  }
  console.log(JSON.stringify({ file: output, frames: samples.length, seconds: (samples.length - 1) / 60,
    animations: doc.animations.map(a => a.name), checkedValues, bytes: saved.length,
    preservedMeshAndSkin: true, renderedReview: false }))
} finally { clips.forEach(c => c.free()); rig.free() }
