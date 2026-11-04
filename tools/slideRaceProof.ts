// Real MatchSim bots: report contact/slide progress, qualification, and any falls.
import { initRapier } from '@gamesaloon/rollback-rapier'
import { loadCourseV1File } from '../apps/headless/src/contentFiles.ts'
import { MatchSim, Phase } from '../packages/sim/src/match/matchSim.ts'
import type { CharacterView, MatchViewState } from '../packages/sim/src/match/matchSim.ts'
import { CharMode } from '../packages/sim/src/character/constants.ts'
import { PlayerStatus } from '../packages/sim/src/match/roundSystem.ts'
import { neutralInput } from '../packages/sim/src/input.ts'
const road=(await loadCourseV1File('courses/s1-glacier-run.course.json')).sim!
const survival=(await loadCourseV1File('courses/survival-sprint.course.json')).sim!
const R=await initRapier(), sim=new MatchSim(R,{seed:7,playerCount:8,humans:Array(8).fill(false),profile:'sprint',courses:[road,survival].sort((a,b)=>a.id<b.id?-1:1)})
const inputs=Array.from({length:8},()=>neutralInput())
const state={pos:{x:0,y:0,z:0},vel:{x:0,y:0,z:0},facing:{x:0,z:1},mode:0,status:0,parked:false,teleportTick:0} as CharacterView
const phase={podium:[]} as unknown as MatchViewState
const seats=Array.from({length:8},()=>({diveTicks:0,slideTicks:0,iceTicks:0,slideMinZ:Infinity,slideMaxZ:-Infinity,qualifiedTick:0,belowRoadTicks:0}))
try {
 for(let tick=0;tick<60*125;tick++) {
  sim.step(inputs)
  for(let p=0;p<8;p++) {
   const s=sim.character(p,state),log=seats[p]
   if(s.mode===CharMode.dive)log.diveTicks++
   if(s.mode===CharMode.slide){log.slideTicks++;log.slideMinZ=Math.min(log.slideMinZ,s.pos.z);log.slideMaxZ=Math.max(log.slideMaxZ,s.pos.z)}
   if(s.surface==='ice')log.iceTicks++
   if(s.pos.y < -5)log.belowRoadTicks++
   if(s.status===PlayerStatus.qualified && !log.qualifiedTick)log.qualifiedTick=sim.tick
  }
  if(sim.phase(phase).phase>=Phase.roundEnd)break
 }
 console.log(JSON.stringify({course:road.id,tick:sim.tick,seats},null,2))
 if(!seats.some(s=>s.qualifiedTick && s.slideTicks>400 && s.slideMinZ<5 && s.slideMaxZ>275 && s.belowRoadTicks===0))process.exitCode=1
}finally{sim.free()}
