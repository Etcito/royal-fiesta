import { SnapWriter, SnapReader } from '@gamesaloon/rollback'
import { decodeFiestaEvents } from '../../packages/sim/src/zones/ledger.ts'
import { initRapier } from '@gamesaloon/rollback-rapier'
import { loadAllCoursesV1 } from '../../apps/headless/src/contentFiles.ts'
import { createFiestaDomainFactory } from '../../packages/sim/src/zones/fiestaDomainFactory.ts'
import { FiestaDomain } from '../../packages/sim/src/zones/fiestaDomain.ts'
import { parseZonesFile } from '../../packages/sim/src/zones/zonesFile.ts'
import { PROFILES } from '../../packages/sim/src/match/setup.ts'
import { PlayerStatus } from '../../packages/sim/src/match/roundSystem.ts'
import { neutralInput } from '../../packages/sim/src/input.ts'
import { modeBotInput, newModeBotMemory } from '../../packages/game/src/net/modeBots.ts'
const R = await initRapier()
const results = []
const shadows = {count:0,fromDomain(){throw Error('no shadows')},reader(){throw Error('no shadows')}}
for (const content of await loadAllCoursesV1()) {
 const c = content.sim
 if (process.env.BOT_COURSES && !process.env.BOT_COURSES.split(',').includes(content.id)) continue
 if (!c || !['race','survival'].includes(c.kind)) continue
 const n = Math.min(8,c.spawns.length), ids = Array.from({length:n},(_,i)=>i)
 const zones = parseZonesFile({format:'royal-fiesta.zones',version:0,course:c.id,grid:{origin:[-1000,-1000],cell:[2000,2000],cols:1,rows:1},parts:{},tuning:{}},'measure.zones',c)
 const factory=createFiestaDomainFactory(R,{course:c,zones,profile:{...PROFILES.standard,introTicks:0},kind:c.kind,seatCount:n})
 const domain=factory.create({id:1,kind:'seat',seats:ids,cells:[0],replicas:[0]},0) as FiestaDomain
 const memories=ids.map(()=>newModeBotMemory()), inputs=ids.map(()=>neutralInput())
 const deaths:any[]=[], finishes:any[]=[], objectives:any[]=[], counts=ids.map(()=>0)
 const writer=new SnapWriter()
 // Parking is the common sink for finishes, kill planes and feature hazards.
 const park=domain.characters.park.bind(domain.characters)
 domain.characters.park=(ctx,p)=>{
  const st=domain.state(p),pos={...st.pos}
  if(st.mode!==7 && domain.status(p)!==PlayerStatus.qualified){
   counts[p]++
   deaths.push({bot:p,tick:domain.tick,reason:pos.y<c.killPlaneY?'kill-plane':'hazard',pos,waypoint:(memories[p].takeover as any).pathIndex,target:memories[p].target && {...memories[p].target}})
  }
  park(ctx,p)
 }
 const place=domain.characters.place.bind(domain.characters)
 domain.characters.place=(ctx,p,spawn)=>{
  const st=domain.state(p)
  if(st.mode!==7){counts[p]++;deaths.push({bot:p,tick:domain.tick,reason:'hazard-catch',pos:{...st.pos},waypoint:(memories[p].takeover as any).pathIndex,target:memories[p].target && {...memories[p].target}})}
  place(ctx,p,spawn)
 }
 const ticks=Math.round(c.timeLimitS*60)
 for(let t=0;t<ticks;t++){
  for(const p of ids)modeBotInput(domain,memories[p],p,t,inputs[p])
  if(process.env.BOT_TRACE && t % 30 === 0) { const p = Number(process.env.BOT_TRACE)-1; console.error(JSON.stringify({t,p,pos:domain.state(p).pos,vel:domain.state(p).vel,mode:domain.state(p).mode,ground:domain.state(p).grounded,node:(memories[p].takeover as any).pathIndex,target:memories[p].target,input:inputs[p],spring:memories[p].springTicks})) }
  const prev=ids.map(p=>domain.status(p))
  domain.step(inputs,shadows)
  writer.reset()
  domain.events(writer)
  decodeFiestaEvents(new SnapReader(writer.bytes()), {} as any, event=>{if(event.kind==='crown')objectives.push({...event})})
  for(const p of ids)if(prev[p]===PlayerStatus.alive&&domain.status(p)===PlayerStatus.qualified)finishes.push({bot:p,tick:t})
 }
 if(process.env.BOT_DEBUG) console.error(JSON.stringify({state:domain.state(0),memory:memories[0],input:inputs[0]}))
 const end=ids.map(p=>({bot:p,falls:counts[p],finished:finishes.some(f=>f.bot===p),status:domain.status(p),pos:{...domain.state(p).pos},waypoint:(memories[p].takeover as any).pathIndex}))
 const survived10=n-new Set(deaths.filter(d=>d.tick<600).map(d=>d.bot)).size
 const timeouts=c.kind==='race'?end.filter(e=>!e.finished && e.status===PlayerStatus.alive).map(e=>({...e,reason:'timeout',tick:ticks})):[]
 results.push({survived10,timeouts,course:c.id,kind:c.kind,seconds:c.timeLimitS,bots:n,finished:finishes.length,fallingBots:counts.filter(x=>x>0).length,falls:deaths.length,deaths,finishes,objectives,end})
 console.error(c.id,'finish',finishes.length,'falling',counts.filter(x=>x>0).length,'falls',deaths.length)
 domain.dispose()
}
console.log(JSON.stringify(results,null,2))
