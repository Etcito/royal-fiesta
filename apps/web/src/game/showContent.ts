/// <reference types="vite/client" />
// The in-page show uses the built season maps and their authored zone sidecars.
import type { ProfileName, ResolvedCourse } from '@royal-fiesta/sim/course'
import { refuse } from '@royal-fiesta/sim/refusal'
import type { RoundKind } from '@royal-fiesta/sim/season/kinds'
import type { SchedMap } from '@royal-fiesta/sim/season/scheduler'
import type { ZonesFile } from '@royal-fiesta/sim/zones/zonesFile'
import { loadZonesFile } from '@royal-fiesta/sim/zones/zonesFile'
import { showMaps } from '@royal-fiesta/game/net/zoneRounds'
import { parseSeason, playableMaps } from '@royal-fiesta/game/season'
import seasonText from '../../../../courses/season.json?raw'
import { loadV1Courses } from '../content/v1Data.ts'

const ZONE_PREFIX = '../../../../'

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
  const season = parseSeason(JSON.parse(seasonText), 'courses/season.json')
  const maps = playableMaps(season)
  const builtCourses = new Set(maps.map(map => map.course))
  const sidecars = import.meta.glob<string>('../../../../courses/*.zones.json', {
    query: '?raw', import: 'default', eager: true,
  })
  const sidecarText = new Map<string, string>()
  for (const key of Object.keys(sidecars)) {
    if (key.startsWith(ZONE_PREFIX)) sidecarText.set(key.slice(ZONE_PREFIX.length), sidecars[key])
  }

  const loaded = (await loadV1Courses(() => {}, undefined, [...builtCourses])).courses.flatMap(course => course.sim === null ? [] : [course.sim])
  const courses: ResolvedCourse[] = []
  for (let i = 0; i < loaded.length; i++) {
    const course = loaded[i]
    if (!builtCourses.has(course.id)) continue
    if (!sidecarText.has(`courses/${course.id}.zones.json`)) {
      refuse('show', `courses/${course.id}.zones.json`, 'built season map is missing its zone sidecar')
    }
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
  for (const map of maps) {
    infoById.set(map.id, { name: map.name, kind: map.kind })
  }

  return {
    courses,
    zones,
    season: showMaps(courses, season),
    info(mapId: string): ShowMapInfo {
      const info = infoById.get(mapId)
      if (info === undefined) refuse('show', `info(${mapId})`, `unknown map id '${mapId}'; use a built season map with a zones sidecar`)
      return info
    },
  }
}
