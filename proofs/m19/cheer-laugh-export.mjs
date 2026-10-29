// Export existing MCP-authored clips as playable glTF animations; never author S17 data here.
// Usage: node proofs/m19/cheer-laugh-export.mjs [--clip=emote.cheer|emote.laugh] [--frames=1|2]
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { loadRaaAnim } from '@etcito/raa-anim'

const sourceAsset = 'assets/common/penguin.body.asset.json'
const asset = JSON.parse(readFileSync(sourceAsset)), owner = asset.document.nodes.penguin
const provenance = { sourceAsset, assetHash: asset.hash,
  assetRevision: execFileSync('git', ['log', '-1', '--format=%H', '--', sourceAsset], { encoding: 'utf8' }).trim() }
const source = readFileSync('proofs/m19/penguin-fall-dive.glb')
const jsonLength = source.readUInt32LE(12)
const gltf = JSON.parse(source.subarray(20, 20 + jsonLength))
// Retain only the mesh and skin data from the inherited export. Its fall/dive
// animation accessors and binary payload do not belong in these emote files.
const sourceBinary = source.subarray(28 + jsonLength)
const sourceAccessors = gltf.accessors, sourceViews = gltf.bufferViews
const accessorMap = new Map(), viewMap = new Map(), binary = []
let bytes = 0
gltf.accessors = []; gltf.bufferViews = []
function retainAccessor(id) {
  if (accessorMap.has(id)) return accessorMap.get(id)
  const a = structuredClone(sourceAccessors[id])
  assert(!a.sparse, 'Sparse source accessor requires explicit support')
  if (!viewMap.has(a.bufferView)) {
    const v = sourceViews[a.bufferView]
    assert.equal(v.buffer, 0)
    const padding = (4 - bytes % 4) % 4
    if (padding) { binary.push(Buffer.alloc(padding)); bytes += padding }
    viewMap.set(a.bufferView, gltf.bufferViews.length)
    const data = sourceBinary.subarray(v.byteOffset ?? 0, (v.byteOffset ?? 0) + v.byteLength)
    assert.equal(data.length, v.byteLength)
    gltf.bufferViews.push({ ...v, byteOffset: bytes })
    binary.push(data); bytes += data.length
  }
  a.bufferView = viewMap.get(a.bufferView)
  const next = gltf.accessors.push(a) - 1
  accessorMap.set(id, next)
  return next
}
for (const mesh of gltf.meshes) for (const p of mesh.primitives) {
  for (const name of Object.keys(p.attributes)) p.attributes[name] = retainAccessor(p.attributes[name])
  if (p.indices !== undefined) p.indices = retainAccessor(p.indices)
  assert(!p.targets, 'Morph source requires explicit support')
}
for (const skin of gltf.skins) if (skin.inverseBindMatrices !== undefined) {
  skin.inverseBindMatrices = retainAccessor(skin.inverseBindMatrices)
}
const limit = Number(process.argv.find(a => a.startsWith('--frames='))?.slice(9)) || Infinity
assert([1, 2, Infinity].includes(limit), 'Probe with one frame, then two, before the full animation')
const selected = process.argv.find(a => a.startsWith('--clip='))?.slice(7)
assert(!selected || ['emote.cheer', 'emote.laugh'].includes(selected), 'Select an authored cheer or laugh clip')
const stem = selected ? `penguin-${selected}` : 'penguin-cheer-laugh'
const output = limit === Infinity ? `proofs/m19/${stem}.glb` : `/tmp/${stem}-${limit}.glb`
const names = selected ? [selected] : ['emote.cheer', 'emote.laugh']
const { bindings, smooth, ...preset } = owner.rig
const api = await loadRaaAnim(), rig = api.loadRig(JSON.stringify(preset))
const joints = gltf.skins[0].joints
assert.deepEqual(joints.map(j => gltf.nodes[j].name), preset.bones.map(b => b.name))
for (const [i, bone] of preset.bones.entries()) {
  const node = gltf.nodes[joints[i]]
  assert.deepEqual(node.translation ?? [0, 0, 0], bone.rest.t)
  assert.deepEqual(node.rotation ?? [0, 0, 0, 1], bone.rest.r)
  assert.deepEqual(node.scale ?? [1, 1, 1], bone.rest.s)
  if (bone.parent !== null) {
    const parent = joints[preset.bones.findIndex(b => b.name === bone.parent)]
    assert(gltf.nodes[parent].children.includes(joints[i]), `${bone.name} parent preserved`)
  }
}
function accessor(values, type, min, max) {
  const padding = (4 - bytes % 4) % 4
  if (padding) { binary.push(Buffer.alloc(padding)); bytes += padding }
  const array = new Float32Array(values)
  const buffer = Buffer.alloc(array.byteLength)
  array.forEach((v, i) => buffer.writeFloatLE(v, i * 4))
  const view = gltf.bufferViews.push({ buffer: 0, byteOffset: bytes, byteLength: buffer.length }) - 1
  binary.push(buffer); bytes += buffer.length
  return gltf.accessors.push({ bufferView: view, componentType: 5126,
    count: values.length / (type === 'SCALAR' ? 1 : type === 'VEC3' ? 3 : 4), type,
    ...(min ? { min, max } : {}) }) - 1
}
gltf.animations = []
const report = { file: output, ...provenance, tickRate: 60, renderedReview: false, animations: [] }
try {
  for (const name of names) {
    const definition = owner.clips.find(c => c.name === name)
    assert(definition, `Missing ${name}`)
    const clip = api.loadClip(rig, JSON.stringify(definition))
    try {
      const count = Math.min(definition.lengthTicks + 1, limit)
      const poses = Array.from({ length: count }, (_, tick) => api.sampleClip(clip, tick).local)
      const times = poses.map((_, tick) => tick / 60)
      const input = accessor(times, 'SCALAR', [0], [times.at(-1)])
      const animation = { name, samplers: [], channels: [], extras: {
        source: sourceAsset, ...provenance, authoredBy: 'SDF Modeler registered animation operations',
        sampleHz: 60, loop: definition.loop, rootMotion: definition.rootMotion,
        beak: 'Rigidly bound to head; no independent jaw articulation (Q7)' } }
      for (const track of definition.tracks) {
        const bone = preset.bones.findIndex(b => b.name === track.bone)
        assert(bone >= 0)
        const [offset, width, path] = { translation: [0, 3, 'translation'], rotation: [3, 4, 'rotation'], scale: [7, 3, 'scale'] }[track.channel]
        const values = poses.flatMap(p => Array.from(p.slice(bone * 10 + offset, bone * 10 + offset + width)))
        assert(values.every(Number.isFinite))
        const output = accessor(values, width === 4 ? 'VEC4' : 'VEC3')
        const sampler = animation.samplers.push({ input, output, interpolation: 'LINEAR' }) - 1
        animation.channels.push({ sampler, target: { node: joints[bone], path } })
      }
      gltf.animations.push(animation)
      report.animations.push({ name, frames: count, seconds: times.at(-1), channels: animation.channels.length })
    } finally { clip.free() }
  }
} finally { rig.free() }
gltf.asset.generator = 'royal-fiesta S17 runtime sample export'
gltf.scenes[0].name = selected ? `Penguin ${selected}` : 'Penguin cheer and laugh'
gltf.scenes[0].extras = { source: 'assets/common/penguin.body.asset.json', sampleHz: 60, clips: names }
gltf.buffers[0].byteLength = bytes
const json = Buffer.from(JSON.stringify(gltf)), jsonPadding = (4 - json.length % 4) % 4
const bin = Buffer.concat(binary), binPadding = (4 - bin.length % 4) % 4
const jsonHeader = Buffer.alloc(8), binHeader = Buffer.alloc(8), header = Buffer.alloc(12)
jsonHeader.writeUInt32LE(json.length + jsonPadding); jsonHeader.writeUInt32LE(0x4e4f534a, 4)
binHeader.writeUInt32LE(bin.length + binPadding); binHeader.writeUInt32LE(0x004e4942, 4)
header.writeUInt32LE(0x46546c67); header.writeUInt32LE(2, 4)
header.writeUInt32LE(28 + json.length + jsonPadding + bin.length + binPadding, 8)
writeFileSync(output, Buffer.concat([header, jsonHeader, json, Buffer.alloc(jsonPadding, 32), binHeader, bin, Buffer.alloc(binPadding)]))
// Round-trip the actual exported file and check every channel sample against the runtime values.
const saved = readFileSync(output), length = saved.readUInt32LE(12)
assert.equal(saved.length, saved.readUInt32LE(8))
const savedGltf = JSON.parse(saved.subarray(20, 20 + length)), start = 28 + length
assert.deepEqual(savedGltf.animations.map(a => a.name), names)
for (const [oldId, newId] of accessorMap) {
  const before = sourceAccessors[oldId], after = savedGltf.accessors[newId]
  assert.deepEqual(after, { ...before, bufferView: viewMap.get(before.bufferView) })
}
for (const [oldId, newId] of viewMap) {
  const before = sourceViews[oldId], after = savedGltf.bufferViews[newId]
  assert.deepEqual(after, { ...before, byteOffset: after.byteOffset })
  assert.deepEqual(saved.subarray(start + after.byteOffset, start + after.byteOffset + after.byteLength),
    sourceBinary.subarray(before.byteOffset ?? 0, (before.byteOffset ?? 0) + before.byteLength),
    'Inherited mesh, weights and inverse binds preserved')
}
const values = id => {
  const a = savedGltf.accessors[id], b = savedGltf.bufferViews[a.bufferView]
  return Array.from({ length: a.count * ({ SCALAR: 1, VEC3: 3, VEC4: 4 }[a.type]) },
    (_, i) => saved.readFloatLE(start + b.byteOffset + (a.byteOffset ?? 0) + i * 4))
}
const checkRig = api.loadRig(JSON.stringify(preset))
try {
  for (const animation of savedGltf.animations) {
    const clip = api.loadClip(checkRig, JSON.stringify(owner.clips.find(c => c.name === animation.name)))
    try {
      for (const channel of animation.channels) {
        const sampler = animation.samplers[channel.sampler], time = values(sampler.input), out = values(sampler.output)
        const bone = joints.indexOf(channel.target.node)
        const [offset, width] = { translation: [0, 3], rotation: [3, 4], scale: [7, 3] }[channel.target.path]
        for (let tick = 0; tick < time.length; tick++) {
          assert(Math.abs(time[tick] - tick / 60) < 1e-6)
          const local = api.sampleClip(clip, tick).local
          for (let k = 0; k < width; k++) assert.equal(out[tick * width + k], local[bone * 10 + offset + k])
        }
      }
    } finally { clip.free() }
  }
} finally { checkRig.free() }
const result = JSON.stringify({ ...report, bytes: saved.length, verifiedEveryChannelSample: true,
  verifiedMeshAndSkinData: true, retainedMeshAndSkinAccessors: accessorMap.size }, null, 2) + '\n'
if (limit === Infinity) writeFileSync(selected ? `proofs/m19/${stem}-media.json` : 'proofs/m19/cheer-laugh-media.json', result)
console.log(result.trimEnd())
