// GPU-only review using the game's RAA engine, S18 skinning and real S17 sampler.
import { loadRaa } from '@etcito/raa'
import { loadRaaAnim } from '@etcito/raa-anim'
import { DEFAULT_LIGHT, DEFAULT_AMBIENT } from '../../apps/web/src/render/courseEnvironment.ts'
const require = (ok, message) => { if (!ok) throw new Error(message) }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const png = canvas => new Promise((resolve, reject) => canvas.toBlob(b => b ? resolve(b) : reject(Error('PNG encoding failed')), 'image/png'))
async function render(input) {
  const { clip: name, frames, width, height, fps } = input
  const emote = ['emote.cheer', 'emote.laugh'].includes(name)
  require(['fall', 'dive', 'waddle'].includes(name) || emote, 'Select a supported clip explicitly')
  require([1, 2, 120].includes(frames) && fps === 30, 'Use 1 frame, 2 frames or four seconds at 30 fps')
  require([[320, 180], [1280, 720]].some(([w, h]) => w === width && h === height), 'Unsupported capture size')
  const canvas = Object.assign(document.createElement('canvas'), { width, height })
  document.body.replaceChildren(canvas)
  const engine = await (await loadRaa()).createEngine(canvas, { maxInstances: 16 })
  const api = await loadRaaAnim()
  let rig, clip, stream
  try {
    const stats = engine.stats()
    require(stats.hardware && !stats.adapter.isFallbackAdapter, 'A hardware GPU is required')
    require(!/swiftshader|llvmpipe|lavapipe|software/i.test(JSON.stringify(stats.adapter)), 'Software adapter refused')
    const errors = []
    const onError = e => errors.push(String(e.message ?? e.reason))
    window.addEventListener('error', onError); window.addEventListener('unhandledrejection', onError)
    engine.resize(width, height); engine.setLight(DEFAULT_LIGHT); engine.setAmbient(DEFAULT_AMBIENT)
    const asset = await (await fetch('./penguin.body.asset.json')).json()
    const owner = asset.document.nodes.penguin
    const { bindings, smooth, ...preset } = owner.rig
    rig = api.loadRig(JSON.stringify(preset))
    const definition = owner.clips.find(c => c.name === name)
    require(definition, `Missing clip ${name}`)
    clip = api.loadClip(rig, JSON.stringify(definition))
    const buffer = await (await fetch('./penguin-fall-dive.glb')).arrayBuffer()
    const view = new DataView(buffer), jsonLength = view.getUint32(12, true)
    const gltf = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 20, jsonLength)))
    const binStart = 28 + jsonLength
    require(gltf.skins[0].joints.every((j, i) => gltf.nodes[j].name === preset.bones[i].name), 'GLB joint order differs from asset rig')
    const accessor = id => {
      const a = gltf.accessors[id], b = gltf.bufferViews[a.bufferView]
      const count = a.count * ({ SCALAR: 1, VEC3: 3, VEC4: 4 }[a.type])
      const Type = a.componentType === 5126 ? Float32Array : Uint16Array
      require(!b.byteStride || b.byteStride === Type.BYTES_PER_ELEMENT * count / a.count, 'Interleaved accessor unsupported')
      return new Type(buffer.slice(binStart + b.byteOffset + (a.byteOffset ?? 0), binStart + b.byteOffset + (a.byteOffset ?? 0) + count * Type.BYTES_PER_ELEMENT))
    }
    const p = gltf.meshes[0].primitives[0], a = p.attributes
    const mesh = engine.addMesh({ positions: accessor(a.POSITION), normals: accessor(a.NORMAL),
      colors: accessor(a.COLOR_0), joints: accessor(a.JOINTS_0), weights: accessor(a.WEIGHTS_0), indices: new Uint32Array(accessor(p.indices)) })
    const joints = accessor(a.JOINTS_0), jointCount = 1 + Math.max(...joints)
    const node = engine.addNode(null, [0, 1.65, 0])
    const instance = engine.addInstance(node, mesh, engine.addMaterial({ color: [1, 1, 1], roughness: 0.7 }))
    // A stationary platform gives the airborne poses a height cue; it never drives simulation.
    const floor = engine.loadPrimsAsset(JSON.stringify({ format: 'raa.prims', version: 0, id: 'review-floor', name: 'review-floor',
      nodes: [{ id: 'floor', kind: 'box', params: { halfExtents: [3, 0.1, 2] } }],
      materials: {}, anchors: {} }))
    engine.spawnAsset(floor.id)
    const draw = (tick, side) => {
      engine.setCamera({ eye: side ? [5.8, 3, 3.2] : [2.6, 2.6, 6.6], target: [0, 1.5, 0], fovYDeg: 38, near: 0.1, far: 50 })
      engine.setSkinPose(instance, api.sampleClip(clip, tick).skin.slice(0, jointCount * 16))
      engine.render(performance.now())
    }
    const stillTick = name === 'waddle' ? 12 : name === 'emote.cheer' ? 44 : name === 'emote.laugh' ? 24 : 16
    draw(stillTick, false)
    await sleep(100); draw(stillTick, false)
    require(engine.stats().triangles > 0, 'No rendered triangles')
    const still = await png(canvas), files = [{ name: `${name}.png`, blob: still }]
    if (frames > 1) {
      const output = Object.assign(document.createElement('canvas'), { width, height }), ctx = output.getContext('2d')
      require(ctx, 'Canvas compositor unavailable')
      stream = output.captureStream(0)
      const track = stream.getVideoTracks()[0]
      require(typeof track.requestFrame === 'function', 'Manual video frames unavailable')
      const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8'].find(m => MediaRecorder.isTypeSupported(m))
      require(mime, 'No WebM video encoder')
      const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 5000000 }), chunks = []
      const stopped = new Promise((resolve, reject) => { recorder.onstop = resolve; recorder.onerror = reject })
      recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data) }
      recorder.start()
      for (let frame = 0; frame < frames; frame++) {
        // Each emote camera receives the complete gesture, rather than a clamped resting pose.
        const tick = emote ? (frame % Math.ceil(frames / 2)) * 2 : frame * 2
        draw(tick, frame >= frames / 2)
        // PNG readback waits for the GPU submission; no rAF-dependent playback loop.
        const bitmap = await createImageBitmap(await png(canvas))
        ctx.drawImage(bitmap, 0, 0); bitmap.close()
        ctx.fillStyle = '#fff'; ctx.font = `${Math.max(14, width / 45)}px sans-serif`
        ctx.fillText(`${name} | tick ${tick} | ${frame < frames / 2 ? 'front' : 'side'} | S17 / 60 Hz`, 16, 32)
        track.requestFrame(); await sleep(1000 / fps)
      }
      recorder.stop(); await stopped
      const video = new Blob(chunks, { type: mime })
      require(video.size > 1024, 'Video encoder returned no review media')
      files.push({ name: `penguin-${name}.webm`, blob: video })
    }
    if (name === 'waddle' || emote) {
      const ref = await createImageBitmap(await (await fetch('./penguin-base-ortho.png')).blob())
      const compare = Object.assign(document.createElement('canvas'), { width: width * 2, height }), ctx = compare.getContext('2d')
      ctx.fillStyle = '#d8dde3'; ctx.fillRect(0, 0, compare.width, height)
      ctx.drawImage(await createImageBitmap(still), 0, 0)
      ctx.drawImage(ref, width, (height - width * ref.height / ref.width) / 2, width, width * ref.height / ref.width)
      ref.close(); files.push({ name: `${name}-reference.png`, blob: await png(compare) })
    }
    require(errors.length === 0, errors.join('\n'))
    window.removeEventListener('error', onError); window.removeEventListener('unhandledrejection', onError)
    return { json: { renderer: 'raa', adapter: stats.adapter, hardware: stats.hardware, clip: name,
      frames, fps, seconds: frames / fps, sampleHz: 60, rootMotion: definition.rootMotion, files: files.map(f => f.name) }, files }
  } finally { stream?.getTracks().forEach(t => t.stop()); clip?.free(); rig?.free(); engine.dispose() }
}
window.nmcGpu = { ops: { render } }
