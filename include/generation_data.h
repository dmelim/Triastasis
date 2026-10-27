#pragma once

#include <array>
#include <cstdint>
#include <memory>
#include <string>
#include <vector>

namespace trellis {

struct TrellisParams;

// Optional, per-run capture. Failures affect the sidecar only; the ordinary
// pipeline and GLB remain usable. No model runners or GPU allocations are owned.
class GenerationDataCapture {
public:
    explicit GenerationDataCapture(std::string destination);
    ~GenerationDataCapture();
    GenerationDataCapture(const GenerationDataCapture&) = delete;
    GenerationDataCapture& operator=(const GenerationDataCapture&) = delete;

    void begin(const TrellisParams& params, uint32_t effective_seed, bool birefnet);
    void guide(const std::vector<std::array<int, 3>>& roots,
               const std::vector<float>& normalized_shape,
               const std::vector<std::vector<uint8_t>>& subdivisions,
               const std::vector<std::array<int, 3>>& final_coordinates,
               int texture_resolution, const float* conditioning, int conditioning_tokens,
               const std::vector<unsigned char>& cutout_rgba, int cutout_size);
    void noise(const std::vector<float>& original_noise);
    void texture_backend(bool decoder, bool on_gpu);
    void dense_surface(const std::vector<float>& vertices, const std::vector<int32_t>& faces);
    void output_surface(const std::vector<float>& vertices, const std::vector<int32_t>& faces,
                        bool double_sided);
    void finish(const std::string& source_glb);
    void fail(const std::string& code);

    bool available() const;
    const std::string& path() const;
    const std::string& error_code() const;

private:
    struct State;
    std::unique_ptr<State> state_;
};

// Stream the opt-in HTTP response to disk, without duplicating large bundles
// in RAM. The package is published atomically, with a verified entry table.
void write_generation_package(const std::string& destination, const std::string& glb,
                              const GenerationDataCapture& capture);

struct GenerationSurface { std::vector<float> vertices; std::vector<int32_t> faces; };
struct SavedGenerationData {
    uint32_t seed = 0;
    bool double_sided = false, f32 = false, no_fa = false;
    std::string hash, surface_hash, coordinate_hash, flow_model_hash, decoder_model_hash, copyright;
    std::vector<std::array<int, 3>> roots, coordinates;
    std::vector<std::vector<uint8_t>> subdivisions;
    std::vector<float> shape, conditioning, original_noise;
    GenerationSurface surface, dense;
};
struct SavedTextureOption {
    uint32_t seed = 0;
    bool original_noise = false;
    size_t missing_samples = 0;
    double flow_seconds = 0, decode_seconds = 0, preview_seconds = 0;
    std::vector<float> field, preview;
};
SavedGenerationData read_generation_data(const std::string& path);
void validate_texture_models(const SavedGenerationData& data, const std::string& models);
void write_texture_option(const std::string& path, const SavedGenerationData& data, const SavedTextureOption& option);
SavedTextureOption read_texture_option(const std::string& path, const SavedGenerationData& data);

}  // namespace trellis
