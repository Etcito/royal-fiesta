// ?scale=<0.25..1> (default 1): multiplies the backing size of every WebGPU canvas of the page (start scene, show, UI);
// raa sizes its G-buffer, depth and MSAA targets from the canvas size, so they follow. A pure URL parameter, nothing stored.
function read(): number {
  if (typeof location === 'undefined') return 1
  const v = Number(new URLSearchParams(location.search).get('scale'))
  return Number.isFinite(v) && v > 0 ? Math.min(1, Math.max(0.25, v)) : 1
}
export const renderScale: number = read()
