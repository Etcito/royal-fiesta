# Audio: existing sounds, audit, and the M2 redesign

This document is the M1 sound audit for Royal Fiesta. It inventories every sound source that
exists in the code today, says how to render and measure it, records what is wrong per sound,
states what the M2 sound redesign must contain, confirms the S16 event-to-sound table, and
plans the mix. HAA is the sound engine; the game content lives in this repository.

## 1. Inventory

### 1.1 The v0.1 pack families (`packages/game/src/audio/pack/families.ts`)

`FIESTA_FAMILIES` has six families. `fiestaFamily` defines each one with `defineFamily`, bus
`effects`, category `fx`, 8 seeded variants, the default seed `hashSeed('family', id)`. A
render draws a jitter record (pitch, timing, balance, decay), mixes at least three layers
through a scratch buffer, DC-blocks the written length, normalises the peak to -6 dBFS and
ends with a 0.012 s cosine fade.

| id | maxSeconds | variants | recipe |
|---|---|---|---|
| `fiesta.jump` | 0.35 | 8 | springy rising harmonic stack, upward air puff, small push-off sub |
| `fiesta.dive` | 0.5 | 8 | falling whoosh, cloth flutter, plastic belly-flop thud |
| `fiesta.grab` | 0.25 | 8 | cloth snatch, low resonant ping, rubber squeak bending up |
| `fiesta.eliminate` | 1.2 | 8 | wavering slide whistle falling an octave, air poof, low boom |
| `fiesta.wobble` | 0.6 | 8 | sagging jelly stack, decaying 9 -> 4 Hz AM, rubber ping, soft sub |
| `fiesta.squash` | 0.3 | 8 | squelch, flattening thump, wet plastic click |

The brief names jump, dive, grab, eliminate and wobble; the code also ships `fiesta.squash`,
and none of the six ids is an S16 id (S16 uses `move.*`). `packages/game/src/audio/ids.ts`
still exports the five played ids as `FIESTA_SOUNDS`, plus `CROWD_BED_ID = 'crowd'` and
`FIESTA_MIX_ID = 'fiesta'`.

### 1.2 The crowd (`pack/crowd.ts`, `pack/crowdModel.ts`)

`CROWD_FAMILIES` has three one-shot families, also 8 variants, bus `ambience`, category
`sting`; each seeds a fresh `CrowdModel` and renders a DC-blocked, faded mono shot with a
-6 dBFS peak.

| id | maxSeconds | variants | shot |
|---|---|---|---|
| `crowd.aww` | 1.8 | 8 | small disappointed crowd, vowels o/u |
| `crowd.cheer.big` | 3.0 | 8 | full-size cheer, long swell |
| `crowd.cheer.small` | 1.5 | 8 | half-size cheer |

`CROWD_BED` is the continuous bed: id `crowd`, bus `ambience`, parameters `CROWD_PARAMS =
['size', 'excitement', 'swell', 'level']`, defaults `[0.6, 0.3, 0, 1]`, `positional: false`,
one `CrowdModel` per bed. `crowdModel.ts` is the shared bed/one-shot DSP: 48 preallocated
babble voices with three formants, two murmur bands, claps above excitement 0.3, whistles
above 0.6, an internal FDN, stereo DC blockers, a -5 dB output trim and a peak compressor.
`apps/web/src/audio/fiestaWorklet.ts` runs `CROWD_BED.create` in an AudioWorklet quantum of
128 frames and writes `{index, value}` parameter messages.

### 1.3 The mix (`pack/mix.ts`)

`FIESTA_PRESET` is id `fiesta`, priority -10, built from HAA's `BASE_PRESET`. It keeps the
base master, loudness, scene target and reverb, and changes:

- bus levels against the base: `effects` +7 dB, `ambience` -1 dB, `music` 0 dB, `ui` +4 dB;
- ducks: `eliminate` (-6 dB music, -2 dB ambience), `cheer` (-4 dB music), `qualify`
  (-5 dB music, -3 dB ambience), plus the base ducks;
- `familyTrimDb`: jump +13, dive +13, grab +16, eliminate +9, wobble +11, squash +9, each
  crowd shot +8 dB;
- `bedTrimDb`: music +6 dB, crowd +7 dB.

The six patch files render through no mix at all, so these trims never reach them.

### 1.4 The six mechanism patches (`audio/*.haa.json`)

All six use the HAA 0.2 patch format (`haa: 1`), and the file stem equals the patch `id`.

| id | duration | loop | mode | inputs | character |
|---|---|---|---|---|---|
| `audio/neon-hum.haa.json` | 4 s | true | live | none | 60/120/180 Hz electric hum, flicker, faint fizz |
| `audio/mech-click.haa.json` | 0.12 s | false | timeline | none | candy switch tick-clack |
| `audio/ice-creak.haa.json` | 0.6 s | false | live | none | brittle ice fracture and triangle creak |
| `audio/jungle-crank.haa.json` | 2 s | true | live | none | 8 Hz wooden ratchet and stretching rope |
| `audio/mech-thud.haa.json` | 0.3 s | false | timeline | `gain` 0..1 | soft rubber impact |
| `audio/mech-motor.haa.json` | 2 s | true | live | none | soft piston motor whirr |

`mech-thud` is the only patch with an input. None of the six ids is an S16 id.

### 1.5 Course emitters (`packages/game/src/audio/emitters.ts`, `apps/web/src/play/courseAudio.ts`)

`CourseEmitters` reads a `ResolvedCourse.sounds` list (`SoundSpec`) and the sim's mechanism
view, and fills `EmitterCommand`s (`start`, `stop`, `move`, `trigger`). A sound without an
event or signal starts once; a signal sound starts on the signal edge and stops on the
falling edge; an event sound triggers once per matching `MechEvent`, deduplicated by
`tick:kind:source` over the 64-tick event ring. The position is body 0 of the sound's item,
or the event position; `gain`, `ref`, `max` and `loop` come from the course JSON.

`apps/web/src/play/courseAudio.ts` is the view side: one spatial scene per page, one patch
fetch and one `HaaPlayer` per patch id, at most 32 active sounds, rolloff 1, `ref`/`max` per
sound, `trigger` moves the emitter and restarts the player, and a patch `gain` input receives
the event `strength`. A missing patch is warned once and skipped.

The V2 courses place these six patches: `candy-seesaw-run` 7 sounds, `ice-slide-gates` 9,
`jungle-crane-crossing` 4, `mech-lab` 6, `neon-piston-alley` 9 (35 placements in total).
Every placement names `mech-click`, `mech-thud`, `mech-motor`, `ice-creak`, `jungle-crank` or
`neon-hum`.

### 1.6 The `events.ts` mapping (`packages/game/src/audio/events.ts`)

`diffSamples(prev, next)` compares one match frame with the previous one and never emits on
the first frame. It currently maps five transitions to the pack's ids:

| trigger | id |
|---|---|
| grounded -> air with `vy > 0` | `fiesta.jump` |
| enter dive | `fiesta.dive` |
| enter grabbing | `fiesta.grab` |
| enter stunned | `fiesta.wobble` |
| alive -> eliminated | `fiesta.eliminate` |

`bedState` turns the crowd bed on during intro and playing of a round and picks excitement
0.5 (race), 0.7 (survival) or 0.9 (final); `BED_FADE_S` is 1 s. `GameAudio` plays the events
through `SoundPort.play`, starts the bed once per round and updates its `excitement`; it
stops the bed when the round ends. There are no step, land, slide, swim, hit, release or
carry transitions yet, and no mechanism or objective mapping.

### 1.7 Step-2 placement (`apps/web` sound adapters)

| adapter | what it plays | notes |
|---|---|---|
| `apps/web/src/client/sound.ts` | `ClientSound`: the five match events and the crowd bed | opens on the first gesture, reads `audio/manifest.json`, uses `GameAudio`; no course audio |
| `apps/web/src/play/sound.ts` | `SoundDriver`: match events, crowd bed and the course's spatial sounds | `openBrowserAudio` with `maxListeners: 1`; `CourseEmitters` per course; `createCourseAudio` with the HAA 0.2 wasm/worklet; listener is player 0 |
| `apps/web/src/play/courseAudio.ts` | mechanism start/stop/move/trigger | patch fetch, spatial scene, 32 active sounds, `ref`/`max`, event `strength` into the patch `gain` input |
| `apps/web/src/audio/fiestaWorklet.ts` | the crowd bed | AudioWorklet running `CROWD_BED.create`; parameters by index |
| `packages/game/src/audio/context.ts` | `openBrowserAudio`: the HAA engine and the bed | the only module that creates an `AudioContext`; the bed connects through a -1 dB gain and a `DynamicsCompressor` straight to the destination, not through an ambience or crowd bus |

## 2. How to render

From the repository root:

```
node --experimental-strip-types tools/audioAudit.ts out/s3/m1/audit
```

`out/s3/m1/audit` is also the default when the argument is omitted. The full run took 2.6 s
in this worktree, well under the 60 s step budget, and repeated runs produced identical stats.
The command is the `auditAudio` function of `tools/audioAudit.ts`:

1. `registerRoyalFiesta()` registers the pack.
2. Every family of `FIESTA_FAMILIES` is rendered variant by variant (8 each) through the
   v0.1 offline API, exactly as `packages/game/test/audio.test.ts` does: `createOfflineAudio(
   { mix: FIESTA_MIX_ID, maxListeners: 1 })`, `play(family.id, { variant })`,
   `advance(family.maxSeconds)`, `take(family.id)`.
3. The `crowd` bed is started once and rendered for 2 s.
4. Every `audio/*.haa.json` is loaded through `loadModule()` and rendered with `renderBank`
   for variants 0, 1 and 2 at 2 s, with default inputs.
5. Each render is packed into the haa 0.2 `StereoRender` shape, measured with `analyse`,
   and written with `writeWav` to `out/s3/m1/audit/<id>.wav`.
6. One line is printed per render:
   `<id>\t<engine>\tpeak <dBFS>\trms <dBFS>\tnonFinite <n>\tsilent <bool>\tclipped <bool>`.

The WAV path is keyed by id only, so the eight variants of a family overwrite the same
`<id>.wav` and only the last variant remains on disk. The function still returns and prints
one row per variant: 6 families x 8 variants + 1 bed + 6 patches x 3 variants = 67 rows, but
only 13 WAV files survive. The test `tools/test/audioAudit.test.ts` runs the same function
into a temporary directory and checks one row per pack variant and patch file, a non-empty
WAV per row and finite stats.

## 3. What is wrong, per sound

The audit produced 67 rows with `nonFinite 0`, `silent false` and `clipped false` everywhere;
the sample validity is fine. The problems are coverage, level, variation, routing and space.
The measurements below are the min..max over the rendered variants from that run.

| sound | measured observation | what is wrong |
|---|---|---|
| `fiesta.jump` | peak -5.91..-3.04 dBFS, rms -18.50..-16.62 dBFS | **missing** as `move.jump` (no S16 source); **unmixed** (only the v0.1 `familyTrimDb` +13 dB, no bus); **not spatial** (the audit renders dry stereo); repetitive risk: one terrain-independent family for every jump |
| `fiesta.dive` | peak -1.83..-1.53 dBFS, rms -22.13..-20.12 dBFS | **harsh** (peaks 1.5-1.8 dB below full scale, crest about 19-21 dB); **missing** as `move.dive`; **unmixed**; **not spatial** |
| `fiesta.grab` | peak -1.53..-1.50 dBFS, rms -21.32..-19.26 dBFS | **harsh** (hottest family, almost 0 dBFS after the +16 dB trim); **thin** (0.25 s body); **missing** as `move.grab`/`move.carry`; **unmixed**; **not spatial** |
| `fiesta.eliminate` | peak -11.01..-9.34 dBFS, rms -20.63..-19.51 dBFS | **thin** (peaks 3-9 dB below the other families); **repetitive** (one 1.2 s fall for every elimination); **missing** as an S16 movement id (nearest row is `flow.eliminate` on the ui bus, which is non-spatial); **unmixed**; **not spatial** |
| `fiesta.squash` | peak -3.59..-1.51 dBFS, rms -20.55..-19.87 dBFS | **missing** (no S16 row at all, never played by `events.ts` or `GameAudio`); **harsh** (peaks near full scale); **unmixed**; **not spatial** |
| `fiesta.wobble` | peak -4.97..-1.51 dBFS, rms -19.60..-18.63 dBFS | **harsh** (variants reach -1.51 dBFS; RMS -19.60..-18.63 dBFS); **missing** as `move.wobble`; **unmixed**; **not spatial**; today it covers both obstacle and grab stun with one family |
| `crowd.aww`, `crowd.cheer.big`, `crowd.cheer.small` | not rendered by the audit; source says 8 variants, -6 dBFS shot peak | **missing** from S16 and from `events.ts` (orphan content); **unmixed** (a +8 dB family trim but no bus); **repetitive** (fixed mood, no world or situation input); **not spatial** |
| `crowd` bed | peak -13.09 dBFS, rms -26.39 dBFS (2 s, defaults) | **thin** (4-10 dB below the family RMS and below most patches); **unmixed** (v0.1 ambience -1 dB plus bed +7 dB; the browser bed bypasses buses with its own -1 dB gain and compressor); **repetitive** (one bed for every world, only excitement changes); **missing** as an S17 source file (`audio/crowd.haa.json` does not exist; the bed is code) |
| `mech-click` | peak -15.08..-14.19 dBFS, rms -41.59..-41.45 dBFS | **thin** (41 dB RMS); **harsh** (2600 Hz tick and 1120 Hz clack); **repetitive** (same patch on every switch, no variant choice at play); **unmixed** (renderBank is dry); **not spatial** in the audit; **missing** as the S16 `mech.switch`/`mech.lever` source |
| `ice-creak` | peak -15.30..-14.96 dBFS, rms -34.91..-34.89 dBFS | **thin** (35 dB RMS); **harsh** (3800 Hz bandpass, resonance 5); **repetitive** (one 0.6 s event for every plate and floe, no rate or size input); **unmixed**; **not spatial** in the audit; **missing** as an S16 id |
| `jungle-crank` | peak -17.91..-17.17 dBFS, rms -34.57..-34.52 dBFS | **thin**; **repetitive** (2 s, 8 Hz clicks, no rate input); **unmixed**; **not spatial** in the audit; **missing** as an S16 mechanism id |
| `mech-motor` | peak -24.33..-24.25 dBFS, rms -31.60..-31.59 dBFS | **thin** (quietest peak); **repetitive** (monotone loop, no rate input); **unmixed**; **not spatial** in the audit; **missing** as the `mech.motor` source |
| `mech-thud` | peak -9.76..-9.49 dBFS, rms -29.95..-29.86 dBFS | **thin** (loud peak, little body); **repetitive** (one impact for every mechanism); **unmixed**; **not spatial** in the audit; **missing** as the S16 impact sources. It is the only patch with an input (`gain`) |
| `neon-hum` | peak -22.06..-21.95 dBFS, rms -27.45 dBFS | **thin**; **repetitive** (steady 60/120/180 Hz hum, no rate input); **unmixed**; **not spatial** in the audit; **missing** as the `mech.laser`/ambience sources |

### Missing coverage

S16 has 98 ids and every one expects `audio/<id>.haa.json` (music rows expect
`audio/<id>.arr.json`). **None of those 98 files exists.** The breakdown is 18 movement, 24
world (12 one-shots, 5 loops, 7 objectives), 19 flow/ui, 32 music arrangements, 4 ambience
loops and the crowd bed. The six patch files are not S16 ids, the six pack families are not
S16 ids, and the three crowd one-shots are not S16 ids. So the 16 existing assets cover 0 of
the 98 catalog rows by filename, even though five of them are the current match event sounds.

The measurements also do not show space or mix: the v0.1 family renders go through the
`fiesta` preset with one listener and no source position, and the patch renders go through no
mix at all. Their numbers are therefore not comparable to each other or to the S16 bus gains
in section 6.

## 4. What the M2 redesign must contain

M2 is one sound card. It owns `packages/game/src/audio` (except `catalog.ts`, `sounds/` and
`mix/`), deletes `pack/` and the six old patches, and wires the web adapters to the baked
manifest and the live loops. The redesign must contain:

### Engines (1.17)

- One engine version on both paths: HAA **0.2.0** renders the baked one-shots and plays the
  live loops, in the browser and in Node. The v0.1 pack (`pack/`) and the six
  `audio/*.haa.json` patch files are deleted; the root `@etcito/haa` 0.1.1 pin goes once
  nothing imports it.
- One-shots are baked per S17 into `apps/web/public/audio/` (`manifest.json`,
  `<id>.<variant>.wav`, `haa-processors.js`, `haa.wasm`). Loops list their patch in the
  manifest and play live through the 0.2 worklet. Music uses `audio/<id>.arr.json`;
  `audio/inst.<name>.haa.json` instrument patches are not sound ids.

### Seeded variants

- Every variant is rendered with the bank seed `variantSeed(id, variant)` (FNV-1a over
  `` `${id}#${variant}` ``), so a re-render is reproducible and two triggers of the same id
  are not the same waveform.
- The counts are the catalog's: 8 variants for movement one-shots and mechanism one-shots, 4
  for objectives, UI and flow (8 for `flow.elim-drop`), 1 for every loop and bed. Every
  world, plus the ice and mud overrides, gets its own step family, and steps scale pitch and
  level with speed at play.
- No source may carry a single hard-coded take. The old patch files have no variant design
  at all; the old pack's eight variants are the only seeded content that survives in spirit.

### Levels in patches

- Each patch owns its level (`master`, plus a `gain`/`strength` input where an event has a
  strength) instead of the v0.1 `familyTrimDb`/`bedTrimDb` table in `pack/mix.ts`. Levels are
  set once per patch and the bake does not re-trim families by name.
- The declared inputs come from the catalog: `move.slide` takes `speed`, mechanism loops take
  `rate`, the crowd bed takes `excitement`, and event patches take the event `strength` where
  they declare a `gain` input. No other per-sound level table is allowed.

### Buses

- Every id routes to the bus its catalog row names (`music`, `sfx`, `ui`, `ambience`,
  `crowd`), and the bake manifest records `bus`, `mode`, `files` and `patch` per sound. The
  crowd bed stops connecting straight to the destination and joins the `crowd` bus.
- The buses use the S16 gains and the ducking/limiter plan in section 6. Per-bus volume
  settings run 0..1 and multiply the bus gain.

### Coverage, mapping and space

- All 98 catalog ids need a source file and a bake entry; `events.ts`, `GameAudio`,
  `CourseEmitters` and the course `sounds` blocks all name catalog ids, never `fiesta.*` or
  the old patch ids. `stepSoundId` applies the S16 surface rule (ice -> ice, mud -> mud, else
  the world, `common` -> stone).
- Spatial rows (`spatial: true`) are positioned per source and use the nearest of 1..4 local
  listeners for gain and pan. Non-spatial rows (UI, music, ambience, crowd) stay 2D.

## 5. The exact event-to-sound table (S16)

S16 is **confirmed without change**: this card adds no id, so
`packages/game/src/audio/catalog.ts` and `packages/game/test/soundCatalog.test.ts` keep their
98 rows. The table below is a row-for-row copy of `SOUNDS`; in the catalog `event` equals
`id`, `source` is `audio/<id>.haa.json` (`.arr.json` for `music.*`) and the bed id `crowd` is
the explicit `BED_IDS` entry. The `kind` column marks a family or the bed.

| id | kind | group | bus | mode | variants | spatial | input | source | trigger |
|---|---|---|---|---|---|---|---|---|---|
| `move.step.candy` | family | movement | sfx | oneshot | 8 | yes | - | `audio/move.step.candy.haa.json` | walk-cycle foot contact on candy; pitch/level scale with speed |
| `move.step.ice` | family | movement | sfx | oneshot | 8 | yes | - | `audio/move.step.ice.haa.json` | foot contact on ice (surface override); speed scaling |
| `move.step.jungle` | family | movement | sfx | oneshot | 8 | yes | - | `audio/move.step.jungle.haa.json` | foot contact in the jungle world; speed scaling |
| `move.step.neon` | family | movement | sfx | oneshot | 8 | yes | - | `audio/move.step.neon.haa.json` | foot contact in the neon world; speed scaling |
| `move.step.stone` | family | movement | sfx | oneshot | 8 | yes | - | `audio/move.step.stone.haa.json` | foot contact on common worlds/surfaces; speed scaling |
| `move.step.mud` | family | movement | sfx | oneshot | 8 | yes | - | `audio/move.step.mud.haa.json` | foot contact on mud (surface override); speed scaling |
| `move.jump` | family | movement | sfx | oneshot | 8 | yes | - | `audio/move.jump.haa.json` | ground -> air with `vy > 0` |
| `move.land.soft` | family | movement | sfx | oneshot | 8 | yes | - | `audio/move.land.soft.haa.json` | air -> ground, impact speed < 9 m/s |
| `move.land.hard` | family | movement | sfx | oneshot | 8 | yes | - | `audio/move.land.hard.haa.json` | air -> ground, impact speed >= 9 m/s |
| `move.dive` | family | movement | sfx | oneshot | 8 | yes | - | `audio/move.dive.haa.json` | enter dive |
| `move.slide` | family | movement | sfx | loop | 1 | yes | `speed` | `audio/move.slide.haa.json` | while mode slide |
| `move.swim` | family | movement | sfx | oneshot | 8 | yes | - | `audio/move.swim.haa.json` | each belly stroke (slide or swim) |
| `move.hit` | family | movement | sfx | oneshot | 8 | yes | - | `audio/move.hit.haa.json` | stunned by a character |
| `move.stun` | family | movement | sfx | oneshot | 8 | yes | - | `audio/move.stun.haa.json` | stunned by an obstacle |
| `move.wobble` | family | movement | sfx | oneshot | 8 | yes | - | `audio/move.wobble.haa.json` | while grabbed |
| `move.grab` | family | movement | sfx | oneshot | 8 | yes | - | `audio/move.grab.haa.json` | enter grabbing |
| `move.release` | family | movement | sfx | oneshot | 8 | yes | - | `audio/move.release.haa.json` | leave grabbing |
| `move.carry` | family | movement | sfx | oneshot | 8 | yes | - | `audio/move.carry.haa.json` | pick up an object |
| `mech.switch` | family | world | sfx | oneshot | 8 | yes | - | `audio/mech.switch.haa.json` | mechanism/feature switch event |
| `mech.lever` | family | world | sfx | oneshot | 8 | yes | - | `audio/mech.lever.haa.json` | mechanism/feature lever event |
| `mech.door` | family | world | sfx | oneshot | 8 | yes | - | `audio/mech.door.haa.json` | door opens or moves |
| `mech.spring` | family | world | sfx | oneshot | 8 | yes | - | `audio/mech.spring.haa.json` | spring or bounce pad fires |
| `mech.hammer` | family | world | sfx | oneshot | 8 | yes | - | `audio/mech.hammer.haa.json` | hammer swings or hits |
| `mech.seesaw` | family | world | sfx | oneshot | 8 | yes | - | `audio/mech.seesaw.haa.json` | seesaw settles or tips |
| `mech.log` | family | world | sfx | oneshot | 8 | yes | - | `audio/mech.log.haa.json` | rolling log passes or turns |
| `mech.tile-warn` | family | world | sfx | oneshot | 8 | yes | - | `audio/mech.tile-warn.haa.json` | tile field warns |
| `mech.tile-fall` | family | world | sfx | oneshot | 8 | yes | - | `audio/mech.tile-fall.haa.json` | tile field falls or decays |
| `mech.boost` | family | world | sfx | oneshot | 8 | yes | - | `audio/mech.boost.haa.json` | boost lane triggers |
| `mech.launch` | family | world | sfx | oneshot | 8 | yes | - | `audio/mech.launch.haa.json` | launch pad fires |
| `mech.door-break` | family | world | sfx | oneshot | 8 | yes | - | `audio/mech.door-break.haa.json` | fake door breaks |
| `mech.motor` | family | world | sfx | loop | 1 | yes | `rate` | `audio/mech.motor.haa.json` | course sound emitter or feature, running |
| `mech.spinner` | family | world | sfx | loop | 1 | yes | `rate` | `audio/mech.spinner.haa.json` | course sound emitter or feature, running |
| `mech.conveyor` | family | world | sfx | loop | 1 | yes | `rate` | `audio/mech.conveyor.haa.json` | course sound emitter or feature, running |
| `mech.laser` | family | world | sfx | loop | 1 | yes | `rate` | `audio/mech.laser.haa.json` | course sound emitter or feature, running |
| `mech.slime` | family | world | sfx | loop | 1 | yes | `rate` | `audio/mech.slime.haa.json` | course sound emitter or feature, running |
| `obj.goal` | family | world | sfx | oneshot | 4 | yes | - | `audio/obj.goal.haa.json` | goal scored in a team round |
| `obj.pickup` | family | world | sfx | oneshot | 4 | yes | - | `audio/obj.pickup.haa.json` | collectible picked up |
| `obj.bank` | family | world | sfx | oneshot | 4 | yes | - | `audio/obj.bank.haa.json` | item banked |
| `obj.capture` | family | world | sfx | oneshot | 4 | yes | - | `audio/obj.capture.haa.json` | capture zone completes |
| `obj.steal` | family | world | sfx | oneshot | 4 | yes | - | `audio/obj.steal.haa.json` | object stolen from a carrier |
| `obj.tail` | family | world | sfx | oneshot | 4 | yes | - | `audio/obj.tail.haa.json` | tail gained or lost |
| `obj.crown` | family | world | sfx | oneshot | 4 | yes | - | `audio/obj.crown.haa.json` | crown grabbed |
| `ui.click` | family | flow | ui | oneshot | 4 | no | - | `audio/ui.click.haa.json` | screen button click |
| `ui.hover` | family | flow | ui | oneshot | 4 | no | - | `audio/ui.hover.haa.json` | menu item hover |
| `ui.back` | family | flow | ui | oneshot | 4 | no | - | `audio/ui.back.haa.json` | back or cancel |
| `ui.error` | family | flow | ui | oneshot | 4 | no | - | `audio/ui.error.haa.json` | screen error |
| `ui.buy` | family | flow | ui | oneshot | 4 | no | - | `audio/ui.buy.haa.json` | purchase completes |
| `ui.ticket` | family | flow | ui | oneshot | 4 | no | - | `audio/ui.ticket.haa.json` | ticket spent |
| `ui.inbox` | family | flow | ui | oneshot | 4 | no | - | `audio/ui.inbox.haa.json` | inbox action |
| `flow.vote-tick` | family | flow | ui | oneshot | 4 | no | - | `audio/flow.vote-tick.haa.json` | vote timer tick |
| `flow.vote-confirm` | family | flow | ui | oneshot | 4 | no | - | `audio/flow.vote-confirm.haa.json` | vote cast |
| `flow.count-tick` | family | flow | ui | oneshot | 4 | no | - | `audio/flow.count-tick.haa.json` | countdown tick |
| `flow.count-go` | family | flow | ui | oneshot | 4 | no | - | `audio/flow.count-go.haa.json` | countdown GO |
| `flow.round-start` | family | flow | ui | oneshot | 4 | no | - | `audio/flow.round-start.haa.json` | round starts |
| `flow.qualify` | family | flow | ui | oneshot | 4 | no | - | `audio/flow.qualify.haa.json` | player qualifies |
| `flow.eliminate` | family | flow | ui | oneshot | 4 | no | - | `audio/flow.eliminate.haa.json` | player eliminated (show flow) |
| `flow.elim-drop` | family | flow | ui | oneshot | 8 | no | - | `audio/flow.elim-drop.haa.json` | once per thrown character |
| `flow.win` | family | flow | ui | oneshot | 4 | no | - | `audio/flow.win.haa.json` | match won |
| `flow.crown-gold` | family | flow | ui | oneshot | 4 | no | - | `audio/flow.crown-gold.haa.json` | podium, first place |
| `flow.crown-silver` | family | flow | ui | oneshot | 4 | no | - | `audio/flow.crown-silver.haa.json` | podium, second place |
| `flow.crown-bronze` | family | flow | ui | oneshot | 4 | no | - | `audio/flow.crown-bronze.haa.json` | podium, third place |
| `music.candy.lobby` | family | music | music | loop | 1 | no | - | `audio/music.candy.lobby.arr.json` | screen and round kind: lobby |
| `music.candy.hub` | family | music | music | loop | 1 | no | - | `audio/music.candy.hub.arr.json` | screen and round kind: hub |
| `music.candy.race` | family | music | music | loop | 1 | no | - | `audio/music.candy.race.arr.json` | screen and round kind: race |
| `music.candy.survival` | family | music | music | loop | 1 | no | - | `audio/music.candy.survival.arr.json` | screen and round kind: survival |
| `music.candy.team` | family | music | music | loop | 1 | no | - | `audio/music.candy.team.arr.json` | screen and round kind: team |
| `music.candy.final` | family | music | music | loop | 1 | no | - | `audio/music.candy.final.arr.json` | screen and round kind: final |
| `music.candy.results` | family | music | music | oneshot | 1 | no | - | `audio/music.candy.results.arr.json` | screen and round kind: results |
| `music.candy.podium` | family | music | music | oneshot | 1 | no | - | `audio/music.candy.podium.arr.json` | screen and round kind: podium |
| `music.ice.lobby` | family | music | music | loop | 1 | no | - | `audio/music.ice.lobby.arr.json` | screen and round kind: lobby |
| `music.ice.hub` | family | music | music | loop | 1 | no | - | `audio/music.ice.hub.arr.json` | screen and round kind: hub |
| `music.ice.race` | family | music | music | loop | 1 | no | - | `audio/music.ice.race.arr.json` | screen and round kind: race |
| `music.ice.survival` | family | music | music | loop | 1 | no | - | `audio/music.ice.survival.arr.json` | screen and round kind: survival |
| `music.ice.team` | family | music | music | loop | 1 | no | - | `audio/music.ice.team.arr.json` | screen and round kind: team |
| `music.ice.final` | family | music | music | loop | 1 | no | - | `audio/music.ice.final.arr.json` | screen and round kind: final |
| `music.ice.results` | family | music | music | oneshot | 1 | no | - | `audio/music.ice.results.arr.json` | screen and round kind: results |
| `music.ice.podium` | family | music | music | oneshot | 1 | no | - | `audio/music.ice.podium.arr.json` | screen and round kind: podium |
| `music.jungle.lobby` | family | music | music | loop | 1 | no | - | `audio/music.jungle.lobby.arr.json` | screen and round kind: lobby |
| `music.jungle.hub` | family | music | music | loop | 1 | no | - | `audio/music.jungle.hub.arr.json` | screen and round kind: hub |
| `music.jungle.race` | family | music | music | loop | 1 | no | - | `audio/music.jungle.race.arr.json` | screen and round kind: race |
| `music.jungle.survival` | family | music | music | loop | 1 | no | - | `audio/music.jungle.survival.arr.json` | screen and round kind: survival |
| `music.jungle.team` | family | music | music | loop | 1 | no | - | `audio/music.jungle.team.arr.json` | screen and round kind: team |
| `music.jungle.final` | family | music | music | loop | 1 | no | - | `audio/music.jungle.final.arr.json` | screen and round kind: final |
| `music.jungle.results` | family | music | music | oneshot | 1 | no | - | `audio/music.jungle.results.arr.json` | screen and round kind: results |
| `music.jungle.podium` | family | music | music | oneshot | 1 | no | - | `audio/music.jungle.podium.arr.json` | screen and round kind: podium |
| `music.neon.lobby` | family | music | music | loop | 1 | no | - | `audio/music.neon.lobby.arr.json` | screen and round kind: lobby |
| `music.neon.hub` | family | music | music | loop | 1 | no | - | `audio/music.neon.hub.arr.json` | screen and round kind: hub |
| `music.neon.race` | family | music | music | loop | 1 | no | - | `audio/music.neon.race.arr.json` | screen and round kind: race |
| `music.neon.survival` | family | music | music | loop | 1 | no | - | `audio/music.neon.survival.arr.json` | screen and round kind: survival |
| `music.neon.team` | family | music | music | loop | 1 | no | - | `audio/music.neon.team.arr.json` | screen and round kind: team |
| `music.neon.final` | family | music | music | loop | 1 | no | - | `audio/music.neon.final.arr.json` | screen and round kind: final |
| `music.neon.results` | family | music | music | oneshot | 1 | no | - | `audio/music.neon.results.arr.json` | screen and round kind: results |
| `music.neon.podium` | family | music | music | oneshot | 1 | no | - | `audio/music.neon.podium.arr.json` | screen and round kind: podium |
| `amb.candy` | family | music | ambience | loop | 1 | no | - | `audio/amb.candy.haa.json` | hub and rounds of the candy world |
| `amb.ice` | family | music | ambience | loop | 1 | no | - | `audio/amb.ice.haa.json` | hub and rounds of the ice world |
| `amb.jungle` | family | music | ambience | loop | 1 | no | - | `audio/amb.jungle.haa.json` | hub and rounds of the jungle world |
| `amb.neon` | family | music | ambience | loop | 1 | no | - | `audio/amb.neon.haa.json` | hub and rounds of the neon world |
| `crowd` | bed | music | crowd | loop | 1 | no | `excitement` | `audio/crowd.haa.json` | the kept crowd bed, balanced |

The 98 rows are 18 movement + 24 world + 19 flow/ui + 32 music + 4 ambience + 1 crowd,
matching `SOUNDS` in `catalog.ts` one for one.

## 6. The mix plan (S16 buses and ducking)

Signal order: source (with its spatial gain and pan) -> bus gain -> ducking gains -> master
limiter -> destination. The v0.1 `fiesta` preset is retired; its `effects +7` / `ambience -1`
/ `ui +4` trims and its `familyTrimDb` / `bedTrimDb` table are not the S16 mix.

### Bus gains

| bus | gain | what it carries |
|---|---|---|
| `music` | -8 dB | all `music.<world>.<cue>` rows |
| `sfx` | 0 dB | `movement`, `world` (mechanisms, objectives) |
| `ui` | -4 dB | `ui.*` and `flow.*` |
| `ambience` | -14 dB | `amb.*` loops |
| `crowd` | -12 dB | the `crowd` bed |

The crowd bed stops going straight to the destination: the worklet output enters the `crowd`
bus at -12 dB, so the old `CROWD_GAIN` (-1 dB), the standalone bed compressor and the +7 dB
`bedTrimDb` are gone. The master limiter replaces the bed compressor as the peak guard.

### Ducking

| trigger | target | depth | attack | release |
|---|---|---|---|---|
| `flow.*` stings and `flow.count-go` | music | -10 dB | 0.05 s | 0.6 s |
| menus open (lobby, hub, settings, pause) | ambience | -8 dB | - | - |

Ducking is applied to the bus gain, not baked into a patch, and releases back to the bus
gain. `flow.eliminate` also uses the show-flow sting path, so the character elimination
moment ducks music through the same rule.

### Limiter and levels

- The master limiter ceiling is **-1 dBFS**, after bus gains and ducking. No per-bus limiter
  is needed; the audit's renders show no clipped samples (`clipped false` on all 67 rows),
  and the redesign's level target is to keep the hottest one-shots under the ceiling without
  relying on the old per-family trims.
- One-shots and loops are levelled inside their patches (section 4). The bus gains above are
  the only cross-sound balance, so a loud `fiesta.grab`-style peak cannot bypass the plan by
  carrying its own extra trim.

### Listeners and space

- Spatial rows (`movement`, `world`, `obj.*`) get gain and pan from the nearest of 1..4 local
  listeners; one listener is the local player's camera, four cover split-screen seats. Course
  emitters keep their `ref`/`max` and rolloff 1, positioned at the item body or the mechanism
  event.
- Non-spatial rows (`ui`, `flow`, `music`, `amb.*`, `crowd`) go to the bus centre with no
  distance attenuation. The crowd bed is one bed per page, not one per listener.

### Volumes

The settings screen exposes one volume per bus, each running 0..1. The effective gain is the
S16 bus gain multiplied by the slider; a slider at 0 mutes its bus, at 1 restores the S16
gain. The master limiter stays after the volume stage so a user-raised `sfx` bus still cannot
cross -1 dBFS.
