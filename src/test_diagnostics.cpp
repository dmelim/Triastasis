// Synthetic CPU-only diagnostics checks; no model weights or user assets.
#include "trellis_diagnostics.h"
#include "flow_runner.h"
#include "uv_bake.h"
#include "mesh_glb.h"
#include "tri_bvh.h"
#include <cmath>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <limits>
#include <stdexcept>

namespace diag = trellis::diagnostics;
static void check(bool value, const char* message) {
    if (!value) throw std::runtime_error(message);
}
static std::string read(FILE* file) {
    std::fflush(file); std::rewind(file);
    std::string result;
    char buf[4096];
    while (size_t n = std::fread(buf, 1, sizeof(buf), file)) result.append(buf, n);
    return result;
}
int main(int argc, char** argv) {
    if (argc != 2) { std::cerr << "usage: trellis-test-diagnostics <scratch-directory>\n"; return 2; }
    try {
        const auto root = std::filesystem::u8path(argv[1]);
        std::filesystem::create_directories(root);
        FILE* sink = std::tmpfile();
        check(sink != nullptr, "temporary log");
        const auto nan = std::numeric_limits<float>::quiet_NaN();
        diag::Stats stats;
        for (double v : {0.0, 0.5, 1.0, double(nan)}) stats.add(v);
        check(stats.count == 3 && stats.nonfinite == 1 && stats.mean == 0.5, "finite statistics");
        check(stats.min == 0 && stats.max == 1 && stats.low == 1 && stats.high == 1, "threshold statistics");
        check(diag::quote("a\n\"\\") == "\"a\\u000a\\\"\\\\\"", "JSON escaping");
        check(diag::number(nan) == "null", "nonfinite JSON");
        {
            diag::Session disabled(42, false, sink, root / "disabled");
            diag::tensor("disabled", {1, nan});
        }
        check(!std::filesystem::exists(root / "disabled") && read(sink).empty(), "disabled is silent");

        // Constant material on a tiny planar triangle. All three UV methods must
        // return exactly the same arrays with diagnostics enabled and disabled.
        const std::vector<float> verts{-0.25f,-0.25f,0.0625f, 0.25f,-0.25f,0.0625f, 0,0.25f,0.0625f};
        const std::vector<int32_t> faces{0,1,2};
        std::vector<std::array<int,3>> coords;
        std::vector<float> pbr;
        for (int x = 0; x < 8; ++x) for (int y = 0; y < 8; ++y) {
            coords.push_back({x,y,4});
            pbr.insert(pbr.end(), {0.2f,0.4f,0.6f,0.8f,0.3f,1.0f});
        }
        trellis::VoxelPbr vox{&coords, &pbr, 8, nullptr};
        {
            const auto bvh = trellis::TriBvh::build(verts.data(), 3, faces.data(), 1);
            const auto probes = trellis::probe_voxel_samples(
                trellis::VoxelPbr{&coords, &pbr, 8, &bvh},
                {{0,0,0.125f}, {0,0,0.3125f}, {0,0,1.5f}});
            check(probes.size() == 3, "probe count");
            check(probes[0].direct_valid && probes[0].projected_valid &&
                std::fabs(probes[0].direct_support - 0.5f) < 1e-6f &&
                std::fabs(probes[0].projected_support - 1.f) < 1e-6f &&
                probes[0].direct_corners == 4 && probes[0].projected_corners == 4 &&
                std::fabs(probes[0].distance_voxels - 0.5f) < 1e-6f,
                "probe sparse support and projection distance");
            for (int c = 0; c < 6; ++c)
                check(std::fabs(probes[0].direct[c] - pbr[c]) < 1e-6f &&
                    std::fabs(probes[0].projected[c] - pbr[c]) < 1e-6f,
                    "probe renormalizes constant sparse field");
            check(!probes[1].direct_valid && probes[1].projected_valid,
                "probe distinguishes absent direct sample");
            check(probes[2].projected_face == -1 && !probes[2].projected_valid,
                "probe respects bounded projection");
        }
        using Bake = trellis::BakedMesh(*)(const std::vector<float>&, int,
            const std::vector<int32_t>&, int, const std::vector<float>&, int, const trellis::VoxelPbr*);
        for (Bake bake : {trellis::uv_bake, trellis::uv_box_project, trellis::uv_chart_project}) {
            auto baseline = bake(verts, 3, faces, 1, {}, 32, &vox);
            diag::Session measured(42, true, sink, root);
            auto observed = bake(verts, 3, faces, 1, {}, 32, &vox);
            check(observed.ok(), "synthetic bake succeeded");
            check(baseline.verts == observed.verts && baseline.faces == observed.faces &&
                baseline.uv == observed.uv && baseline.base == observed.base && baseline.mr == observed.mr,
                "diagnostics changed baked output");
            check(trellis::write_glb_textured((root / "synthetic.glb").string().c_str(),
                observed.verts.data(), observed.verts.size()/3, observed.uv.data(), observed.faces.data(),
                observed.faces.size()/3, observed.base.data(), observed.mr.data(), observed.T), "GLB encoding");
            check(trellis::write_glb_textured((root / "synthetic-png.glb").string().c_str(),
                observed.verts.data(), observed.verts.size()/3, observed.uv.data(), observed.faces.data(),
                observed.faces.size()/3, observed.base.data(), observed.mr.data(), observed.T,
                false, -1, nullptr, false), "explicit PNG encoding");
            measured.finish("completed");
        }
        {
            diag::Session measured(42, true, sink, root);
            diag::pbr("raw", {-2,0,2,nan,1,-1}, 0.5, 0.5);
            diag::tensor("empty", {});
            const std::vector<uint8_t> empty_mask{0};
            diag::atlas("empty_mask", {0,0,0,255}, {0,128,255,255}, &empty_mask);
            {
                diag::Session nested(42, false, sink);
                check(!diag::enabled(), "nested disable");
            }
            check(diag::enabled(), "session restoration");
            trellis::SamplerParams sp; sp.steps = 2; sp.guidance_strength = 1;
            const std::vector<float> initial{1,2};
            auto forward = [nan](const std::vector<float>& v, float, const float*) {
                return std::vector<float>(v.size(), nan);
            };
            diag::Stage sampling("synthetic_sampler");
            const auto result = trellis::sample_flow(forward, initial, nullptr, nullptr, sp);
            check(result == initial, "velocity guard unchanged");
            sampling.end();
            // No finish: should produce incomplete, not a false success.
        }
        {
            const auto blocked = root / "is-a-file";
            std::ofstream(blocked) << "fixture";
            diag::Session measured(42, true, sink, blocked);
            measured.finish("completed");
        }
        // Exercise both ratio bounds and verify measuring does not change the
        // safeguarded trajectory. At t=1 these produce ratios ~0.01 and ~100.
        for (bool upper : {false, true}) {
            trellis::SamplerParams sp; sp.steps = 1; sp.guidance_strength = 2;
            sp.guidance_rescale = 0.5f; sp.gi0 = 0; sp.gi1 = 1;
            float positive = 1, negative = 0;
            const std::vector<float> initial{1,-1,2,-2};
            auto forward = [upper, &positive](const std::vector<float>& v, float, const float* condition) {
                auto result = v;
                const float scale = upper ? (condition == &positive ? 0.f : -0.99f)
                                          : (condition == &positive ? 0.99f : 0.f);
                for (auto& x : result) x *= scale;
                return result;
            };
            std::vector<float> baseline;
            { diag::Session off(42, false, sink);
              baseline = trellis::sample_flow(forward, initial, &positive, &negative, sp); }
            { diag::Session on(42, true, sink, root);
              check(baseline == trellis::sample_flow(forward, initial, &positive, &negative, sp),
                    "ratio diagnostics changed sampler output"); on.finish("completed"); }
        }
        const auto log = read(sink);
        std::fclose(sink);
        check(log.find("\"status\":\"incomplete\"") != std::string::npos, "incomplete run status");
        check(log.find("cannot_create_log") != std::string::npos, "storage failure reported");
        check(log.find("\"replaced_velocity\":2") != std::string::npos, "corrections counted before sanitizing");
        check(log.find("\"nonfinite\":1") != std::string::npos, "nonfinite material measured");
        check(log.find("\"effective\":\"png\"") != std::string::npos, "PNG choice measured");
        check(log.find("\"guidance_ratio_reason\":\"lower_bound\"") != std::string::npos, "lower ratio bound measured");
        check(log.find("\"guidance_ratio_reason\":\"upper_bound\"") != std::string::npos, "upper ratio bound measured");
        check(log.find("\"guidance_ratio_evaluated\":false") != std::string::npos, "unevaluated ratio explicit");
        std::ofstream(root / "captured.log") << log;
        size_t stored = 0;
        for (const auto& file : std::filesystem::directory_iterator(root)) {
            if (file.path().extension() == ".jsonl") {
                ++stored;
                std::ifstream input(file.path());
                const std::string content((std::istreambuf_iterator<char>(input)), {});
                check(content.find("\"event\":\"run_start\"") != std::string::npos &&
                    content.find("\"event\":\"run_end\"") != std::string::npos, "persisted lifecycle");
            }
        }
        check(stored >= 4, "per-run stored files");
        std::cout << "Diagnostics checks passed\n";
        return 0;
    } catch (const std::exception& e) { std::cerr << e.what() << '\n'; return 1; }
}
