import { readFileSync, writeFileSync } from 'node:fs'
const orig = '/root/nmc/worktrees/78/5617/assets/common/penguin.body.asset.json'
const text = readFileSync(orig, 'utf8')
const o = JSON.parse(text), s = JSON.parse(readFileSync('/tmp/env/game/assets/common/penguin.body.asset.json', 'utf8'))
const find = (d) => { const n = Object.values(d.document.nodes).find((n) => n.id === 'penguin'); return n }
const oc = find(o).clips, sc = find(s).clips
console.log('orig clips', oc.map((c) => c.name), 'saved', sc.map((c) => c.name))
for (let i = 0; i < oc.length; i++) if (JSON.stringify(oc[i]) !== JSON.stringify(sc[i])) { console.log('DIFF clip', oc[i].name); process.exit(1) }
console.log('first', oc.length, 'identical')
console.log('rig same', JSON.stringify(find(o).rig) === JSON.stringify(find(s).rig))
const fmt = (c) => '          {"format":"raa.clip","version":2,"name":' + JSON.stringify(c.name) + ',"rig":' + JSON.stringify(c.rig) + ',"lengthTicks":' + c.lengthTicks + ',"loop":' + c.loop + ',"rootMotion":' + JSON.stringify(c.rootMotion) + ',"tracks":[\n' +
  c.tracks.map((t) => '            {"bone":' + JSON.stringify(t.bone) + ',"channel":' + JSON.stringify(t.channel) + ',"keys":[\n' +
    t.keys.map((k) => '              ' + JSON.stringify(k)).join(',\n') + '\n            ]}').join(',\n') + '\n          ],"events":' + JSON.stringify(c.events) + '}'
const add = sc.slice(oc.length)
console.log('adding', add.map((c) => c.name), Object.keys(add[0]))
const marker = '],"events":[]}\n        ],\n        "gameCollision": true'
const idx = text.lastIndexOf(marker)
if (idx < 0 || text.indexOf(marker) !== idx) { console.log('marker problem'); process.exit(1) }
const head = text.slice(0, idx + '],"events":[]}'.length)
const out = head + ',\n' + add.map(fmt).join(',\n') + text.slice(idx + '],"events":[]}'.length)
writeFileSync('/tmp/env/merged.json', out)
const m = JSON.parse(out)
console.log('merged clips', find(m).clips.map((c) => c.name), 'deepEq new', add.every((c, i) => JSON.stringify(find(m).clips[oc.length + i]) === JSON.stringify(c)))
