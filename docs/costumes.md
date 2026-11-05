# Costume assets

A costume (`assets/<world>/costume.<slug>.asset.json`) is merged into `penguin.body` for the wardrobe and
the views render. Its document nodes live beside the penguin's nodes, so a costume node id that names the
same part as a penguin node must carry the costume slug:

- `dragon_suit_anchor_body`, not `anchor_body` (the body's own anchor)
- `disco_jacket_anchor_body`, not `anchor_body`
- `cloud_skirt_body`, `neon_sneakers_body`, not `body`

Never copy a penguin node id (`body`, `anchor_body`, `head`, `neck`, ...) into a costume: the merge
overwrites the penguin node it matches.

The authoring asset load (`tools/contentProbe.ts`), `tools/renderViews.ts` and the commit guard all refuse a
costume node id the penguin uses. Fix a collision by renaming the node and every `root`/`children`
reference, then save the asset again with SDF Modeler so its hash matches the document.

Sides are the penguin's own sides: it faces +z, its left is +x (`upper.l` rests at
`[0.48, 0.35, 0]`), and its right is -x. Names such as `left_shoulder`, `left_cuff`
and `.l` always mean the penguin's left, even when viewed from the front. Existing
bound node ids stay stable; the jester hat's legacy bell ids retain their bindings,
while their display names use the penguin's side.

Penguin-bound costumes use MAMA's nearest rest-bone segment weights per vertex.
An explicit shape binding overrides that shape; a subgroup binding overrides its
descendants, with a shape binding taking priority. Properties > Rigging and
`node_rig_get` / `node_rig_set` report a rest-frame side mismatch and suggest the
mirror bone; the panel's `use <mirror>` button applies that correction.
Broad torso panels and their attached decorations are explicitly bound to `root`,
so raising the arms does not stretch the torso toward the shoulders. Sleeves and
cuffs retain their local arm/leg weights.
Hat components follow `head` (the jester's horn overrides retain their extra bones),
the scarf follows the neck/head, and the wand's individual components follow `tip.r`.

A binding on the costume's asset root is legacy mounting metadata and is ignored
for skinning, including old references with an extra `outfit` bone at the root.
Old documents load without a rewrite: unbound geometry follows the penguin and
specific node bindings remain active. Extra bones stay available for explicit
bindings (for example the jester horns); they do not attract automatic weights.
The costume skin cache version invalidates older weight caches (the game rebuilds
them through MAMA on load, without requiring a re-save). Save/re-mesh with
SDF Modeler to refresh shipped `.mesh` files and thumbnails. The game consumes
those same skin streams and routes each inherited bone's pose individually.
