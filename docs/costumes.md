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
