import type { PrimsAsset } from './prims.ts'
import type { CameraPose, RenderPort, RenderTarget, Vec3T } from './render/port.ts'
import type { ProfileName, ResolvedCourse } from '@royal-fiesta/sim/course'

export type ContentId = 'v0' | 'v1' | 'sdf'

export interface LoadProgress {
  phase: 'courses' | 'assets' | 'meshing' | 'upload' | 'done'
  done: number
  total: number
  label: string
}

export interface PodiumLayout {
  courseId: string | null
  spots: readonly { t: Vec3T; yawDeg: number }[]
  camera: CameraPose
}

export interface CourseDressing {
  enter(port: RenderPort, courseId: string): void
  leave(port: RenderPort): void
}

export const NO_DRESSING: CourseDressing = Object.freeze({
  enter(port: RenderPort, _courseId: string): void {
    port.setEnvironment(null)
  },
  leave(_port: RenderPort): void {}
})

export interface GameContent {
  readonly id: ContentId
  load(profile: ProfileName, onProgress: (p: LoadProgress) => void): Promise<void>
  playlist(): readonly ResolvedCourse[]
  course(id: string): ResolvedCourse
  hub(): ResolvedCourse
  podium(): PodiumLayout
  assets(name: string): PrimsAsset
  character(): PrimsAsset
  createPort(target: RenderTarget): Promise<RenderPort>
  dressing(): CourseDressing
  report(): Record<string, number | string | readonly string[]>
}

export interface ContentProvider {
  readonly id: ContentId
  readonly priority: number
  create(): GameContent
}
