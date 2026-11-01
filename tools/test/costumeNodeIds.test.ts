import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { isRefusal } from '../../packages/sim/src/refusal.ts'
import { loadAssetFile } from '../contentProbe.ts'
import { costumeNodeIdViolations } from '../guard.ts'
import { sharedNodeIds } from '../nodeIds.ts'
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
    writeFileSync(join(root, file), JSON.stringify({ document: document(hat) }))
    assert.deepEqual(costumeNodeIdViolations(root, [file]), [])
    assert.deepEqual(sharedNodeIds(document(hat), document(body)), [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
