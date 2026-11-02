// Column-major affine pose math. Write into retained pose arrays instead of allocating per bone.
export function multiplyInto(out: Float32Array, o: number, a: ArrayLike<number>, ai: number, b: ArrayLike<number>, bi: number): void {
  // Every pose matrix is affine. Its last row is [0,0,0,1].
  for (let c = 0; c < 4; c++) {
    const x = b[bi + c * 4], y = b[bi + c * 4 + 1], z = b[bi + c * 4 + 2]
    for (let r = 0; r < 3; r++)
      out[o + c * 4 + r] = a[ai + r] * x + a[ai + 4 + r] * y + a[ai + 8 + r] * z + (c === 3 ? a[ai + 12 + r] : 0)
    out[o + c * 4 + 3] = c === 3 ? 1 : 0
  }
}
export function localMatrixInto(out: Float32Array, o: number, local: ArrayLike<number>, i: number): void {
  const x = local[i + 3], y = local[i + 4], z = local[i + 5], w = local[i + 6], sx = local[i + 7], sy = local[i + 8], sz = local[i + 9]
  out[o] = (1 - 2 * y * y - 2 * z * z) * sx
  out[o + 1] = (2 * x * y + 2 * z * w) * sx
  out[o + 2] = (2 * x * z - 2 * y * w) * sx
  out[o + 3] = 0
  out[o + 4] = (2 * x * y - 2 * z * w) * sy
  out[o + 5] = (1 - 2 * x * x - 2 * z * z) * sy
  out[o + 6] = (2 * y * z + 2 * x * w) * sy
  out[o + 7] = 0
  out[o + 8] = (2 * x * z + 2 * y * w) * sz
  out[o + 9] = (2 * y * z - 2 * x * w) * sz
  out[o + 10] = (1 - 2 * x * x - 2 * y * y) * sz
  out[o + 11] = 0
  out[o + 12] = local[i]
  out[o + 13] = local[i + 1]
  out[o + 14] = local[i + 2]
  out[o + 15] = 1
}
