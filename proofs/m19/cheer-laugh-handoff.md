# Cheer/laugh encoder correction for programmatic card 5740

Card 5739 failed in `emote.cheer-two-frame` with
`Video encoder returned no review media`. The browser used `MediaRecorder`
and rejected any result of 1024 bytes or less. The earlier fall/dive helper
builds the same explicit `{clip, width, height, fps, frames}` input, so copying
its input shape would retain the failing recorder path.

The emotes now return PNG sequences read back from the hardware-rendered RAA
canvas. The input additionally specifies `videoFormat: "png-sequence"`.
Every frame has an ordered filename, and the result declares its frame count,
pattern and fps. The programmatic executor encodes those returned PNGs with
ffmpeg at an explicit 30 fps and checks the decoded frame count, dimensions
and duration using ffprobe. No CPU pose rendering or display-clock recording
is involved. The existing fall/dive recording path is preserved.

The sequence remains four seconds per emote: 120 frames at 1280x720, with the
complete gesture sampled from tick 0 through 118 for each of two cameras.
The executor first runs the blank-page probe and each emote's one-frame and
two-frame probes. It must decode both frames of the two-frame encoded probe
before submitting that emote's full capture. Both returned segments are
combined into `proofs/m19/penguin-cheer-laugh.mp4` with the existing eight-second
duration requirement. Submission, execution, PNG frames and encoding records
are retained under `proofs/m19/cheer-laugh-execution/`.

The actual checkout contained fourteen queued commands. Following the latest
operator instruction, `.nmc/commands.json` now contains exactly four unique
entries: bundle, video, cheer judge and laugh judge. Their names are unchanged,
and every dependency names an earlier entry. The video helper also captures a
fresh mid-waddle still and invokes the prescribed mid-waddle judge with its
exact original description, `/refs/penguin-base-ortho.png` and minimum score 6.
It saves that judge's output and exit status alongside the capture records.
Both emote judge commands retain their original descriptions and score of 6.

Local verification on 2026-10-29:

- `npm run typecheck` and `npm run build` passed.
- `node --experimental-strip-types proofs/m19/cheer-laugh-capture.mjs --build`
  built the GPU bundle without submitting a job.
- All six capture regression tests passed, including two-frame output, both
  complete camera timelines, missing-frame rejection and queue/judge checks.
- All 33 affected contentFiles, courseV1 and gameAsset tests passed.
- `cheer-laugh-check.mjs` against wave/dance baseline `d74d5a6` passed: all fifteen
  unique S19 clips load and sample, both gestures satisfy their numeric checks,
  and the inherited geometry, rig, bindings, attachments and clips are intact.
- A codec-only smoke test in `/tmp` used a solid PNG fixture, first one frame
  then two. ffprobe decoded exactly 1 and 2 frames at the expected dimensions
  and durations (0.033 and 0.066 seconds). These valid WebM files were 544 and
  568 bytes, illustrating why byte size cannot validate a two-frame probe.
  The temporary fixtures were deleted and are not penguin review evidence.

No source clip, rig, attachment, geometry or existing animation export changed.
The playable GLB sequence and registered-operation authoring transcripts from
earlier runs remain in the repository. Laugh retains Q7's rhythmic body/head
motion with its beak rigidly bound to the head.

Card **5740** must execute the four queued commands on the hardware GPU and
return the MP4, capture records and all three judge outcomes. This model card
has submitted no GPU job and claims no new GPU result or visual approval.
