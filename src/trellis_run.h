#pragma once
#include "trellis_args.h"

namespace trellis { class GenerationDataCapture; }

// Run the full TRELLIS.2 image->3D pipeline described by `p`: reconstruct
// `p.image` into a textured GLB at `p.output`. Returns 0 on success. All
// behavior (resolution, bg removal, texture, guidance, ...) comes from `p`,
// which trellis-cli / trellis-server populate via trellis::parse_args.
int trellis_run(const trellis::TrellisParams& p);

// Opt-in capture for supported texture guides. The original entry point keeps
// its behavior and ABI; sidecar errors never turn a good GLB into a failed run.
int trellis_run(const trellis::TrellisParams& p, trellis::GenerationDataCapture* capture);
