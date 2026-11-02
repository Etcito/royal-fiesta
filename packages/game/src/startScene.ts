import type { CourseV1 } from './courseV1.ts'
import type { StartScene } from './content.ts'
import { sceneCamera } from './sceneCamera.ts'
import { refuse } from '@royal-fiesta/sim/refusal'
export function startSceneOf(course: CourseV1): StartScene {
  const camera = sceneCamera(course.json.scene, 'start')
  if (course.kind !== 'start' || !camera) return refuse('content', course.id, 'expected a start scene with a start camera')
  const start = course.json.start as { spot: StartScene['spot'] }
  return { courseId: course.id, spot: start.spot, camera }
}

export function startSceneId(season: number | string): string {
  const number = typeof season === 'number' ? season : Number(/^s(\d+)(?:-|$)/.exec(season)?.[1])
  if (!Number.isInteger(number) || number < 1) return refuse('content', 'season', 'expected a positive season number or s<number>-<name> id')
  return `start-season${number}`
}
