# Source Image Generation Prompt

Triastasis reconstructs one 3D asset from one image. The best source image is
therefore not necessarily the most dramatic image. It is the image that explains
the subject's shape clearly, keeps every important part visible, and gives the
reconstruction model few reasons to guess incorrectly.

Triastasis produces a static GLB. References to riggable characters below describe
source-image preparation for a separate downstream rigging workflow; Triastasis
does not create a rig, skin weights, or animation-ready output.

Use the templates below with an image-generation model when no suitable source
image already exists. Replace the bracketed fields, remove instructions that do
not apply, and preserve the geometry and composition clauses.

## General-purpose base prompt

```text
One [subject], a [short description of its defining shape, proportions, and
construction], [front three-quarter view / straight-on front view],
near-orthographic perspective. The complete subject is fully visible, centered,
and isolated, with generous margin on every side. Clean, readable silhouette;
coherent three-dimensional construction; physically plausible proportions;
important parts clearly separated instead of overlapping; visible depth and
side surfaces; consistent [materials and color palette]. Neutral studio
background with strong subject separation, soft even lighting, minimal soft
contact shadow, sharp focus, square composition. No additional objects, no
cropping, no hidden parts, no duplicate parts, no text, no logo, no watermark,
no border, no scenery, and no dramatic cast shadow.
```

Put the identity of the subject first. Describe the large forms before small
surface details. Keep style and mood secondary to geometry.

## Negative prompt

Use this separately when the image generator supports a negative prompt:

```text
cropped, out of frame, extreme perspective, wide-angle distortion, fisheye,
motion blur, depth-of-field blur, dramatic shadow, harsh rim light, cluttered
background, scenery, pedestal, text, logo, watermark, border, multiple subjects,
duplicate parts, extra limbs, missing parts, fused parts, hidden hands, hidden
feet, crossed limbs, self-occlusion, floating pieces, transparent body, ambiguous
silhouette
```

Do not depend on negative prompting alone. Important constraints should remain
in the positive prompt because some generators ignore or weakly apply negative
prompts.

## Riggable humanoid character

Use a front view for characters that will be rigged. A three-quarter hero pose
may look better as an illustration, but it hides joints and encourages fused or
asymmetric geometry.

```text
One full-body [character description], standing in a neutral relaxed A-pose,
straight-on front view, near-orthographic perspective. Head level and facing the
camera; shoulders neutral; arms angled slightly down and clearly separated from
the torso; elbows, wrists, and fingers readable; legs straight and separated;
knees, ankles, and complete feet visible. Symmetrical, animation-friendly
proportions and a clean continuous silhouette. [Costume, materials, colors], with
restrained fitted accessories and no loose overlapping cloth. The complete
character is centered with generous margin above the head, below the feet, and
beside both hands. Neutral studio background, soft even front lighting, minimal
soft contact shadow, sharp focus, square composition. No weapon, held prop, cape,
long coat tails, crossed limbs, cropped body parts, hidden hands, hidden feet,
extra limbs, text, logo, or watermark.
```

Prefer an A-pose over a rigid T-pose unless the target rig specifically needs a
T-pose. The slight arm angle gives the reconstruction model more natural shoulder
volume while retaining clear separation from the torso.

## Creature or non-humanoid character

```text
One complete [creature description] in a neutral standing pose, front
three-quarter view, near-orthographic perspective. All limbs are planted or
clearly visible and separated; the head, torso, joints, feet, wings, horns, and
tail are readable without overlapping each other. The tail curves beside the
body without crossing behind it, and paired features remain distinct. Coherent
anatomy, stable proportions, clean silhouette, and consistent [skin, fur, scales,
armor, or material]. Entire creature centered and isolated with generous margin,
neutral studio background, soft even lighting, minimal contact shadow, sharp
focus, square composition. No rider, harness, scenery, attack pose, motion blur,
cropping, duplicate limbs, fused limbs, hidden feet, text, logo, or watermark.
```

If the creature will be rigged, favor a more frontal and symmetrical pose. If it
will remain static, the three-quarter view usually provides better depth cues.

## Prop, vehicle, or freestanding object

```text
One [object description], complete and freestanding, shown from a front
three-quarter view at slight elevation with near-orthographic perspective. Clear
primary volumes, visible front and side surfaces, coherent thickness, readable
underside where relevant, distinct non-overlapping components, and a clean
silhouette. [Materials, finish, colors, and a few defining details]. Centered and
isolated with generous margin, neutral studio background, soft even product
lighting, minimal soft contact shadow, sharp focus, square composition. No person,
hand, display stand, environment, floor clutter, open cutaway, exploded view,
cropping, duplicate components, text, logo, or watermark.
```

For a strongly symmetrical object, use a modest three-quarter angle rather than
a perfectly frontal view. The visible side surface gives the reconstruction model
evidence about depth.

## Building or environment prop

```text
One complete freestanding [building or environment prop], compact and fully
contained in frame, front three-quarter isometric-style view with
near-orthographic perspective. The exterior massing, roof, base, entrances, side
walls, and major projections are all visible and structurally coherent. Clean
silhouette, readable depth, consistent [architectural style and materials], and
restrained surface detail. Isolated on a neutral studio background with no
surrounding landscape, vegetation, people, vehicles, sky, or neighboring
structures. Soft even lighting, minimal contact shadow, sharp focus, square
composition, generous margin. No cropped foundation, interior cutaway, floating
parts, text, sign, logo, or watermark.
```

## Why these instructions help

- **One subject:** prevents unrelated geometry from becoming part of the mesh.
- **Complete framing:** gives the model evidence for every required extremity.
- **Near-orthographic perspective:** reduces depth distortion and mismatched
  proportions.
- **Three-quarter view for objects:** exposes depth while retaining a readable
  front face.
- **Front view for riggable characters:** keeps paired joints visible and makes
  later rig placement more reliable.
- **Separated parts:** reduces fused arms, legs, handles, wings, and accessories.
- **Simple background:** improves background removal and preserves thin edges.
- **Even lighting:** prevents a shadow or highlight from being interpreted as a
  geometric feature.
- **Restrained detail:** prioritizes stable large forms before texture detail.

## Source-image quality gate

Do not send the image to Triastasis until all applicable checks pass:

- Exactly one intended subject is present.
- The whole subject fits inside the frame with margin.
- The silhouette is unambiguous at thumbnail size.
- Required limbs, joints, appendages, handles, wheels, or supports are visible.
- Important parts do not merge into the body or each other.
- The view reveals enough depth to infer the back and side volumes.
- Perspective distortion is mild.
- Lighting is even and the background is easy to separate.
- There are no duplicate, missing, floating, or anatomically implausible parts.
- There is no text, watermark, decorative frame, or unwanted ground scenery.

Reject and regenerate a bad source image before spending time on a higher
Triastasis resolution. A higher reconstruction resolution cannot recover geometry
that the source image hides or contradicts.

## Practical generation sequence

1. Generate the source image with the appropriate template.
2. Inspect framing, silhouette, separation, and anatomy before judging fine
   artistic detail.
3. Regenerate the image if the quality gate fails.
4. Run one Triastasis generation at resolution 512 with seed 42.
5. Inspect the resulting model from the front, back, left, and right.
6. Try another seed only when the source image is sound but the reconstruction is
   not.
7. Move to 1024 only after selecting a structurally good 512 result.

The source-image prompt and image-generation seed should be recorded alongside
the Triastasis seed and generation parameters so successful assets can be
reproduced.
