// Offline feasibility study; clip-only data does not include procedural layers, blends or IK.
import { readFileSync } from 'node:fs'
import { loadAnimBrick } from '../packages/game/src/anim/brick.ts'
import { decodeMesh } from '../apps/web/src/sdf/meshWire.ts'
const node = JSON.parse(readFileSync('assets/common/penguin.body.asset.json', 'utf8')).document.nodes.penguin
const { bindings, smooth, ...preset } = node.rig
const api = await loadAnimBrick(), rig = api.loadRig(JSON.stringify(preset))
const mesh = decodeMesh(readFileSync('assets/common/penguin.body.mesh'))
const data = mesh.data as {
  groups: {
    parts: {
      meshes: {
        positions: Float32Array
        normals: Float32Array
      }[]
      skin: {
        joints: Uint16Array
        weights: Float32Array
      }
    }[]
  }[]
}
const part = data.groups[0].parts[0]
const concatenate = (key: 'positions' | 'normals') => Float32Array.from(part.meshes.flatMap(m => Array.from(m[key])))
const geometry = { positions: concatenate('positions'), normals: concatenate('normals') }
const { joints, weights } = part.skin!
const frames: ReturnType<typeof api.sampleClip>[] = []
const t = performance.now()
for (const json of node.clips) {
  const clip = api.loadClip(rig, JSON.stringify(json))
  try {
    for (let tick = 0; tick < json.lengthTicks; tick++)
      frames.push(api.sampleClip(clip, tick))
  }
  finally {
    clip.free()
  }
}
const paletteBakeMs = performance.now() - t
const start = performance.now()
const deformed = frames.map(frame => {
  const p = new Float32Array(geometry.positions.length), n = new Float32Array(geometry.normals.length)
  for (let v = 0; v < p.length / 3; v++)
    for (let k = 0; k < 4; k++) {
      const bone = joints[v * 4 + k] * 16, w = weights[v * 4 + k]
      if (!w)
        continue
      for (let row = 0; row < 3; row++) {
        const m = frame.skin, o = v * 3
        p[o + row] += w * (m[bone + row] * geometry.positions[o] + m[bone + 4 + row] * geometry.positions[o + 1] + m[bone + 8 + row] * geometry.positions[o + 2] + m[bone + 12 + row])
        n[o + row] += w * (m[bone + row] * geometry.normals[o] + m[bone + 4 + row] * geometry.normals[o + 1] + m[bone + 8 + row] * geometry.normals[o + 2])
      }
    }
  return { p, n }
})
const vertexBakeMs = performance.now() - start
console.log(JSON.stringify({ frames: frames.length, bones: preset.bones.length, vertices: geometry.positions.length / 3, paletteBakeMs, vertexBakeMs,
  skinBytes: frames.reduce((s, f) => s + f.skin.byteLength, 0), attachmentModelBytes: frames.reduce((s, f) => s + f.model.byteLength, 0),
  vertexPositionNormalBytes: deformed.reduce((s, f) => s + f.p.byteLength + f.n.byteLength, 0), note: '60 Hz lower-bound payloads; GPU upload/mesh-creation cost not measured; runtime graph blends/procedural/IK are absent' }))
rig.free()
