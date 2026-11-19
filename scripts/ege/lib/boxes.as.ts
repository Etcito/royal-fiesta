export function inBox(cx: f64, cy: f64, cz: f64, hx: f64, hy: f64, hz: f64, px: f64, py: f64, pz: f64): bool {
  return Math.abs(px - cx) <= hx && Math.abs(py - cy) <= hy && Math.abs(pz - cz) <= hz
}
