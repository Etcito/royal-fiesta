// Run with: node --experimental-strip-types --import ./scripts/bench/localPackages.ts scripts/bench/showSimulation.ts
// BENCH_MODE=offline selects the replacement; the default reproduces the old show. No DOM or GPU.
import { readFile } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { initRapier } from '@gamesaloon/rollback-rapier'
import { fixtureResolver } from '@royal-fiesta/game/assets'
import { matchCourses } from '@royal-fiesta/game/courseSet'
import { showMaps } from '@royal-fiesta/game/net/zoneRounds'
import { createZoneFullMatch } from '@royal-fiesta/game/net/zoneFullMatch'
import { createOfflineFullMatch } from '@royal-fiesta/game/net/offlineFullMatch'
import { loadAllCoursesV1 } from '../../apps/headless/src/contentFiles.ts'
import { parseSeason } from '@royal-fiesta/game/season'
import { ZoneLoopback } from '@royal-fiesta/game/net/zoneLoopback'
import { newModeBotMemory, modeBotInput } from '@royal-fiesta/game/net/modeBots'
import { loadZonesFile } from '@royal-fiesta/sim/zones/zonesFile'
import { decodeInput, NEUTRAL_CODE } from '@royal-fiesta/sim/input'
const read = (path: string) => readFile(new URL('../../' + path, import.meta.url), 'utf8')
const R = await initRapier()
const entries = await Promise.all(['race-sprint', 'survival-sprint'].map(async id => {
 const path = `fixtures/courses/${id}.course.json`; return { path, json: JSON.parse(await read(path)) }
}))
const authored = process.env.BENCH_CONTENT !== 'fixture'
const courses = authored ? (await loadAllCoursesV1()).flatMap(c => c.sim && c.sim.profiles.includes('sprint') ? [c.sim] : []) : await matchCourses(entries, fixtureResolver(read), 'sprint')
const season = authored ? showMaps(courses, parseSeason(JSON.parse(await read('courses/season.json')), 'courses/season.json')) : showMaps(courses)
const offline = process.env.BENCH_MODE === 'offline'
console.log(JSON.stringify({offline, authored, seed:3, node:process.version}))
const zones = new Map(await Promise.all(courses.map(async c => [c.id, await loadZonesFile(c.id, c, read)] as const)))
for (const seats of [12, 30, 60]) {
 const count = Math.ceil(seats / 4)
 const peers = Array.from({length: count}, (_, peer) => ({peer, seats: [] as number[]}))
 for (let seat=0; seat<seats; seat++) peers[seat % count].seats.push(seat)
 const roster = {seatCount: seats, peers, live: peers.map(() => true)}
 const net = offline ? null : new ZoneLoopback(count, {seed:3,rttMs:0,jitterMs:0,loss:0})
 const measurements = Object.fromEntries(peers.map(p => [p.peer,{cpuMs:4,bandwidthKbps:4096,latencyMs:30,spareSlots:3}]))
 const matches = offline ? [createOfflineFullMatch(R, {seats,seed:3,courses,zones,season,profile:'sprint',voteMs:0})] : peers.map(p => createZoneFullMatch(R,{localPeer:p.peer,roster,seed:3,courses,zones,season,profile:'sprint',voteMs:0,measurements},net!.transport(p.peer)))
 const memories = Array.from({length:seats}, newModeBotMemory)
 let peakWorlds=0, peakDomains=0, ms=0, measured=0
 const costs: number[] = []
 const frames=Number(process.env.BENCH_STEPS ?? 360)
 for(let tick=0;tick<frames;tick++) {
  const start=performance.now(); net?.advance(1000/60)
  for(const m of matches) m.frame(1/60,(round,out)=>{for(let i=0;i<out.length;i++) {
   const seat=round.localSeats[i], d=round.match.domains.find(d=>d.seats.includes(seat))
   if(seat===0 || !d) decodeInput(NEUTRAL_CODE,out[i]); else modeBotInput(d,memories[round.seatOf[seat]],seat,tick,out[i])
  }})
  const cost=performance.now()-start; ms+=cost; measured++; costs.push(cost)
  peakWorlds=Math.max(peakWorlds,matches.reduce((n,m)=>n+(m.round?.match.worlds??0),0))
  peakDomains=Math.max(peakDomains,matches.reduce((n,m)=>n+(m.round?.match.domains.length??0)+ (m.round ? 1:0),0))
  if(tick===0) console.log(JSON.stringify({seats,firstStepMs:cost,worlds:peakWorlds,rollbackDomains:offline ? 0 : peakDomains, sessions: offline ? 0 : count, course:matches[0].round?.plan.course.id}))
  if(ms > Number(process.env.BENCH_LIMIT_MS ?? 30000)) break
 }
 const sampledTicks = matches.map(m => m.round?.match.stats.tick ?? 0)
 const advancedTicks = Math.min(...sampledTicks)
 console.log(JSON.stringify({seats,frames:measured,msPerFrame:ms/measured,
  advancedTicks, msPerAdvancedTick: advancedTicks > 0 ? ms / advancedTicks : null,medianMs:costs.sort((a,b)=>a-b)[Math.floor(costs.length/2)],maxMs:Math.max(...costs),worlds:peakWorlds,rollbackDomains:offline ? 0 : peakDomains,
  sessions: offline ? 0 : count,
  sampledTicks,
  rollbacks: matches.reduce((n,m) => n + (m.round?.match.stats.rollbacks ?? 0), 0),
  resimTicks: matches.reduce((n,m) => n + (m.round?.match.stats.resimTicks ?? 0), 0),
 }))
 for(const m of matches) m.dispose()
}
