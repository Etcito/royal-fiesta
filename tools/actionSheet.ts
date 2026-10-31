// CPU orthographic action sheet; uses the walk sheet ellipsoid rasterizer. Matrices are row-major affine transforms of unit spheres.
import { mkdir, readFile, stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import sharp from 'sharp'
import { walkBones, applyWalkPose, restPose } from '../packages/game/src/anim/walkCycle.ts'
import { actionPose } from '../packages/game/src/anim/actionPoses.ts'
import { CHAR, CharMode, CarryKind } from '@royal-fiesta/sim/character/constants'

type Matrix = number[]
type Bone = { name: string; parent: string | null; rest: { t: number[]; r: number[]; s: number[] } }
type Binding = { source: { group?: string; shape?: string }; bones: { bone: string; factor: number }[] }
type Node = {
  kind: string; children?: string[]; visible?: boolean; color?: string
  params?: { radii?: number[]; radius?: number; height?: number; radiusBottom?: number }
  transform?: { position?: number[]; rotation?: number[]; scale?: number[] }
  modifiers?: { kind: string; params: { axis: string } }[]
}
type Part = { matrix: Matrix; binding: Binding['bones']; color: number[] }
const identity = (): Matrix => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
function mul(a: Matrix, b: Matrix): Matrix {
  return Array.from({ length: 16 }, (_, i) => {
    const r = i >> 2, c = i % 4
    return a[r * 4] * b[c] + a[r * 4 + 1] * b[c + 4] + a[r * 4 + 2] * b[c + 8] + a[r * 4 + 3] * b[c + 12]
  })
}
function trs(t: number[], q: number[], s: number[]): Matrix {
  const [x, y, z, w] = q
  return [(1 - 2 * (y*y + z*z))*s[0], 2*(x*y-z*w)*s[1], 2*(x*z+y*w)*s[2], t[0],
    2*(x*y+z*w)*s[0], (1-2*(x*x+z*z))*s[1], 2*(y*z-x*w)*s[2], t[1],
    2*(x*z-y*w)*s[0], 2*(y*z+x*w)*s[1], (1-2*(x*x+y*y))*s[2], t[2], 0, 0, 0, 1]
}
function inverse(m: Matrix): Matrix {
  const [a,b,c,d,e,f,g,h,i,j,k,l] = m
  const det = a*(f*k-g*j)-b*(e*k-g*i)+c*(e*j-f*i)
  const n = [(f*k-g*j)/det, (c*j-b*k)/det, (b*g-c*f)/det, 0,
    (g*i-e*k)/det, (a*k-c*i)/det, (c*e-a*g)/det, 0,
    (e*j-f*i)/det, (b*i-a*j)/det, (a*f-b*e)/det, 0, 0, 0, 0, 1]
  for (const r of [0, 4, 8]) n[r+3] = -n[r]*d-n[r+1]*h-n[r+2]*l
  return n
}
function transform(node: Node): Matrix {
  const t = node.transform, r = (t?.rotation ?? [0,0,0]).map(v => v*Math.PI/360)
  const [x,y,z] = r.map(Math.sin), [a,b,c] = r.map(Math.cos)
  return trs(t?.position ?? [0,0,0], [x*b*c+a*y*z, a*y*c-x*b*z, a*b*z+x*y*c, a*b*c-x*y*z], t?.scale ?? [1,1,1])
}
function forward(bones: Bone[], local: Float32Array): Matrix[] {
  const world: Matrix[] = [], names = bones.map(b => b.name)
  const visit = (i: number): Matrix => {
    if (world[i]) return world[i]
    const o = i*10, m = trs([...local.slice(o,o+3)], [...local.slice(o+3,o+7)], [...local.slice(o+7,o+10)])
    const parent = bones[i].parent
    return world[i] = parent === null ? m : mul(visit(names.indexOf(parent)), m)
  }
  bones.forEach((_, i) => visit(i))
  return world
}
function partsFrom(nodes: Record<string, Node>, bindings: Binding[]): Part[] {
  const parts: Part[] = []
  const visit = (id: string, parent: Matrix, inherited: Binding['bones']): void => {
    const node = nodes[id]
    if (node.visible === false) return
    const binding = bindings.find(b => b.source.shape === id || b.source.group === id)?.bones ?? inherited
    const m = mul(parent, transform(node)), p = node.params
    if (p) {
      const r = p.radii ?? (node.kind === 'capsule' ? [p.radius!, p.height!/2+p.radius!, p.radius!] :
        node.kind === 'cone' ? [p.radiusBottom!, p.height!/2, p.radiusBottom!] : [p.radius!, p.radius!, p.radius!])
      const hex = id.includes('left') ? '#568ca5' : id.includes('right') ? '#386c86' :
        node.color === '#6b727e' ? '#303a49' : node.color === '#efe6da' ? '#f7f6f2' : node.color ?? '#303a49'
      parts.push({ matrix: mul(m, trs([0,0,0], [0,0,0,1], r)), binding,
        color: [1,3,5].map(i => parseInt(hex.slice(i,i+2),16)) })
    }
    for (const child of node.children ?? []) visit(child, m, binding)
    // The asset's leg is authored once and mirrored by its group modifier.
    if (node.modifiers?.some(v => v.kind === 'mirror' && v.params.axis === 'x')) {
      const first = parts.length
      for (const child of node.children ?? []) visit(child, m, binding)
      for (const part of parts.slice(first)) {
        part.matrix = mul(trs([0,0,0], [0,0,0,1], [-1,1,1]), part.matrix)
        part.binding = part.binding.map(b => ({ ...b, bone: b.bone.replace('.l', '.r') }))
      }
    }
  }
  visit('penguin', identity(), [{ bone: 'root', factor: 1 }])
  return parts
}

const WIDTH = 1500, HEIGHT = 600, SCALE = 82, BACKGROUND = [237,239,242,255]
// Tiny CPU bitmap labels, keeping the entire sheet independent of fonts and SVG renderers.
const FONT: Record<string, string> = {
  B:'110101110101110', C:'111100100100111', G:'111100101101111', M:'101111111101101', V:'101101101101010', Y:'101101010010010', '7':'111001010010010', '=':'000111000111000', A:'010101111101101', D:'110101101101110', E:'111100110100111', F:'111100110100100', H:'101101111101101',
  I:'111010010010111', K:'101101110101101', L:'100100100100111', N:'101111111111101',
  O:'111101101101111', P:'110101110100100', R:'110101110101101', S:'111100111001111',
  T:'111010010010010', U:'101101101101111', W:'101101111111101', X:'101101010101101',
  Z:'111001010100111', '0':'111101101101111', '2':'111001111100111', '3':'111001111001111',
  '5':'111100111001111', '8':'111101111101111', '.':'000000000000010', '/':'001001010100100',
}
function label(pixels: Buffer, text: string, x: number, y: number, size = 3): void {
  for (const char of text) {
    const glyph = FONT[char] ?? '000000000000000'
    for (let i=0; i<15; i++) if (glyph[i] === '1') for (let dy=0; dy<size; dy++) for (let dx=0; dx<size; dx++) {
      pixels.set([65,75,88,255], ((y+Math.floor(i/3)*size+dy)*WIDTH+x+(i%3)*size+dx)*4)
    }
    x += size*4
  }
}
function raster(pixels: Buffer, depth: Float64Array, m: Matrix, color: number[], col: number, row: number): void {
  const h = 2, d = 0, cx = col*375+160, cy = row*300+165
  const extent = (axis: number) => Math.hypot(m[axis*4], m[axis*4+1], m[axis*4+2])
  const left = Math.max(col*375+8, Math.floor(cx+(m[h*4+3]-extent(h))*SCALE))
  const right = Math.min(col*375+366, Math.ceil(cx+(m[h*4+3]+extent(h))*SCALE))
  const top = Math.max(row*300+45, Math.floor(cy-(m[7]+extent(1))*SCALE))
  const bottom = Math.min(row*300+270, Math.ceil(cy-(m[7]-extent(1))*SCALE)), inv = inverse(m)
  const v = [inv[d],inv[4+d],inv[8+d]], a = v.reduce((s,n) => s+n*n,0)
  for (let y=top; y<=bottom; y++) for (let x=left; x<=right; x++) {
    const u = [0,0,0]; u[h] = (x+0.5-cx)/SCALE; u[1] = (cy-y-0.5)/SCALE
    const p = [0,4,8].map(r => inv[r]*u[0]+inv[r+1]*u[1]+inv[r+2]*u[2]+inv[r+3])
    const b = p.reduce((s,n,i) => s+n*v[i],0), c = p.reduce((s,n) => s+n*n, -1), disc = b*b-a*c
    if (disc < 0) continue
    const z = (-b+Math.sqrt(disc))/a, index = y*WIDTH+x
    if (z > depth[index]) { depth[index] = z; pixels.set([...color,255],index*4) }
  }
}

export async function actionSheet(outPng: string): Promise<{ width: 1500; height: 600 }> {
  const asset = JSON.parse(await readFile(new URL('../assets/common/penguin.body.asset.json', import.meta.url), 'utf8'))
  const nodes = asset.document.nodes as Record<string, Node>
  const rig = asset.document.nodes.penguin.rig as { bones: Bone[]; bindings: Binding[]; attach: Record<string, { bone: string; t: number[]; r: number[] }> }
  const names = rig.bones.map(b => b.name), bones = walkBones(names)
  const rest = new Float32Array(rig.bones.flatMap(b => [...b.rest.t,...b.rest.r,...b.rest.s]))
  const restWorld = forward(rig.bones, rest), parts = partsFrom(nodes, rig.bindings)
  // The neck attachment has no authored shape; bridge it as in the walk sheet.
  const neck = rig.attach.neck, headRadius = nodes.head.params!.radius!
  parts.push({ matrix: mul(restWorld[names.indexOf(neck.bone)], trs(neck.t, neck.r, [headRadius*0.75,headRadius,headRadius*0.75])),
    binding: [{ bone: neck.bone, factor: 1 }], color: [48,58,73] })
  const pixels = Buffer.alloc(WIDTH*HEIGHT*4), depth = new Float64Array(WIDTH*HEIGHT).fill(-Infinity)
  for (let i=0; i<WIDTH*HEIGHT; i++) pixels.set(BACKGROUND,i*4)
  const panels = [
    { label: 'SLIDE', mode: CharMode.slide, carry: 0, timer: 0 },
    ...[0.25,0.5,0.75].map(u => ({ label: `STROKE U=${u}`, mode: CharMode.slide,
      carry: 0, timer: (1-u)*CHAR.slide.strokeCooldownTicks })),
    { label: 'SWIM', mode: CharMode.swim, carry: 0, timer: CHAR.swim.strokeCooldownTicks / 2 },
    { label: 'GRAB', mode: CharMode.grabbing, carry: 0, timer: 0 },
    { label: 'CARRY', mode: CharMode.ground, carry: CarryKind.object, timer: 0 },
  ]
  for (const [index,panel] of panels.entries()) {
    const col = index % 4, row = Math.floor(index / 4), local = rest.slice()
    applyWalkPose(local,bones,restPose())
    const rotations = new Float32Array(names.length * 4)
    actionPose(panel.mode,panel.carry,panel.timer,rotations,bones)
    // At weight 1 ACTION_LAYER replaces the affected local rotations.
    for (const bone of Object.values(bones)) local.set(rotations.subarray(bone*4,bone*4+4),bone*10+3)
    const world = forward(rig.bones,local), skin = world.map((m,i) => mul(m,inverse(restWorld[i])))
    label(pixels,panel.label,col*375+16,row*300+16)
    label(pixels,'SIDE / X',col*375+140,row*300+280,2)
    for (const part of parts) {
      const blend = Array<number>(16).fill(0)
      for (const b of part.binding) skin[names.indexOf(b.bone)].forEach((v,i) => { blend[i] += v*b.factor })
      const m = mul(blend,part.matrix)
      raster(pixels,depth,m,part.color,col,row)
    }
  }
  await mkdir(dirname(outPng),{ recursive:true })
  await sharp(pixels,{ raw:{ width:WIDTH,height:HEIGHT,channels:4 } }).png().toFile(outPng)
  return { width:WIDTH,height:HEIGHT }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const out = process.argv[2] ?? 'out/s3/m4/action-poses.png'
  await actionSheet(out)
  console.log(`${out} — 1500x600, ${(await stat(out)).size} bytes`)
}
