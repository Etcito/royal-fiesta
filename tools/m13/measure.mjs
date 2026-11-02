import { readFileSync, writeFileSync } from 'node:fs';
import { decodeMesh as decodeMeshFile } from '../../apps/web/src/sdf/meshWire.ts';
const file = process.argv[2] ?? 'assets/common/penguin.body.mesh';
const m = decodeMeshFile(new Uint8Array(readFileSync(file)));
const parts = m.data.groups.flatMap(g => g.parts);
let vertices = 0, distinct = 0, differing = 0, maxWeightDelta = 0, boundary = 0, normalDistinct = 0;
for (const part of parts) {
    const groups = new Map(), edges = new Map(), attrs = new Set();
    let base = 0;
    const ids = [];
    for (const mesh of part.meshes) {
        for (let v = 0; v < mesh.positions.length / 3; v++) {
            const p = Array.from(mesh.positions.slice(v * 3, v * 3 + 3)), key = p.join(',');
            let g = groups.get(key);
            if (!g) {
                g = { id: groups.size, ws: [] };
                groups.set(key, g);
            }
            ids[base + v] = g.id;
            const w = new Map();
            for (let k = 0; k < 4; k++)
                if (part.skin?.weights[(base + v) * 4 + k])
                    w.set(part.skin.joints[(base + v) * 4 + k], part.skin.weights[(base + v) * 4 + k]);
            g.ws.push(w);
            attrs.add(key + '|' + Array.from(mesh.normals.slice(v * 3, v * 3 + 3)).join(',') + '|' + mesh.material);
        }
        for (let i = 0; i < mesh.indices.length; i += 3)
            for (let k = 0; k < 3; k++) {
                const a = ids[base + mesh.indices[i + k]], b = ids[base + mesh.indices[i + (k + 1) % 3]];
                if (a === b)
                    continue;
                const key = a < b ? `${a},${b}` : `${b},${a}`;
                edges.set(key, (edges.get(key) ?? 0) + 1);
            }
        base += mesh.positions.length / 3;
    }
    for (const g of groups.values()) {
        let delta = 0;
        for (const w of g.ws)
            for (const other of g.ws)
                for (const j of new Set([...w.keys(), ...other.keys()]))
                    delta = Math.max(delta, Math.abs((w.get(j) ?? 0) - (other.get(j) ?? 0)));
        if (delta > 0)
            differing++;
        maxWeightDelta = Math.max(maxWeightDelta, delta);
    }
    vertices += base;
    distinct += groups.size;
    normalDistinct += attrs.size;
    boundary += [...edges.values()].filter(n => n === 1).length;
}
const out = { file, vertices, distinctPositions: distinct, distinctPositionNormalMaterial: normalDistinct, differingWeightGroups: differing, maxWeightDelta, boundaryEdges: boundary };
console.log(JSON.stringify(out, null, 2));
if (process.argv[3])
    writeFileSync(process.argv[3], JSON.stringify(out, null, 2) + '\n');
