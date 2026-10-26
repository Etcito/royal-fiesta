import type { AmbientDesc, Engine, EnvironmentDesc, LightDesc } from '@etcito/raa'
import { refuse } from '@royal-fiesta/sim/refusal'

const RELEASE = '@etcito/raa 0.3.0'
// The port's own lighting: set at init and restored by setEnvironment(null).
export const DEFAULT_LIGHT: LightDesc = { direction: [-0.4, -1, -0.3], color: [1, 1, 1], intensity: 3 }
export const DEFAULT_AMBIENT: AmbientDesc = { color: [0.6, 0.7, 0.9], intensity: 0.3 }
// Named presets shipped by RAA 0.3.0; validate before applying any section.
const ENV_NAMES = {
  sky: ['day', 'snow', 'jungle', 'night'],
  fog: ['clear', 'haze', 'snow', 'jungle', 'night'],
  post: ['neutral', 'candy', 'ice', 'jungle', 'neon'],
} as const

type EnvironmentEngine = Pick<Engine, 'applyEnvironment' | 'setPassEnabled' | 'setLight' | 'setAmbient'>

// Validate every section before touching the engine. RAA preset names pass through unchanged.
export function applyCourseEnvironment(engine: EnvironmentEngine, env: Readonly<Record<string, unknown>> | null, area: string, p: string): void {
  if (env === null) {
    engine.applyEnvironment({ sky: 'day', fog: 'clear', post: 'neutral' })
    engine.setPassEnabled('fog', false)
    engine.setPassEnabled('grading', false)
    engine.setPassEnabled('bloom', false)
    engine.setLight(DEFAULT_LIGHT)
    engine.setAmbient(DEFAULT_AMBIENT)
    return
  }
  if (typeof env !== 'object' || Array.isArray(env)) refuse(area, p, 'environment is not an object; pass the course environment object or null')
  let light: LightDesc | null = null
  const environment: EnvironmentDesc = {}
  for (const key of Object.keys(env)) {
    const v = env[key]
    if (v === undefined || v === null) continue
    if (key === 'sun') light = sunLight(area, p, v)
    else if (key === 'sky' || key === 'fog' || key === 'post') {
      const known: readonly string[] = ENV_NAMES[key]
      if (typeof v !== 'string' || !known.includes(v)) {
        refuse(area, p, `environment.${key}: unknown preset '${String(v)}'; known names: ${known.join(', ')}`)
      }
      environment[key] = v
    }
    else refuse(area, p, `environment.${key} is not an S13 environment key; use sky, sun, fog or post`)
  }
  engine.applyEnvironment({ sky: 'day', fog: 'clear', post: 'neutral', ...environment })
  engine.setPassEnabled('fog', environment.fog !== undefined)
  engine.setPassEnabled('grading', environment.post !== undefined)
  engine.setPassEnabled('bloom', environment.post !== undefined)
  engine.setLight(light ?? DEFAULT_LIGHT)
  engine.setAmbient(DEFAULT_AMBIENT)
}

function unsupported(area: string, p: string, field: string): never {
  refuse(area, p, `'${field}' not supported by ${RELEASE}; brick gap, see docs/brick-gaps.md`)
}

function vec3(v: unknown): [number, number, number] | null {
  if (!Array.isArray(v) || v.length !== 3 || !v.every(Number.isFinite)) return null
  return [v[0], v[1], v[2]]
}

// S13 sun {dir, color, intensity} -> the release's LightDesc. A named sun has no release API.
function sunLight(area: string, p: string, sun: unknown): LightDesc {
  if (typeof sun !== 'object' || sun === null || Array.isArray(sun)) unsupported(area, p, 'sun (by name)')
  const s = sun as Record<string, unknown>
  for (const key of Object.keys(s)) {
    if (key !== 'dir' && key !== 'color' && key !== 'intensity') unsupported(area, p, `sun.${key}`)
  }
  const direction = vec3(s.dir)
  if (direction === null || direction.every((c) => c === 0)) refuse(area, p, 'environment.sun.dir is not 3 finite numbers, not all 0; pass [x, y, z]')
  const color = vec3(s.color)
  if (color === null) refuse(area, p, 'environment.sun.color is not 3 finite numbers; pass linear [r, g, b]')
  const intensity = s.intensity
  if (typeof intensity !== 'number' || !Number.isFinite(intensity) || intensity < 0) refuse(area, p, 'environment.sun.intensity is not a finite number >= 0; pass the light intensity')
  return { direction, color, intensity }
}
