# Paramesh conversion of the assets (2026-10-26)

Owner batch: every classic primitive of every asset became a Paramesh node (MAMA `convertToParamesh`, the same as
"Convert to Paramesh" in the modeler), and every asset group meshes with Paramesh at 4 subdivisions, 1 transition
loop, field resolution 16. A group Paramesh could not mesh was tried with Quad, then set to Low poly. Each attempt ran
with MAMA 8824569 and a 180 s limit. The shapes are not exactly the
classic ones (visual tolerance 5 % of the smallest dimension); the owner accepted that.

24 asset files, 447 primitives converted, 74 groups on Paramesh, 7 on Low poly.

## Groups on Low poly (to investigate)

| Asset | Group | Paramesh | Quad |
|---|---|---|---|
| candy.bounce-pad | candy-bounce-pad | group 'candy-bounce-pad' cannot be meshed with Quad mesh (clean) (quad): The cylinder 'rim' has no Paramesh source: it holds detail shapes. | group 'candy-bounce-pad' cannot be meshed with Quad mesh (clean) (quad): The cylinder 'rim' has no Paramesh source: it holds detail shapes. |
| candy.hot-air-balloon | candy-hot-air-balloon | group 'candy-hot-air-balloon' cannot be meshed with Quad mesh (clean) (quad): Paramesh failed while meshing, at the polygon mesh stage (mesher code polygon): The blended projection could not preserve a closed solid for this group. Reduce fusion or change its Paramesh quality. | no result in 180 s |
| candy.slime-pool | candy-slime-pool | group 'candy-slime-pool' cannot be meshed with Quad mesh (clean) (quad): The group 'lumps-a' has deformers; the Paramesh output meshes only plain groups of shapes. | group 'candy-slime-pool' cannot be meshed with Quad mesh (clean) (quad): The group 'lumps-a' has deformers; the Paramesh output meshes only plain groups of shapes. |
| candy.spinner-bar | Spinner Bar | group 'Spinner Bar' cannot be meshed with Quad mesh (clean) (quad): The box 'stripe-a' has no Paramesh shape within the visual tolerance: it has deformers. | group 'Spinner Bar' cannot be meshed with Quad mesh (clean) (quad): The box 'stripe-a' has no Paramesh shape within the visual tolerance: it has deformers. |
| costume.fish-scarf | fish_scarf | no result in 180 s | no result in 180 s |
| costume.pineapple-suit | pineapple_suit | group 'pineapple_suit' cannot be meshed with Quad mesh (clean) (quad): The group 'lattice_cw' has deformers; the Paramesh output meshes only plain groups of shapes. | group 'pineapple_suit' cannot be meshed with Quad mesh (clean) (quad): The group 'lattice_cw' has deformers; the Paramesh output meshes only plain groups of shapes. |
| penguin.body | penguin | no result in 180 s | no result in 180 s |

## Primitives that stayed classic

| Asset | Primitive | Reason |
|---|---|---|
| candy.bounce-pad | rim | The cylinder 'rim' has no Paramesh shape within the visual tolerance: it holds detail shapes. |
| candy.spinner-bar | stripe-a | The box 'stripe-a' has no Paramesh shape within the visual tolerance: it has deformers. |
| candy.spinner-bar | stripe-b | The box 'stripe-b' has no Paramesh shape within the visual tolerance: it has deformers. |

## Every asset

| Asset | Converted | Groups (mesher, triangles, seconds) |
|---|---:|---|
| candy.banner | 23 | candy-banner: paramesh 2000 tris 5.5 s |
| candy.bounce-pad | 8 | candy-bounce-pad: lowpoly |
| candy.checkpoint-gate | 21 | candy-checkpoint-gate: paramesh 2010 tris 21.5 s |
| candy.cloud | 16 | candy-cloud: paramesh 2000 tris 4.6 s |
| candy.conveyor-belt | 11 | rim: paramesh 192 tris 0.8 s, zigzag r: paramesh 88 tris 0.9 s, zigzag l: paramesh 88 tris 0.9 s, cushion 0: paramesh 192 tris 0.9 s, cushion 1: paramesh 192 tris 0.8 s, cushion 2: paramesh 192 tris 0.8 s, cushion 3: paramesh 192 tris 0.8 s, cushion 4: paramesh 192 tris 0.9 s, cap-front: paramesh 192 tris 0.8 s, cap-back: paramesh 192 tris 0.8 s, bolster r: paramesh 192 tris 0.9 s, bolster l: paramesh 192 tris 0.9 s, chevron 0: paramesh 88 tris 1.1 s, chevron 1: paramesh 88 tris 0.9 s, chevron 2: paramesh 88 tris 0.9 s, chevron 3: paramesh 88 tris 1.1 s, chevron 4: paramesh 88 tris 1 s |
| candy.finish-arch | 27 | post_l_base: paramesh 192 tris 0.8 s, post_l_core: paramesh 192 tris 0.8 s, post_l_band: paramesh 192 tris 0.9 s, post_l_rim0: paramesh 512 tris 1 s, post_l_rim1: paramesh 512 tris 1 s, post_l_rim2: paramesh 512 tris 1 s, post_r_base: paramesh 192 tris 0.8 s, post_r_core: paramesh 192 tris 0.9 s, post_r_band: paramesh 192 tris 0.9 s, post_r_rim0: paramesh 512 tris 1.1 s, post_r_rim1: paramesh 512 tris 1 s, post_r_rim2: paramesh 512 tris 1 s, beam: paramesh 192 tris 0.8 s, beam_band: paramesh 192 tris 0.9 s, beam_zigzag: paramesh 1400 tris 1.2 s, crown: paramesh 260 tris 1.1 s, crown_tip0: paramesh 192 tris 0.8 s, crown_tip1: paramesh 192 tris 0.9 s, crown_tip2: paramesh 192 tris 0.9 s, crown_tip3: paramesh 192 tris 0.7 s, crown_tip4: paramesh 192 tris 0.8 s, crown_jewel0: paramesh 192 tris 0.9 s, crown_jewel1: paramesh 192 tris 0.9 s, crown_jewel2: paramesh 192 tris 0.8 s |
| candy.floor-disc | 14 | Floor Disc: paramesh 3658 tris 39.5 s |
| candy.floor-tile | 12 | Floor Tile: paramesh 3384 tris 49.6 s |
| candy.hot-air-balloon | 16 | candy-hot-air-balloon: lowpoly |
| candy.moving-platform | 12 | Moving Platform: paramesh 2912 tris 18.7 s |
| candy.pendulum-hammer | 25 | Pendulum Hammer: paramesh 2000 tris 3.4 s |
| candy.plaza-fountain | 19 | candy-plaza-fountain: paramesh 3366 tris 7.3 s |
| candy.podium-block | 7 | candy-podium-block: paramesh 1848 tris 1.5 s |
| candy.queue-pad | 12 | candy-queue-pad: paramesh 3172 tris 21.5 s |
| candy.rotating-door | 13 | candy-rotating-door: paramesh 2646 tris 8.5 s |
| candy.seesaw-plank | 10 | candy-seesaw-plank: paramesh 2000 tris 3.2 s |
| candy.slime-pool | 33 | candy-slime-pool: lowpoly |
| candy.spinner-bar | 13 | Spinner Bar: lowpoly |
| candy.tower | 21 | candy-tower: paramesh 2000 tris 165.4 s |
| candy.wall-block | 9 | candy-wall-block: paramesh 3250 tris 3.3 s |
| costume.fish-scarf | 35 | fish_scarf: lowpoly |
| costume.pineapple-suit | 9 | pineapple_suit: lowpoly |
| costume.propeller-hat | 43 | gore_1: paramesh 128 tris 1.3 s, gore_2: paramesh 174 tris 1.3 s, gore_3: paramesh 122 tris 1.2 s, gore_4: paramesh 142 tris 1.2 s, gore_5: paramesh 158 tris 1.2 s, gore_6: paramesh 112 tris 1.1 s, gore_7: paramesh 136 tris 1.2 s, gore_8: paramesh 176 tris 1.2 s, gore_9: paramesh 140 tris 1.1 s, gore_10: paramesh 112 tris 1.1 s, gore_11: paramesh 144 tris 1.1 s, gore_12: paramesh 108 tris 1.1 s, hat_rim: paramesh 512 tris 1.1 s, hat_button: paramesh 192 tris 0.8 s, prop_stem: paramesh 192 tris 0.9 s, prop_hub: paramesh 192 tris 0.8 s, prop_blade_1: paramesh 192 tris 0.8 s, prop_blade_2: paramesh 192 tris 0.8 s, prop_blade_3: paramesh 192 tris 0.8 s |
| penguin.body | 38 | penguin: lowpoly |
