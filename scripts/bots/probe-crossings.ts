// Isolated physics diagnostic, not a proof of geometric unreachability.
// Sweep run-up positions and dive timing without another player supplying lift.
// Tidal side-entry and reverse-ramp exit manoeuvres need additional trajectories;
// see the round-4 report for successful narrow manoeuvres found in those sweeps.
import {initRapier} from '@gamesaloon/rollback-rapier'
import {loadAllCoursesV1} from '../../apps/headless/src/contentFiles.ts'
import {createFiestaDomainFactory} from '../../packages/sim/src/zones/fiestaDomainFactory.ts'
import {parseZonesFile} from '../../packages/sim/src/zones/zonesFile.ts'
import {PROFILES} from '../../packages/sim/src/match/setup.ts'
import {FiestaDomain} from '../../packages/sim/src/zones/fiestaDomain.ts'
const R=await initRapier(),shadows={count:0,fromDomain(){throw Error()},reader(){throw Error()}}
for(const content of await loadAllCoursesV1()) {
 if(!['s1-c2-tidal-relay','race-hammer-hill'].includes(content.id))continue
 const c=content.sim!, tidal=c.id==='s1-c2-tidal-relay'
 const zones=parseZonesFile({format:'royal-fiesta.zones',version:0,course:c.id,grid:{origin:[-1000,-1000],cell:[2000,2000],cols:1,rows:1},parts:{},tuning:{}},'probe',c)
 let success=0,highest=0,best:any=null,attempts=0
 for(const x of (tidal?[0,6.5,7,8]:[0])) for(let offset=0;offset<=18;offset++) for(let dive=-1;dive<=40;dive+=2) {
  attempts++
  const domain=createFiestaDomainFactory(R,{course:c,zones,profile:{...PROFILES.standard,introTicks:0},kind:'race',seatCount:1}).create({id:1,kind:'seat',seats:[0],cells:[0],replicas:[0]},0) as FiestaDomain
  const z=tidal?77+offset*.5:122+offset*.25
  domain.characters.place(domain.ctx,0,{...c.spawns[0],t:{x,y:tidal?0:4.5,z}})
  for(let t=0;t<10;t++) domain.step([{moveX:0,moveZ:0,jump:false,dive:false,grab:false}],shadows)
  let reached=false
  for(let t=0;t<100;t++){
   const dx=tidal?-x:0,dz=tidal?70-z:1,len=Math.hypot(dx,dz)
   domain.step([{moveX:dx/len,moveZ:dz/len,jump:t<10&&t%2===0,dive:t===dive,grab:false}],shadows)
   const s=domain.state(0)
   if(s.pos.y>highest){highest=s.pos.y;best={x,offset,dive,z,y:highest,endZ:s.pos.z}}
   if(tidal?s.pos.z<74&&s.pos.y>2&&s.grounded:s.pos.z>127&&s.pos.y>7) reached=true
  }
  if(reached)success++
  domain.dispose()
 }
 console.log(JSON.stringify({course:c.id,attempts,success,highest,best}))
}
