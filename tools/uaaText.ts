// Correct the pinned uaa renderer's WGSL before bundling, without modifying an
// installed dependency. The signed-distance field saturates at range / 2;
// leave half a device pixel for antialiasing so empty atlas texels have alpha 0.
export function fixUaaTextShader(source: string): string {
  const broken = 'let w = min(t.xfT.z * pr, range * 0.5);'
  const fixed = 'let w = min(t.xfT.z * pr, max(0.0, range * 0.5 - 0.5));'
  if (source.includes(fixed)) return source
  if (!source.includes('fn fs_text') || source.split(broken).length !== 2) {
    throw new Error('uaa text shader changed: review the MSDF outline range fix')
  }
  return source.replace(broken, fixed)
}
