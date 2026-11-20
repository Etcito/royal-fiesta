import type { EgeScene, ViewBuffer } from '@etcito/game-engine'
import { RenderBridge } from '@etcito/game-engine/render'
import type { Engine } from '@etcito/raa'

type TileRenderer = Pick<Engine, 'addMesh' | 'removeMesh' | 'primitiveMesh' | 'addMaterial' |
  'addNode' | 'removeNode' | 'addInstance' | 'setVisible' | 'setTransforms'>

// Authored unit tile, point-to-point along X. The top rolls down into a narrow
// darker rim so adjoining coplanar faces and the edges of a hole remain legible.
const hexTileMesh = {
  positions: new Float32Array([
    .94,1,0, .47,1,.94, -.47,1,.94, -.94,1,0, -.47,1,-.94, .47,1,-.94,
    1,.45,0, .5,.45,1, -.5,.45,1, -1,.45,0, -.5,.45,-1, .5,.45,-1,
    1,-1,0, .5,-1,1, -.5,-1,1, -1,-1,0, -.5,-1,-1, .5,-1,-1,
    1,-1,0, .5,-1,1, -.5,-1,1, -1,-1,0, -.5,-1,-1, .5,-1,-1,
  ]),
  normals: new Float32Array([
    0,1,0, 0,1,0, 0,1,0, 0,1,0, 0,1,0, 0,1,0,
    1,0,0, .5,0,.866, -.5,0,.866, -1,0,0, -.5,0,-.866, .5,0,-.866,
    1,0,0, .5,0,.866, -.5,0,.866, -1,0,0, -.5,0,-.866, .5,0,-.866,
    0,-1,0, 0,-1,0, 0,-1,0, 0,-1,0, 0,-1,0, 0,-1,0,
  ]),
  colors: new Uint8Array([
    ...Array(6).fill([255, 255, 255, 255]),
    ...Array(18).fill([158, 147, 142, 255]),
  ].flat()),
  indices: new Uint32Array([
    0,2,1, 0,3,2, 0,4,3, 0,5,4,
    6,0,1, 6,1,7, 7,1,2, 7,2,8, 8,2,3, 8,3,9,
    9,3,4, 9,4,10, 10,4,5, 10,5,11, 11,5,0, 11,0,6,
    12,6,7, 12,7,13, 13,7,8, 13,8,14, 14,8,9, 14,9,15,
    15,9,10, 15,10,16, 16,10,11, 16,11,17, 17,11,6, 17,6,12,
    18,19,20, 18,20,21, 18,21,22, 18,22,23,
  ]),
}

const deckColors: [number, number, number][] = [
  [242 / 255, 230 / 255, 208 / 255],
  [112 / 255, 207 / 255, 206 / 255],
  [183 / 255, 138 / 255, 201 / 255],
  [1, 209 / 255, 64 / 255],
]

// Each deck has fixed tile dimensions. Its bridge still owns the per-entity
// poses, material changes and visibility just as it does for ordinary shapes.
function deckBridge(raa: TileRenderer, mesh: number, flatRadius: number, layer: number) {
  const sizes: [number, number, number][] = []
  return new RenderBridge({
    primitiveMesh(_kind, params) {
      return sizes.push([Number(params.radius), Number(params.halfHeight), flatRadius]) - 1
    },
    addMaterial(desc) {
      // A little of the candy colour remains visible on decks in deep shadow.
      const isBase = desc.color.every((value, i) => value === deckColors[0][i])
      const [r, g, b] = isBase ? deckColors[layer] : desc.color
      return raa.addMaterial({ ...desc, color: [r, g, b], emissive: [r * .08, g * .08, b * .08] })
    },
    addNode: (...args) => raa.addNode(...args),
    addInstance(node, size, material) {
      const scaled = raa.addNode(node, undefined, undefined, sizes[size])
      return raa.addInstance(scaled, mesh, material)
    },
    removeNode: node => raa.removeNode(node),
    setVisible: (...args) => raa.setVisible(...args),
    setTransforms: (...args) => raa.setTransforms(...args),
  })
}

export function roundRenderBridge(raa: TileRenderer, scene: EgeScene): Pick<RenderBridge, 'dispose' | 'sync' | 'instances'> {
  const ordinary = new RenderBridge(raa)
  const fields = scene.entities.filter(entity => entity.components?.feature_hex_field)
  if (!fields.length) return ordinary

  const mesh = raa.addMesh(hexTileMesh)
  const bridges = [ordinary]
  const byOwner = new Map<number, { first: number; cellsPerLayer: number }>()
  for (const entity of fields) {
    const { feature, feature_hex_field: field } = entity.components!
    const rings = Number(field.rings)
    byOwner.set(Number(feature.index), { first: bridges.length, cellsPerLayer: 3 * rings * (rings + 1) + 1 })
    for (let layer = 0; layer < Number(field.layers); layer++) {
      bridges.push(deckBridge(raa, mesh, Number(field.flat_m) / 2, layer))
    }
  }
  const groups = scene.entities.map(entity => {
    const cell = entity.components?.feature_hex_field_hex
    if (!cell) return 0
    const field = byOwner.get(Number(cell.owner))!
    return field.first + Math.floor(Number(cell.index) / field.cellsPerLayer)
  })

  // Route copied view records by entity, so a clock disc or another hazard
  // with identical dimensions still uses the ordinary engine primitive.
  const buffers = bridges.map((): ViewBuffer => ({ count: 0, stride: 0, bytes: new Uint8Array(0) }))
  let disposed = false
  return {
    get instances() { return bridges.reduce((sum, bridge) => sum + bridge.instances, 0) },
    sync(view) {
      const source = new DataView(view.bytes.buffer, view.bytes.byteOffset, view.bytes.byteLength)
      for (const buffer of buffers) {
        buffer.count = 0
        buffer.stride = view.stride
        if (buffer.bytes.length < view.bytes.length) buffer.bytes = new Uint8Array(view.bytes.length)
      }
      for (let i = 0; i < view.count; i++) {
        const start = 8 + i * view.stride
        const group = groups[source.getUint32(start, true)] ?? 0
        const buffer = buffers[group]
        const dest = 8 + buffer.count * view.stride
        buffer.bytes.set(view.bytes.subarray(start, start + view.stride), dest)
        buffer.count++
      }
      for (const [i, buffer] of buffers.entries()) {
        const header = new DataView(buffer.bytes.buffer)
        header.setUint32(0, buffer.count, true)
        header.setUint32(4, buffer.stride, true)
        bridges[i].sync(buffer)
      }
    },
    dispose() {
      if (disposed) return
      disposed = true
      for (const bridge of bridges) bridge.dispose()
      raa.removeMesh(mesh)
    },
  }
}
