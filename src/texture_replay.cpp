#include "texture_replay.h"
#include "trellis_model.h"
#include "trellis_texture_constants.h"
#include "trellis_progress.h"
#include "flow_runner.h"
#include "shape_decoder.h"
#include "tri_bvh.h"
#include "uv_bake.h"
#include "mesh_glb.h"
#include <algorithm>
#include <chrono>
#include <cmath>
#include <memory>
#include <mutex>
#include <random>
#include <stdexcept>

namespace trellis {
namespace {
double seconds() { return std::chrono::duration<double>(std::chrono::steady_clock::now().time_since_epoch()).count(); }
struct LoadedModel {
    Model model;
    LoadedModel(const std::string& path, int gpu) : model(Model::load(path, gpu)) {}
    ~LoadedModel() { model.free(); }
    LoadedModel(const LoadedModel&) = delete;
};
std::shared_ptr<PbrVertexSampler> surface_sampler(const SavedGenerationData& data) {
    // One immutable source at a time; this is a bounded CPU acceleration cache,
    // not an asset registry. Uploaded bundles are still validated independently.
    static std::mutex mutex;
    static std::string hash;
    static std::shared_ptr<PbrVertexSampler> cached;
    std::lock_guard<std::mutex> lock(mutex);
    if (cached && hash == data.hash) return cached;
    cached.reset(); hash.clear();
    const uint64_t estimate = uint64_t(data.coordinates.size()) * 96 + uint64_t(data.dense.vertices.size()) * 4 + uint64_t(data.dense.faces.size()) * 12;
    if (estimate > 512ull * 1024 * 1024) return {};
    auto sampler = std::make_shared<PbrVertexSampler>(data.coordinates, data.dense.vertices, data.dense.faces);
    cached = sampler; hash = data.hash;
    return sampler;
}
}
SavedTextureOption replay_texture(const SavedGenerationData& data, const TrellisParams& params, uint32_t seed, bool original_noise) {
    validate_texture_models(data, params.models); // Before any model/GPU allocation.
    SavedTextureOption result;
    if (seed == 0) { std::random_device random; seed = random(); if (!seed) seed = 1; }
    if (original_noise && seed != data.seed) throw std::runtime_error("original noise requires the original generation seed");
    result.seed = seed; result.original_noise = original_noise;
    g_sparse_cast_f32 = data.f32; g_no_fa = data.no_fa; g_require_gpu = params.require_gpu; g_cpu_threads = params.threads;
    const int n = int(data.roots.size());
    std::vector<float> latent;
    {
        report_progress("texture_flow", 0, 12, 0, 12, -1);
        LoadedModel loaded(params.models + "/tex_flow_512.gguf", params.gpu);
        DiTParams settings; settings.in_ch = 64; settings.out_ch = 32; settings.d_cond = 1024; settings.cast_f32 = data.f32;
        std::unique_ptr<DitRunner> runner(make_sparse_runner(loaded.model, settings, data.roots, 1029));
        FlowFwd forward = [&](const std::vector<float>& state, float time, const float* conditioning) {
            std::vector<float> concatenated(size_t(n) * 64);
            for (int token = 0; token < n; ++token) for (int channel = 0; channel < 32; ++channel) {
                concatenated[size_t(token) * 64 + channel] = state[size_t(token) * 32 + channel];
                concatenated[size_t(token) * 64 + 32 + channel] = data.shape[size_t(token) * 32 + channel];
            }
            return runner->forward(concatenated, time, conditioning);
        };
        std::vector<float> noise;
        if (original_noise) noise = data.original_noise;
        else {
            std::mt19937 generator(seed); std::normal_distribution<float> distribution(0, 1);
            noise.resize(size_t(n) * 32); for (auto& value : noise) value = distribution(generator);
        }
        std::vector<float> negative(data.conditioning.size(), 0);
        SamplerParams sampler; sampler.steps = 12; sampler.guidance_strength = 1; sampler.guidance_rescale = 0;
        sampler.gi0 = .6f; sampler.gi1 = .9f; sampler.rescale_t = 3;
        double start = seconds();
        latent = sample_flow(forward, std::move(noise), data.conditioning.data(), negative.data(), sampler, nullptr,
            [](int done, int total, double eta) { report_progress("texture_flow", done, total, done, total, eta); });
        result.flow_seconds = seconds() - start;
        if (latent.size() != size_t(n) * 32) throw std::runtime_error("texture flow output dimensions differ from the saved guide");
        for (size_t i = 0; i < latent.size(); ++i) latent[i] = latent[i] * TEX_STD[i % 32] + TEX_MEAN[i % 32];
    }
    {
        report_progress("texture_decode", 0, 0, 0, 0, -1);
        LoadedModel loaded(params.models + "/tex_dec.gguf", params.gpu);
        double start = seconds();
        auto raw = tex_decode(loaded.model, latent, data.roots, data.subdivisions);
        result.decode_seconds = seconds() - start;
        if (raw.size() != data.coordinates.size() * 6) throw std::runtime_error("texture decoder output dimensions differ from the saved guide");
        result.field.resize(raw.size());
        for (size_t i = 0; i < raw.size(); ++i) {
            if (!std::isfinite(raw[i])) throw std::runtime_error("texture decoder produced a nonfinite material value");
            result.field[i] = std::clamp(raw[i] * .5f + .5f, 0.f, 1.f);
        }
    }
    latent.clear(); latent.shrink_to_fit();
    report_progress("texture_preview", 0, 0, 0, 0, -1);
    double start = seconds();
    auto sampler = surface_sampler(data);
    if (sampler) result.missing_samples = sampler->sample(data.surface.vertices, result.field, result.preview);
    else {
        auto bvh = TriBvh::build(data.dense.vertices.data(), int(data.dense.vertices.size()/3), data.dense.faces.data(), int(data.dense.faces.size()/3));
        VoxelPbr field{&data.coordinates, &result.field, 512, &bvh};
        result.missing_samples = sample_pbr_vertices(data.surface.vertices, field, result.preview);
    }
    result.preview_seconds = seconds() - start;
    return result;
}
void bake_texture_option(const SavedGenerationData& data, const SavedTextureOption& option, const std::string& output, int atlas_size, int texture_encoding) {
    if (atlas_size < 128 || atlas_size > 4096 || option.field.size() != data.coordinates.size() * 6)
        throw std::runtime_error("invalid selected-field bake inputs");
    report_progress("texture_bake", 0, 0, 0, 0, -1);
    auto sampler = surface_sampler(data);
    std::unique_ptr<TriBvh> local;
    if (!sampler) local = std::make_unique<TriBvh>(TriBvh::build(data.dense.vertices.data(), int(data.dense.vertices.size()/3), data.dense.faces.data(), int(data.dense.faces.size()/3)));
    VoxelPbr field{&data.coordinates, &option.field, 512, sampler ? &sampler->snap() : local.get()};
    auto baked = uv_bake(data.surface.vertices, int(data.surface.vertices.size() / 3), data.surface.faces, int(data.surface.faces.size() / 3), {}, atlas_size, &field);
    if (!baked.ok()) throw std::runtime_error("xatlas could not bake the selected texture; the selected field can be retried");
    if (!write_glb_textured(output.c_str(), baked.verts.data(), int64_t(baked.verts.size() / 3), baked.uv.data(),
                           baked.faces.data(), int64_t(baked.faces.size() / 3), baked.base.data(), baked.mr.data(), baked.T,
                           data.double_sided, option.seed, data.copyright.empty() ? nullptr : data.copyright.c_str(), texture_encoding != 0))
        throw std::runtime_error("the baked model could not be written");
}
}  // namespace trellis
