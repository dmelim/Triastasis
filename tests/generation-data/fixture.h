#pragma once
#include "generation_data.h"
#include "trellis_args.h"
#include <filesystem>

struct CaptureFixture {
    std::vector<std::array<int, 3>> roots{{1, 2, 3}, {8, 7, 6}}, coordinates;
    std::vector<float> shape, conditioning, noise;
    std::vector<std::vector<uint8_t>> masks;
    std::vector<unsigned char> cutout{10, 20, 30, 0, 40, 50, 60, 255,
                                     70, 80, 90, 128, 100, 110, 120, 255};
    // Deliberately outside the voxel cube: capture must preserve mesh values.
    std::vector<float> vertices{-.6f, 0, 0, 0, .6f, 0, 0, 0, .1f};
    std::vector<int32_t> faces{0, 1, 2};
    CaptureFixture();
    void guide(trellis::GenerationDataCapture& capture) const;
    void complete(trellis::GenerationDataCapture& capture, const std::string& glb) const;
};
void fixture_models(const std::filesystem::path& directory);
void fixture_glb(const std::filesystem::path& path);
