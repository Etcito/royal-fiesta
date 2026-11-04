declare module 'virtual:rf-mama' { export function loadMama(): Promise<unknown>; export function loadRenderOptions(): Promise<unknown>; export const MAMA_PRESENT: boolean; export const FIELD_PROGRAM_WGSL: string | null
  // MAMA core/game/render-options.ts as the SDF port applies it (the shading and the bake), null in a public clone. Typed
  // structurally: the public clone has no MAMA types.
  export interface RfGameRenderOptions { shading: 'field' | 'vertex' | 'baked'; bakeTexelDensity: number; bakeMaxSize: number }
  export const GAME_RENDER_OPTIONS: {
    validate(input: unknown): { options: RfGameRenderOptions; issues: { key: string; message: string; fix: string }[] }
    specs: readonly { key: string; kind: string }[]
    bakeTextureSize(scale: number, options: RfGameRenderOptions): number
  } | null
}
declare const __RF_MAMA__: string
declare const __RF_RAA_SDFM__: string
