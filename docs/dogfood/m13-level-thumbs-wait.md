# Level thumbnail timing and restart cache

Programmatic card 6566 should select `m13-build`, `m13-level-thumbs-tests`,
`m13-level-thumbs`, `m13-level-thumbs-cache-check`, and `m13-vote`.
The existing protected entries and dependency chains are unchanged.

`m13-level-thumbs` calls SDF Modeler's `course_save`, whose render route submits
one GPU job per call. The loop awaits each call before starting another. It uses
SDF Modeler's GPU client, rather than duplicating that render with a separate
GPU CLI call. No model card launches these jobs.

On a cold cache Butterfly Freeway runs first with the explicit 300000 ms job
ceiling. Its actual course_save elapsed time selects the subsequent wait:
ceil((elapsed * 1.5 + 15000) / 1000) * 1000 ms, capped at 300000 ms. This gives
measured headroom without relying on the 120-second default. If Butterfly
cannot finish within the ceiling, the step stops with the first full error;
there is no automatic retry or fallback. Timing has not been measured by the
model card: it is measured by the programmatic run before other levels render.

Each completed opaque AVIF is atomically cached under NMC_CACHE_DIR, keyed by
course and recursively referenced asset content. Timing is saved alongside it.
The checkout receives only relative thumbnail references for content packing.
A fresh checkout reuses these entries; changed levels get new entries. The
cache-only step refuses any missing entry without submitting GPU work.

The render and cache-check JSON reports record level status and timing, without
machine paths or image files. No thumbnail PNG is added to artifacts.
`m13-vote` retains its existing mouse, keyboard, gamepad, loaded-thumbnail,
page-error and failed-request checks, and packs the restored thumbnails.
