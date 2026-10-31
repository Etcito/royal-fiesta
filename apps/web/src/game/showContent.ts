/// <reference types="vite/client" />
// The in-page show's content: the fixture courses that have zone sidecars, their zones and map info.
// No season file is read here: the season maps are not built until M10, so showMaps falls back to the
// level kind of each course.
import type { ProfileName, ResolvedCourse } from '@royal-fiesta/sim/course'
import { levelOf } from '@royal-fiesta/sim/course'
import { refuse } from '@royal-fiesta/sim/refusal'
import type { RoundKind } from '@royal-fiesta/sim/season/kinds'
import type { SchedMap } from '@royal-fiesta/sim/season/scheduler'
import type { ZonesFile } from '@royal-fiesta/sim/zones/zonesFile'
import { loadZonesFile } from '@royal-fiesta/sim/zones/zonesFile'
import { showMaps } from '@royal-fiesta/game/net/zoneRounds'
import { browserCourses } from '../client/sources.ts'

const ZONE_PREFIX = '../../../../'
const SHOW_KINDS: readonly RoundKind[] = ['race', 'survival', 'team']
const VIEW_ONLY = ['hub', 'podium', 'gallery']

export interface ShowMapInfo {
  readonly name: string
  readonly kind: RoundKind
}

export interface ShowContent {
  readonly courses: ResolvedCourse[]
  readonly zones: Map<string, ZonesFile>
  readonly season: SchedMap[]
  info(mapId: string): ShowMapInfo
}

export async function loadShowContent(profile: ProfileName): Promise<ShowContent> {
  const sidecars = import.meta.glob<string>('../../../../courses/*.zones.json', {
    query: '?raw', import: 'default', eager: true,
  })
  const sidecarText = new Map<string, string>()
  for (const key of Object.keys(sidecars)) {
    if (key.startsWith(ZONE_PREFIX)) sidecarText.set(key.slice(ZONE_PREFIX.length), sidecars[key])
  }

  // Every sidecar course is a candidate map, not only those tagged for the match's timing profile: with the
  // sprint-tagged pair alone, one is the final map and every other round had one candidate, so the match
  // played it at once and the show never reached a vote (card 6404).
  const loaded = await browserCourses(null)
  const courses: ResolvedCourse[] = []
  for (let i = 0; i < loaded.length; i++) {
    const course = loaded[i]
    if (VIEW_ONLY.includes(course.kind)) continue
    if (!SHOW_KINDS.includes(levelOf(course).kind)) continue
    if (!sidecarText.has(`courses/${course.id}.zones.json`)) continue
    courses.push(course)
  }
  if (courses.length < 2) {
    refuse('zone', 'courses/*.zones.json', `profile '${profile}' has ${courses.length} playable course(s) with a sidecar in courses/; add at least 2 courses with courses/<id>.zones.json`)
  }

  const zones = new Map<string, ZonesFile>()
  for (let i = 0; i < courses.length; i++) {
    const course = courses[i]
    const file = await loadZonesFile(course.id, course, async path => {
      const text = sidecarText.get(path)
      if (text === undefined) refuse('zones', path, 'missing; add the sidecar (zone mode needs it, full-mesh mode does not)')
      return text
    })
    zones.set(course.id, file)
  }

  const infoById = new Map<string, ShowMapInfo>()
  for (let i = 0; i < courses.length; i++) {
    const course = courses[i]
    infoById.set(course.id, { name: course.name, kind: levelOf(course).kind })
  }

  return {
    courses,
    zones,
    season: showMaps(courses),
    info(mapId: string): ShowMapInfo {
      const info = infoById.get(mapId)
      if (info === undefined) refuse('show', `info(${mapId})`, `unknown map id '${mapId}'; use a course id with a zones sidecar`)
      return info
    },
  }
}
