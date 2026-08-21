# Polyloom TODO

## Generation job card

- [ ] Replace the inline `-` minimize control with an `x` icon positioned near the card's top-right corner, with a small outward offset so it appears to sit just outside the card.

## Typography

- [ ] Verify the new Inter UI typeface remains readable across controls, labels, cards, and status text during desktop smoke testing.

## Job persistence and recovery

- [ ] Preserve work-in-progress job state when the generation server or app closes. On restart, recover the job when technically possible; otherwise reconstruct and requeue it from its saved inputs and settings, while clearly identifying interrupted jobs that cannot be resumed.

## Asset cards

- [ ] Fix clipped text in asset and version cards so labels and status messages remain readable within the available card width.

## Reconstruction quality test set

- [ ] Build a controlled set of 10 character reference images similar to the Homer and Mr Burns styles, varying pose, background, lighting, framing, silhouette, and rendering style one factor at a time.
- [ ] Run every reference with fixed generation settings and seeds, preserving the source image, conditioning image, GLB, dimensions, and generation logs.
- [ ] Compare healthy models, fully collapsed planes, and hybrid failures with attached background sheets using depth ratio and vertex concentration measurements.
- [ ] Use the results to identify the model's specific weak inputs and establish a reliable threshold for the planned `background-plane-attached` quality warning.
