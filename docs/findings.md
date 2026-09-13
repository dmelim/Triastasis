# Research findings

Short decision index for improvements we may keep. Add an entry whenever an
experiment identifies something useful; link the detailed report rather than
duplicating it here. Record benefits, tradeoffs and a decision status. Candidates
are not production commitments. Unresolved investigations live in the
[research backlog](research-backlog.md).

Priority update (2026-09-13): full-pipeline Q4 versus mixed Q4/Q8 performance
and memory testing is parked until the final evaluation phase, at the user's
request. Explore other potential pipeline improvements first. F01/F02 remain
candidates; their outstanding validation is not the next scheduled task.

| ID | Finding | Decision status | Evidence |
| --- | --- | --- | --- |
| F01 | Q8 material decoding reduces the measured rock striping and closely follows F16 on two tested assets. Colour also changes; the second comparison reduces purple metal tint but shifts wood greener. A useful, modest improvement, not a universal sharpness or fidelity fix. | Candidate: keep for evaluation. Full-pipeline resource validation remains before changing defaults. | [Decoder precision study](decoder-precision-study.md), including second-asset and resource checks. |
| F02 | Replacing only the Q4 bundle's material decoder with Q8 adds 35.9 MB (0.55%) of model payload. Decoder-only timing ranges overlap; this does not establish unchanged low-end requirements. | Supports F01; validate full-pipeline peak memory and target hardware. | [Resource check](decoder-precision-study.md#mixed-bundle-resource-check). |
| F03 | Lossless PNG preserves baked material values; WebP introduced measurable metallic/roughness error in the controlled comparison. PNG was 43% larger for that export. | Candidate: assess material-data encoding separately from base colour before adoption. | [Codec experiment and limits](research-backlog.md#completed-first-experiments), R01. |
| F04 | Project-first sampling reduced some visible bands on the first asset but left residual variation and increased bake cost. Q8 also helps with the existing default sampler. | Retain as evidence; no sampling-default change selected. | [Sampling and precision comparisons](decoder-precision-study.md#production-default-sampling-check), [backlog](research-backlog.md), R02. |
| F05 | Higher face targets improve the crate's clay shading, but the user saw little textured difference across five examples. The crate's WebP GLBs grow about 89%, geometry payload almost doubles and baking takes 2.0–2.1 s versus 1.4 s. | Rejected as a default-change candidate after five-example review. Retain current defaults and existing manual controls; stop further adoption testing for this candidate. | [Geometry and shading study](geometry-shading-study.md), including the final review decision. |
| F06 | On five fixed Q4/box-UV assets, larger atlases preserve finer boundaries but also existing striping. 1024 to 2048 cuts sampling discrepancy against 4096 by 48–53%, which is convergence, not a quality score. Decoded texture storage rises from 8 to 32 MiB; 4096 needs 128 MiB. | Keep defaults. 2048 remains a manual close-view option; no blanket 4096 upgrade supported. | [Material resolution study](material-resolution-study.md#atlas-only-results). |
| F07 | Actual 1024 material changes appearance substantially: less green/banded rock, colour/contrast shifts on toolbox, and loss of many penguin spots. It removes measured missing sample attempts in three pairs but adds about 26–139 seconds of material-stage work. | Asset-specific option, not a universal improvement. Keep defaults and automatic fallback; rock is the strongest positive example, with residual speckling. | [Material-grid results](material-resolution-study.md#material-grid-results), including controls and timing limits. |

Detailed local captures, renders and logs are retained in ignored
`out/material-research/`; the linked reports identify their experiment folders.
Update each decision to adopted, deferred or rejected when reviewed, preserving
the evidence and reason. Last updated: 2026-09-13.
