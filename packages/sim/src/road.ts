import { dsin, dcos } from './detmath.ts'
const norm = (...v: number[]): number => Math.sqrt(v.reduce((sum,x) => sum+x*x,0))
// Authored sweeps only. Fixed tessellation and quantized vertices are shared by rendering
// and simulation; no field, mesher, saved mesh or browser result enters physics.
export type RoadPoint = [number, number, number]
export interface RoadData {
  closed?: boolean
  path: { p: RoadPoint; in?: RoadPoint; out?: RoadPoint }[]
  profile: [number, number][] // lateral fraction of width, height in metres
  width: number
  banking: number[] // degrees at each path anchor
  surface: 'normal' | 'ice'
  material: string
}
export function validateRoad(raw: unknown): RoadData {
  const r = raw as RoadData
  const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x)
  const vector = (v: unknown): boolean => Array.isArray(v) && v.length === 3 && v.every(finite) && v.every(x => Math.abs(x) <= 10000)
  if (!r || !Array.isArray(r.path) || r.path.length < 2 || r.path.length > 64 ||
    !r.path.every(p => p && vector(p.p) && (p.in === undefined || vector(p.in)) && (p.out === undefined || vector(p.out))) ||
    !finite(r.width) || r.width < .1 || r.width > 100 ||
    !Array.isArray(r.profile) || r.profile.length < 2 || r.profile.length > 16 ||
    !r.profile.every((p, i) => Array.isArray(p) && p.length === 2 && p.every(finite) && Math.abs(p[0]) <= 2 && Math.abs(p[1]) <= 20 && (i === 0 || p[0] > r.profile[i-1][0])) ||
    !Array.isArray(r.banking) || r.banking.length !== r.path.length || !r.banking.every(n => finite(n) && Math.abs(n) <= 75) ||
    !['ice', 'normal'].includes(r.surface) || typeof r.material !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(r.material)) throw new Error('Invalid road sweep: expected path, profile, width, banking, surface and #rrggbb material')
  if (r.closed !== undefined && typeof r.closed !== 'boolean') throw new Error('Road closed must be a boolean')
  for (let i = 1; i < r.path.length; i++) if (norm(...r.path[i].p.map((x,j) => x-r.path[i-1].p[j])) < .01) throw new Error('Road anchors must be distinct')
  return r
}
export function roadMesh(raw: RoadData) {
  const r = validateRoad(raw), positions: number[] = [], uvs: number[] = [], indices: number[] = []
  const steps = 32, cols = r.profile.length
  let length = 0, prev: number[] | undefined
  const quant = (x: number) => Math.round(x * 1e6) / 1e6 + 0
  for (let span = 0; span < r.path.length - (r.closed ? 0 : 1); span++) {
    const a = r.path[span], b = r.path[(span+1)%r.path.length], c = a.out ?? a.p.map((x,j) => x+(b.p[j]-x)/3), d = b.in ?? b.p.map((x,j) => x+(a.p[j]-x)/3)
    for (let step = span ? 1 : 0; step <= steps; step++) {
      const t = step / steps, u = 1-t
      const p = a.p.map((x,j) => u*u*u*x+3*u*u*t*c[j]+3*u*t*t*d[j]+t*t*t*b.p[j])
      const tangent = a.p.map((x,j) => 3*u*u*(c[j]-x)+6*u*t*(d[j]-c[j])+3*t*t*(b.p[j]-d[j]))
      const tangentLength = norm(...tangent)
      if (tangentLength < 1e-8 || norm(tangent[0], tangent[2]) < 1e-8) throw new Error('Road tangent must have a horizontal direction')
      const T = tangent.map(x => x/tangentLength), sideNorm = norm(T[0],T[2]), X = [T[2]/sideNorm,0,-T[0]/sideNorm]
      const Y = [T[1]*X[2],T[2]*X[0]-T[0]*X[2],-T[1]*X[0]]
      const angle = (r.banking[span]*u+r.banking[(span+1)%r.banking.length]*t)*Math.PI/180, co = dcos(angle), si = dsin(angle)
      if (prev) length += norm(...p.map((x,j) => x-prev![j]))
      prev = p
      for (const [fraction,height] of r.profile) {
        const x = fraction*r.width, h = height
        positions.push(...p.map((v,j) => quant(v+X[j]*(x*co-h*si)+Y[j]*(x*si+h*co))))
        uvs.push(fraction+.5, length/4)
      }
    }
  }
  const rows = positions.length/3/cols
  for (let row=0;row<rows-1;row++) for(let col=0;col<cols-1;col++) {
    const a=row*cols+col,b=a+1,c=a+cols,d=c+1
    indices.push(a,c,b,b,c,d)
  }
  const normals = new Float32Array(positions.length)
  for(let i=0;i<indices.length;i+=3) {
    const [a,b,c]=indices.slice(i,i+3).map(n=>n*3), ab=[0,1,2].map(j=>positions[b+j]-positions[a+j]), ac=[0,1,2].map(j=>positions[c+j]-positions[a+j])
    const n=[ab[1]*ac[2]-ab[2]*ac[1],ab[2]*ac[0]-ab[0]*ac[2],ab[0]*ac[1]-ab[1]*ac[0]]
    for(const v of [a,b,c]) for(let j=0;j<3;j++) normals[v+j]+=n[j]
  }
  for(let i=0;i<normals.length;i+=3) {const l=norm(normals[i],normals[i+1],normals[i+2])||1; for(let j=0;j<3;j++) normals[i+j]/=l}
  return { positions: new Float32Array(positions), normals, uvs: new Float32Array(uvs), indices: new Uint32Array(indices), length }
}
