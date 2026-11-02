import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { sdfmText } from '../../packages/game/src/gameAsset.ts'
import { isRefusal } from '../../packages/sim/src/refusal.ts'
import { repoRoot } from '../bricks.ts'
import { loadAssetFile } from '../contentProbe.ts'
import { costumeNodeIdViolations, type GuardViolation } from '../guard.ts'
import { sharedNodeIds } from '../nodeIds.ts'

const PENGUIN_ASSET = 'assets/common/penguin.body.asset.json'
const SOURCE = 'assets/common/costume.jester-hat.asset.json'
const OLD_ID = 'jester_hat_head'
const REL = 'assets/common/costume.anchor-test.asset.json'

type Obj = Record<string, unknown>
const document = (json: Obj): Obj => json.document as Obj

// A real costume with its head anchor renamed to the requested id, references and hash kept valid.
function costumeWith(nodeId: string): Obj {
  const asset = JSON.parse(readFileSync(SOURCE, 'utf8')) as Obj
  const doc = document(asset)
  const nodes = doc.nodes as Record<string, Obj>
  const node = nodes[OLD_ID] as Obj
  delete nodes[OLD_ID]
  nodes[nodeId] = { ...node, id: nodeId, name: nodeId }
  for (const parent of Object.values(nodes)) {
    const children = parent.children
    if (Array.isArray(children)) parent.children = children.map((child) => child === OLD_ID ? nodeId : child)
  }
  asset.hash = createHash('sha256').update(sdfmText(doc)).digest('hex')
  return asset
}

function tempRoot(asset: Obj): string {
  const root = mkdtempSync(join(tmpdir(), 'rf-costume-load-'))
  mkdirSync(join(root, 'assets/common'), { recursive: true })
  copyFileSync(join(repoRoot(), PENGUIN_ASSET), join(root, PENGUIN_ASSET))
  writeFileSync(join(root, REL), JSON.stringify(asset))
  return root
}

test('asset loading rejects a costume node id the penguin already uses', async () => {
  const root = tempRoot(costumeWith('anchor_body'))
  try {
    await assert.rejects(
      loadAssetFile(REL, root),
      (e) => isRefusal(e) && /nodes\/anchor_body/.test(e.message),
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('asset loading accepts a costume node id prefixed with the costume slug', async () => {
  const root = tempRoot(costumeWith('costume_anchor_body'))
  try {
    const loaded = await loadAssetFile(REL, root)
    const body = JSON.parse(readFileSync(join(repoRoot(), PENGUIN_ASSET), 'utf8')) as Obj
    assert.deepEqual(sharedNodeIds(document(loaded.json), document(body)), [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('every committed costume loads with 0 penguin node id collisions', async () => {
  const files = readdirSync(join(repoRoot(), 'assets/common'))
    .filter((name) => /^costume\..*\.asset\.json$/.test(name))
    .map((name) => `assets/common/${name}`)
  assert.ok(files.length >= 9)
  for (const rel of files) await loadAssetFile(rel)
  const collisions: GuardViolation[] = costumeNodeIdViolations(repoRoot(), files)
  assert.deepEqual(collisions, [])
})
