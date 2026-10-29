// Encode only PNGs read back from the hardware-rendered canvas. No display-clock
// captureStream/MediaRecorder dependency, including for the two-frame probe.
export const frameName = index => `frame-${String(index).padStart(4, '0')}.png`

export async function captureFrameSequence({ frames, fps }, capture) {
  if (![2, 120].includes(frames) || fps !== 30) throw Error('Expected two frames or four seconds at 30 fps')
  const files = []
  for (let frame = 0; frame < frames; frame++) {
    const side = frame >= frames / 2
    const tick = (frame % (frames / 2)) * 2
    const blob = await capture({ frame, tick, side })
    if (!blob?.size || blob.type !== 'image/png') throw Error(`Missing GPU PNG frame ${frame}`)
    files.push({ name: frameName(frame), blob })
  }
  return { files, video: { format: 'png-sequence', pattern: 'frame-%04d.png', frames, fps } }
}
