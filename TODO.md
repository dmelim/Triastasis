# Polyloom TODO

## Import experience

- [ ] Show an immediate animated loading state after `Import into Assets` is pressed. Keep the modal visible, replace the primary action's icon/content with a compact spinning circle and concise progress text, disable both modal actions, mark the modal busy for assistive technology, prevent duplicate submissions, and keep the state visible until the gallery record is saved and the model appears. On failure, stop the animation, restore the controls, and show the specific error.
- [ ] Measure the completed-manifest import stages with a representative 10 MB GLB. If validation, binary transfer, gallery persistence, gallery refresh, or model loading introduces avoidable delay, optimize that stage without weakening all-or-nothing validation.

## Sweep recovery

- [ ] Persist every sweep candidate when the sweep is submitted, including the sweep group ID, candidate index/count, seed, settings, source reference, and queued/running lifecycle state. Queued candidates must survive a crash instead of existing only in the in-memory generation queue.
- [ ] Recover an interrupted sweep as one group. Show completed, interrupted, and still-pending candidates; preserve their original order and asset grouping; and provide `Requeue sweep` for only the unfinished candidates so completed candidates are not generated twice.
- [ ] When a recovered sweep finishes, update each candidate's original manifest in place and rebuild the normal seed-sweep gallery entry with the correct candidate count, warnings, and lineage.

## Reconstruction quality follow-up

- [ ] Repeat selected anomalous cases through the CLI backend to preserve the conditioned cutout and native log. The server-backed seed-42 matrix already completed 10/10 and preserved sources, GLBs, dimensions, timings, and exact parameters.
- [ ] Compare healthy models, fully collapsed planes, and hybrid failures with attached background sheets using depth ratio and vertex concentration measurements.
- [ ] Use the classified results to identify weak input patterns and establish a reliable threshold for the planned `background-plane-attached` quality warning.

## Future plans

- [ ] Make imported model animations testable in Inspect. Detect available animation clips and provide compact controls to select a clip, play or pause it, loop it, adjust playback speed, and restart it without modifying the source GLB.

## Test note

- [ ] test relynk
