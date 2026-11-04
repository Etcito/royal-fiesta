// The character body is penguin.body's saved game collider (owner rule: all game content is editable in SDF Modeler).
// SDF Modeler's Save asset writes the asset's `collision` list; for a character asset it is exactly one upright capsule
// centred on the asset origin (MAMA characterCollisionError refuses anything else at save, and the Collider section edits
// its radius and height). The sim reads that saved radius and halfHeight here, at module load: values at save, the same
// bytes in every client of a rollback match, never measured on a client mesh. Any other collider list refuses at load.
// CHAR (constants.ts) keeps only the tuning values; everything that depends on the body size reads CAPSULE.
// The web build bundles only the asset's game data from this import, never its document (apps/web/vite.config.ts rfAssetData).
import penguin from '../../../../assets/common/penguin.body.asset.json' with { type: 'json' }
import { refuse } from '../refusal.ts'

/** The character capsule (Rapier capsule: a Y segment of 2 * halfHeight with caps of `radius`). */
export interface CharacterCapsule {
  readonly radius: number
  readonly halfHeight: number
  /** radius + halfHeight: the body centre above the feet when standing. */
  readonly stand: number
}

/** The asset whose saved collider is the character body. */
export const CHARACTER_ASSET = 'assets/common/penguin.body.asset.json'

const AREA = 'character'
const FIX = 'save the character asset in SDF Modeler with exactly one upright capsule at its origin (Collider section)'
const EPS = 1e-6

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const numbers = (v: unknown, n: number): v is number[] => Array.isArray(v) && v.length === n && v.every(isNum)

/**
 * The character capsule of a saved character asset (a parsed sdfm.game-asset value): its one collider must be a capsule
 * centred on the asset origin, upright, with a positive radius and a halfHeight of 0 or more. Refuses anything else.
 */
export function parseCharacterCapsule(asset: unknown, source: string): CharacterCapsule {
  const a = typeof asset === 'object' && asset !== null ? asset as Record<string, unknown> : refuse(AREA, source, 'the character asset is not a JSON object')
  if (a.category !== 'character') refuse(AREA, `${source}/category`, `the character asset has the category ${JSON.stringify(a.category)}, expected 'character'`)
  const list = a.collision
  if (!Array.isArray(list)) refuse(AREA, `${source}/collision`, `the character asset has no collider list; ${FIX}`)
  if (list.length !== 1) refuse(AREA, `${source}/collision`, `a character collides as one capsule, the asset has ${list.length} colliders; ${FIX}`)
  const c = list[0] as Record<string, unknown>
  const at = `${source}/collision/0`
  if (typeof c !== 'object' || c === null || c.shape !== 'capsule') refuse(AREA, at, `a character collides as one capsule, the asset collider is ${JSON.stringify(c?.shape)}; ${FIX}`)
  if (!numbers(c.t, 3) || !c.t.every((x) => Math.abs(x) <= EPS)) refuse(AREA, `${at}/t`, `the character capsule must be centred on the asset origin, it is at ${JSON.stringify(c.t)}; ${FIX}`)
  if (!numbers(c.r, 4) || Math.abs(Math.abs(c.r[3]) - 1) > EPS) refuse(AREA, `${at}/r`, `the character capsule must stand upright (no rotation), it is turned ${JSON.stringify(c.r)}; ${FIX}`)
  if (!isNum(c.radius) || c.radius <= 0) refuse(AREA, `${at}/radius`, `the character capsule radius must be a number above 0, it is ${JSON.stringify(c.radius)}`)
  if (!isNum(c.halfHeight) || c.halfHeight < 0) refuse(AREA, `${at}/halfHeight`, `the character capsule halfHeight must be a number of 0 or more, it is ${JSON.stringify(c.halfHeight)}`)
  return Object.freeze({ radius: c.radius, halfHeight: c.halfHeight, stand: c.radius + c.halfHeight })
}

/** The character body every sim, bot, feature and view uses: penguin.body's saved capsule. */
export const CAPSULE: CharacterCapsule = parseCharacterCapsule(penguin, CHARACTER_ASSET)
