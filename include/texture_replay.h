#pragma once
#include "generation_data.h"
#include "trellis_args.h"

namespace trellis {
SavedTextureOption replay_texture(const SavedGenerationData& data, const TrellisParams& params,
                                  uint32_t seed, bool original_noise = false);
void bake_texture_option(const SavedGenerationData& data, const SavedTextureOption& option,
                         const std::string& output, int atlas_size, int texture_encoding);
}
