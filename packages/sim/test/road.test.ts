import test from 'node:test'
import assert from 'node:assert/strict'
import { roadMesh, validateRoad, type RoadData } from '../src/road.ts'
import { parseFeatureList } from '../../game/src/levelBlock.ts'
export const straight: RoadData = { path:[{p:[0,0,0]},{p:[0,0,100]}],width:12,profile:[[-.5,0],[0,.1],[.5,0]],banking:[0,0],surface:'ice',material:'#88ccff' }
test('road length, shared seams, upward triangles, length UVs and byte determinism',()=>{
 const a=roadMesh(straight),b=roadMesh(straight)
 assert.equal(a.length,100);assert.deepEqual(a,b)
 assert.equal(a.positions.length/3,33*3);assert.equal(a.indices.length,32*2*6)
 assert.equal(a.uvs.at(-1),25)
 const edges=new Map<string,number>()
 for(let i=0;i<a.indices.length;i+=3) for(const [x,y] of [[0,1],[1,2],[2,0]]) {
   const u=a.indices[i+x],v=a.indices[i+y],key=[Math.min(u,v),Math.max(u,v)].join(':');edges.set(key,(edges.get(key)??0)+1)
 }
 assert.ok([...edges.values()].every(n=>n<=2));assert.equal([...edges.values()].filter(n=>n===1).length,68)
 for(let i=1;i<a.normals.length;i+=3) assert.ok(a.normals[i]>.99)
})
test('road validator rejects malformed, degenerate and unbounded sweeps',()=>{
 for(const patch of [{width:0},{surface:'lava'},{banking:[0]},{path:[{p:[0,0,0]},{p:[0,0,0]}]},{material:'asset.ice'},{profile:[[0,0],[0,1]]}]) assert.throws(()=>validateRoad({...straight,...patch}))
 assert.equal(parseFeatureList([{id:'ice-road',kind:'road',...straight}],'test')[0].kind,'road')
 assert.throws(()=>parseFeatureList([{id:'bad',kind:'road',...straight,width:-1}],'test'))
})
test('banking and curved ramp produce finite repeatable geometry',()=>{
 const r={...straight,path:[{p:[0,4,0] as [number,number,number],out:[0,4,20] as [number,number,number]},{p:[30,8,40] as [number,number,number],in:[10,5,40] as [number,number,number]}],banking:[0,25]}
 const m=roadMesh(r);assert.ok(m.length>50);assert.ok(m.positions.every(Number.isFinite));assert.deepEqual(m,roadMesh(r))
})

test('road collider is independently rebuilt in sim and preserves rollback bytes',async()=>{
 const { initRapier }=await import('@gamesaloon/rollback-rapier')
 const { FiestaWorld }=await import('../src/world.ts')
 const { ObstacleSystem }=await import('../src/obstacles/system.ts')
 const R=await initRapier()
 const course={id:'test',name:'Test',kind:'race',profiles:['standard'],timeLimitS:60,killPlaneY:-10,spawns:[],checkpoints:[],finish:null,path:[],regions:[],queuePad:null,contentHash:1,
   obstacles:[{id:'road',asset:'',t:{x:0,y:0,z:0},r:{x:0,y:0,z:0,w:1},s:{x:1,y:1,z:1},colliders:[],sweep:straight,surface:'ice',friction:.02,motion:{kind:'static'}}]} as import('../src/course.ts').ResolvedCourse
 function make(load:boolean){const sys=new ObstacleSystem([course]);const world=new FiestaWorld(R,{playerCount:1,systems:[sys,{name:'loader',init(ctx){if(load)sys.load(ctx,0)},preStep(){},postStep(){},snapshot(){},restore(){}}]});return {sys,world}}
 const a=make(true),b=make(false)
 try {
   const col=a.world.physics.body(a.sys.bodyId(0)).collider(0)
   assert.equal(col.shape.type,R.ShapeType.TriMesh)
   assert.deepEqual(col.vertices(),roadMesh(straight).positions)
   assert.equal(a.sys.spec(0).surface,'ice')
   assert.ok(Math.abs(col.friction()-.02)<1e-6)
   for(let i=0;i<30;i++)a.world.step([0])
   const bytes=a.world.takeSnapshotBytes();b.world.restoreSnapshotBytes(bytes)
   assert.deepEqual(b.world.takeSnapshotBytes(),bytes)
   for(let i=0;i<30;i++){a.world.step([0]);b.world.step([0])}
   assert.deepEqual(a.world.takeSnapshotBytes(),b.world.takeSnapshotBytes())
 }finally{a.world.free();b.world.free()}
})
