# Cheer/laugh handoff to programmatic card 5739

Revalidated on 2026-10-29 from repository revision `95e13a3`.
The registered-operation authoring is already integrated in the source asset;
this continuation preserves the asset and the existing animation binaries.
Authoring transcripts remain under `proofs/m19/provisioning-5620/`.

`.nmc/commands.json` has been written with all fourteen existing entries,
preserving every name, command, dependency and timeout. Only JSON formatting
changed. Names are unique and dependencies point to earlier entries. The
separate `.nmc/cheer-laugh.commands.json` is absent. The operator's explicit
requirement to preserve every entry takes precedence over the generic
limit of ten entries. All three judges retain the reference, descriptions
and minimum score of 6, including the required in-game mid-waddle judge.

Card **5739** must execute the queue and return
`proofs/m19/penguin-cheer-laugh.mp4`, submission/execution/capture records
under `proofs/m19/cheer-laugh-execution/`, reference comparisons and judge
results. The capture helper explicitly selects each emote, probes one frame
then two frames, captures four seconds per emote on hardware, and combines
the returned frames into the eight-second MP4. Its bundle and execution
records retain the source revision, asset revision and saved asset hash.
The expected media paths are registered in `.nmc/artifacts.json`.

Existing real animation deliverables were parsed and validated in this run:

- `penguin-cheer-laugh.glb`: both emotes, 371684 bytes.
- `penguin-emote.cheer.glb`: 109 samples, 1.8 seconds, 346668 bytes.
- `penguin-emote.laugh.glb`: 97 samples, 1.6 seconds, 344012 bytes.

Local verification passed:

- `npm run typecheck` and `npm run build`.
- The isolated SDF Modeler document/rigged serializer regressions (2 tests).
- contentFiles, courseV1, gameAsset and capture parser suites (31 tests).
- Runtime gesture/preservation check against wave/dance baseline `d74d5a6`:
  fifteen unique S19 names load and sample; both flippers rise above the head;
  laugh coordinates body/head motion with the beak rigidly following the head
  under Q7. The entire inherited asset is preserved, including rig, bindings,
  attachments, geometry, earlier clips and saved-hash compatibility.
- Queue equivalence to the inherited queue and `git diff --check`.

No GPU command or judge ran on this model card. The review MP4 and hardware
records have not yet been returned; rendered-media approval remains pending
card 5739. Finish this model card without submitting or waiting for a GPU job.
