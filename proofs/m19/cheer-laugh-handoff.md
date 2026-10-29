# Cheer/laugh handoff to programmatic card 5739

This continuation adds a real playable animation file:
`proofs/m19/penguin-cheer-laugh-sequence.glb` (416852 bytes).
Its single `cheer-then-laugh` timeline plays the complete 1.8-second cheer,
then the complete 1.6-second laugh, sharing their neutral boundary pose.
The file includes the inherited penguin mesh, skin and materials.
It can be reviewed by playing one animation in a glTF viewer.

Regenerate with:

```
node --experimental-strip-types proofs/m19/cheer-laugh-sequence.mjs --frames=1
node --experimental-strip-types proofs/m19/cheer-laugh-sequence.mjs --frames=2
node --experimental-strip-types proofs/m19/cheer-laugh-sequence.mjs
```

The exporter samples the existing SDF Modeler-authored clips through the
game's pinned S17 runtime. It creates no new source clips and performs no
rendering. One-frame and two-frame probes passed before the full export.
The saved binary's 205 frames and 11070 channel values were verified
against runtime samples, including the cheer/laugh boundary. Mesh, skin,
nodes and inherited binary data were preserved. The binary is registered
in `.nmc/artifacts.json` for inclusion in the task commit.

The source asset remains the registered-operation deliverable from
`a58991f`; authoring transcripts are in `proofs/m19/provisioning-5620/`.
The earlier individual and combined animation exports remain intact.
Runtime verification against wave/dance baseline `d74d5a6` confirms:

- All fifteen exact S19 names load and sample, without duplicate names.
- Cheer raises both flipper tips above the head in a broad V and pumps twice.
- Laugh coordinates rhythmic body and head motion; the beak follows the head
  rigidly under Q7. No independent jaw articulation is claimed.
- Rig, bindings, attachments, geometry and every earlier clip are preserved.

Local checks passed on this continuation: `npm run typecheck`, `npm run build`,
the isolated rigged-document serializer test, and all 31 tests in contentFiles,
courseV1, gameAsset and the capture-result parser suites. The runtime gesture
check and full sequence binary round-trip passed as described above.

The programmatic queue `.nmc/commands.json` already contains all fourteen
required entries and remains byte-for-byte unchanged. All names are unique,
and dependencies refer to earlier entries. The operator's explicit instruction
to preserve every entry takes precedence over the generic ten-entry limit.
There is no remaining `.nmc/cheer-laugh.commands.json` to merge or remove.
All three judges retain their descriptions, reference and minimum score of 6,
including the prescribed in-game mid-waddle judge.

Card **5739** must execute that queue and return
`proofs/m19/penguin-cheer-laugh.mp4`, hardware submission/execution/capture
records under `proofs/m19/cheer-laugh-execution/`, reference comparisons and
judge results. Its capture helper explicitly selects each emote, probes one
frame then two frames, captures four seconds per emote on hardware, and
combines the returned frames into the eight-second MP4. Its records retain
the source revision, asset revision and saved asset hash.

The GLB sequence is animation media, not rendered approval evidence.
No GPU command or judge ran on this model card. The review MP4 and hardware
records remain the responsibility of card 5739; finish this model card
without submitting or waiting for that job.
