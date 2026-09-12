// FlexiDualGrid shape VAE decoder: shape SLAT latent -> dual-grid head [7, M] @ res 512.
#pragma once
#include <vector>
#include <array>
#include <cstdint>

namespace trellis {
struct Model;

struct ShapeOut {
    std::vector<float> feats7;                 // [M,7] row-major: channels contiguous per voxel (ggml ne0=7)
    std::vector<std::array<int,3>> coords;     // [M] voxel coords at final resolution
    int res = 512;
    std::vector<std::vector<uint8_t>> subs;    // per-C2S binarized subdiv masks (for the tex decoder)
};

// latent: shape SLAT feats [N0,32] row-major (flat channel + 32*voxel); coords0: active voxels. resolution = final
// grid size (coords0 res * 16): 512 for res-32 input, 1024 for res-64 input (cascade HR).
ShapeOut shape_decode(const Model& m, const std::vector<float>& latent,
                      const std::vector<std::array<int,3>>& coords0, int resolution = 512);

// Cascade upsample: run from_latent + the 4 C2S up-blocks and return the grown voxel coords
// (input res * 16), discarding feats. Used by the 1024 cascade to get fine coords from the LR slat.
std::vector<std::array<int,3>> shape_upsample(const Model& m, const std::vector<float>& latent,
                                              const std::vector<std::array<int,3>>& coords0);

// Texture (PBR) decoder: SparseUnetVaeDecoder driven by the shape decoder's `subs` so it grows
// the IDENTICAL voxel tree. tex_latent: [N0,32] row-major; returns PBR [M,6] row-major at the
// SAME final coords/order as shape_decode (base_color3, metallic, roughness, alpha) — pre *0.5+0.5.
std::vector<float> tex_decode(const Model& m, const std::vector<float>& tex_latent,
                              const std::vector<std::array<int,3>>& coords0,
                              const std::vector<std::vector<uint8_t>>& subs);

} // namespace trellis
