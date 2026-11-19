// Source: packages/sim/src/vec.ts:146 (degrees to radians).
export function degToRad(deg: f64): f64 {
  return deg * (Math.PI / 180.0)
}

// Source: packages/sim/src/features/params.ts:129 ticksParam rule (round(s * 60)).
export function ticksOf(seconds: f64): i32 {
  return <i32>Math.round(seconds * 60.0)
}

// Source: packages/sim/src/features/params.ts:129 uses the 60 Hz tick rate.
export const TICK_DT: f64 = 1.0 / 60.0
