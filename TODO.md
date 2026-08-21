# Polyloom TODO

## Generation job card

- [ ] Make the minimized state substantially smaller.
- [ ] Replace the inline `-` minimize control with an `x` icon positioned near the card's top-right corner, with a small outward offset so it appears to sit just outside the card.
- [ ] Restore meaningful work-in-progress tracking. The card currently remains on `Preparing the job` instead of showing the job's actual stage and progress.

## Typography

- [ ] Replace the current font with a more legible UI typeface and verify readability across controls, labels, cards, and status text.

## Controls

- [ ] Replace native-looking dropdowns with custom select controls styled to match Polyloom, including their closed, open, hover, focus, selected, and disabled states.

## Layout

- [ ] Replace the current island-style layout with full-width, full-height sections that occupy the available space without gaps between panels.
- [ ] Make the bottom `Assets and versions` panel collapsible, or move the library into a dedicated sidebar destination. Choose the interaction that preserves the most workspace while keeping the library easy to reach.

## Job persistence and recovery

- [ ] Preserve work-in-progress job state when the generation server or app closes. On restart, recover the job when technically possible; otherwise reconstruct and requeue it from its saved inputs and settings, while clearly identifying interrupted jobs that cannot be resumed.

## Asset cards

- [ ] Fix clipped text in asset and version cards so labels and status messages remain readable within the available card width.
