import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { decodeMesh as decodeMeshFile } from '../../apps/web/src/sdf/meshWire.ts';
import { loadAnimBrick } from '../../packages/game/src/anim/brick.ts';
const asset = JSON.parse(readFileSync('assets/common/penguin.body.asset.json', 'utf8')).document.nodes.penguin;
const { bindings, smooth, ...preset } = asset.rig;
const api = await loadAnimBrick(), rig = api.loadRig(JSON.stringify(preset));
const file = process.argv[2] ?? 'assets/common/penguin.body.mesh';
const saved = decodeMeshFile(new Uint8Array(readFileSync(file)));
const parts = saved.data.groups.flatMap(g => g.parts).filter(p => p.skin);
const summaries = [];
let maxGap = 0, maxWeightDelta = 0, vertices = 0, distinct = 0, differing = 0, boundary = 0, animatedBoundaryMax = 0;
const prepared = parts.map(part => {
    const positions = Float32Array.from(part.meshes.flatMap(m => Array.from(m.positions))), groups = new Map(), edges = [], ids = [];
    for (let v = 0; v < positions.length / 3; v++) {
        const key = Array.from(positions.slice(v * 3, v * 3 + 3)).join(',');
        if (!groups.has(key))
            groups.set(key, []);
        groups.get(key).push(v);
        ids[v] = key;
    }
    let base = 0;
    for (const m of part.meshes) {
        for (let i = 0; i < m.indices.length; i += 3)
            for (let k = 0; k < 3; k++)
                edges.push([base + m.indices[i + k], base + m.indices[i + (k + 1) % 3]]);
        base += m.positions.length / 3;
    }
    const countBoundary = keys => { const counts = new Map(); for (const [a, b] of edges) {
        const x = keys[a], y = keys[b];
        if (x === y)
            continue;
        const key = x < y ? `${x}|${y}` : `${y}|${x}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
    } return [...counts.values()].filter(n => n === 1).length; };
    boundary += countBoundary(ids);
    vertices += positions.length / 3;
    distinct += groups.size;
    const vector = v => { const w = new Map(); for (let k = 0; k < 4; k++) {
        const i = v * 4 + k;
        if (part.skin.weights[i])
            w.set(part.skin.joints[i], part.skin.weights[i]);
    } return w; };
    for (const vs of groups.values()) {
        let delta = 0;
        for (const reference of vs) {
            const first = vector(reference);
            for (const v of vs) {
                const w = vector(v);
                for (const j of new Set([...first.keys(), ...w.keys()]))
                    delta = Math.max(delta, Math.abs((first.get(j) ?? 0) - (w.get(j) ?? 0)));
            }
        }
        if (delta)
            differing++;
        maxWeightDelta = Math.max(maxWeightDelta, delta);
    }
    return { part, positions, groups, countBoundary };
});
try {
    for (const definition of asset.clips) {
        const clip = api.loadClip(rig, JSON.stringify(definition));
        let gap = 0, cracks = 0;
        const ticks = [];
        try {
            for (let sample = 0; sample <= 8; sample++) {
                const tick = Math.round(definition.lengthTicks * sample / 8);
                ticks.push(tick);
                const pose = api.sampleClip(clip, tick), mat = pose.skin;
                for (const { part, positions, groups, countBoundary } of prepared) {
                    const out = [];
                    for (let v = 0; v < positions.length / 3; v++) {
                        const p = [0, 0, 0];
                        for (let k = 0; k < 4; k++) {
                            const w = part.skin.weights[v * 4 + k];
                            if (!w)
                                continue;
                            const o = part.skin.joints[v * 4 + k] * 16;
                            for (let a = 0; a < 3; a++)
                                p[a] += w * (mat[o + a] * positions[v * 3] + mat[o + 4 + a] * positions[v * 3 + 1] + mat[o + 8 + a] * positions[v * 3 + 2] + mat[o + 12 + a]);
                        }
                        const f = part.frame;
                        out.push([0, 1, 2].map(a => f[a] * p[0] + f[4 + a] * p[1] + f[8 + a] * p[2] + f[12 + a]));
                    }
                    for (const vs of groups.values())
                        for (const reference of vs)
                            for (const v of vs)
                                gap = Math.max(gap, Math.hypot(...out[v].map((x, a) => x - out[reference][a])));
                    cracks = Math.max(cracks, countBoundary(out.map(p => p.join(','))));
                }
            }
        }
        finally {
            clip.free();
        }
        maxGap = Math.max(maxGap, gap);
        animatedBoundaryMax = Math.max(animatedBoundaryMax, cracks);
        summaries.push({ clip: definition.name, ticks, maxGap: gap, boundaryEdgesMax: cracks });
    }
}
finally {
    rig.free();
}
const result = { file, vertices, distinctPositions: distinct, differingWeightGroups: differing, maxWeightDelta, boundaryEdges: boundary, maxGap, animatedBoundaryMax, epsilon: 1e-7, clips: summaries };
console.log(JSON.stringify(result, null, 2));
if (process.argv[3])
    writeFileSync(process.argv[3], JSON.stringify(result, null, 2) + '\n');
if (!process.env.M13_BASELINE) {
    assert.equal(differing, 0);
    assert(maxGap < 1e-7);
    assert.equal(boundary, 0);
    assert.equal(animatedBoundaryMax, 0);
    assert(vertices <= 1700, `vertex count ${vertices}, baseline 4664`);
}
