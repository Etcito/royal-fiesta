import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { isRefusal } from '../../packages/sim/src/refusal.ts'
import { repoRoot } from '../bricks.ts'
import { loadAssetFile, mountedBounds } from '../contentProbe.ts'
import { checkPaths, costumeNodeIdViolations } from '../guard.ts'
import { sharedMaterialIds, sharedNodeIds } from '../nodeIds.ts'
import { mergeDocuments } from '../renderViews.ts'

const PENGUIN = 'assets/common/penguin.body.asset.json'
const JESTER = 'assets/common/costume.jester-hat.asset.json'
const OLD_ID = 'head'
const NEW_ID = 'jester_hat_head'

type Obj = Record<string, unknown>
const document = (a: { json: Obj }): Obj => a.json.document as Obj

// The same rename the fixed asset carries, applied to a copy so the old collision is reproducible.
function collidingJester(fixed: Obj): Obj {
  const doc = structuredClone(fixed) as Obj
  const nodes = doc.nodes as Record<string, Obj>
  const renamed = nodes[NEW_ID] as Obj
  nodes[OLD_ID] = { ...renamed, id: OLD_ID, name: OLD_ID }
  delete nodes[NEW_ID]
  const parent = nodes.jester_hat as { children: string[] }
  parent.children = parent.children.map((id) => id === NEW_ID ? OLD_ID : id)
  return doc
}

test('the fixed Jester Hat has no node id the penguin uses', async () => {
  const body = await loadAssetFile(PENGUIN)
  const hat = await loadAssetFile(JESTER)
  assert.deepEqual(sharedNodeIds(document(hat), document(body)), [])
  const merged = mergeDocuments(document(body), [{ document: document(hat), offset: [0, 0, 0], rel: JESTER }])
  const nodes = merged.nodes as Record<string, unknown>
  assert.ok(nodes[NEW_ID], 'the renamed head anchor node is merged')
  assert.equal(nodes[OLD_ID], (document(body).nodes as Record<string, unknown>)[OLD_ID], 'the penguin head node is kept, not overwritten')
})

test('a costume reusing the penguin head id is reported and refused', async () => {
  const body = await loadAssetFile(PENGUIN)
  const hat = await loadAssetFile(JESTER)
  const colliding = collidingJester(document(hat))
  assert.deepEqual(sharedNodeIds(colliding, document(body)), [OLD_ID])
  assert.throws(
    () => mergeDocuments(document(body), [{ document: colliding, offset: [0, 0, 0], rel: JESTER }]),
    (e) => isRefusal(e) && /nodes\/head/.test(e.message),
  )
})

test('the staged guard reports a colliding costume and passes the fixed Jester Hat', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rf-costume-'))
  try {
    mkdirSync(join(root, 'assets/common'), { recursive: true })
    writeFileSync(join(root, PENGUIN), readFileSync(PENGUIN, 'utf8'))
    const body = await loadAssetFile(PENGUIN)
    const hat = await loadAssetFile(JESTER)
    const file = 'assets/common/costume.jester-hat.asset.json'
    writeFileSync(join(root, file), JSON.stringify({ document: collidingJester(document(hat)) }))
    const bad = costumeNodeIdViolations(root, [file])
    assert.equal(bad.length, 1)
    assert.equal(bad[0]!.rule, 'costume-node-id-collision')
    assert.match(bad[0]!.detail, /'head'/)
    const validated = checkPaths(root, [file]).filter((v) => v.rule === 'costume-node-id-collision')
    assert.equal(validated.length, 1)
    writeFileSync(join(root, file), readFileSync(JESTER, 'utf8'))
    assert.deepEqual(costumeNodeIdViolations(root, [file]), [])
    assert.deepEqual(checkPaths(root, [file]), [])
    assert.deepEqual(sharedNodeIds(document(hat), document(body)), [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

const M13_COSTUMES = [
  'assets/common/costume.cloud-skirt.asset.json',
  'assets/common/costume.disco-jacket.asset.json',
  'assets/common/costume.dragon-suit.asset.json',
  'assets/common/costume.ghost-aura.asset.json',
  'assets/common/costume.golden-crown.asset.json',
  'assets/common/costume.jester-hat.asset.json',
  'assets/common/costume.jetpack.asset.json',
  'assets/common/costume.neon-sneakers.asset.json',
  'assets/common/costume.sparkler-wand.asset.json',
]

test('all nine M13 costumes pass the guard rule against the penguin', async () => {
  assert.deepEqual(costumeNodeIdViolations(repoRoot(), M13_COSTUMES), [])
  const body = await loadAssetFile(PENGUIN)
  for (const rel of M13_COSTUMES) {
    const costume = await loadAssetFile(rel)
    assert.deepEqual(sharedNodeIds(document(costume), document(body)), [], rel)
  }
})

test('a costume reusing a penguin material id fails the guard, as the views render would refuse it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rf-costume-'))
  try {
    mkdirSync(join(root, 'assets/common'), { recursive: true })
    writeFileSync(join(root, PENGUIN), readFileSync(PENGUIN, 'utf8'))
    const body = await loadAssetFile(PENGUIN)
    const hat = await loadAssetFile(JESTER)
    const doc = structuredClone(document(hat))
    const materials = doc.materials as Obj
    materials['penguin-beak'] = materials.gold
    writeFileSync(join(root, JESTER), JSON.stringify({ document: doc }))
    const bad = checkPaths(root, [JESTER]).filter((v) => v.rule === 'costume-material-id-collision')
    assert.equal(bad.length, 1)
    assert.match(bad[0]!.detail, /'penguin-beak'/)
    assert.deepEqual(sharedMaterialIds(doc, document(body)), ['penguin-beak'])
    assert.throws(
      () => mergeDocuments(document(body), [{ document: doc, offset: [0, 0, 0], rel: JESTER }]),
      (e) => isRefusal(e) && /materials\/penguin-beak/.test(e.message),
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('every costume asset has unique node ids and mounts into the penguin render document', async (t) => {
  const costumes = readdirSync(join(repoRoot(), 'assets/common'))
    .filter((f) => /^costume\..+\.asset\.json$/.test(f))
    .map((f) => `assets/common/${f}`)
  assert.ok(costumes.length >= M13_COSTUMES.length)
  const body = await loadAssetFile(PENGUIN)
  const bodyDocument = document(body)
  for (const rel of costumes) {
    await t.test(rel, async () => {
      const json = JSON.parse(readFileSync(join(repoRoot(), rel), 'utf8')) as Obj
      const ids = sharedNodeIds(json.document, bodyDocument)
      assert.deepEqual(ids, [], `${rel}: node ids also used by the penguin: ${ids.join(', ')}`)
      const costume = await loadAssetFile(rel)
      const bounds = mountedBounds(costume, body)
      const min = costume.asset.bounds.min
      mergeDocuments(bodyDocument, [{
        document: document(costume),
        offset: [bounds.min[0] - min.x, bounds.min[1] - min.y, bounds.min[2] - min.z],
        rel,
      }])
    })
  }
  assert.deepEqual(costumeNodeIdViolations(repoRoot(), costumes), [])
})
