#include "fixture.h"
#include "bundle_json.h"
#include <fstream>
#include <iostream>
#include <limits>
#include <iterator>
#include <stdexcept>

namespace fs = std::filesystem;
void check(bool value, const char* message) { if (!value) throw std::runtime_error(message); }

int main(int argc, char** argv) {
    try {
        check(argc == 2, "output directory required"); fs::path root(argv[1]); fs::create_directories(root);
        trellis::TrellisParams params; params.set_res(512); params.models = (root / "models").string();
        fixture_models(params.models); fixture_glb(root / "model.glb");
        CaptureFixture fixture;
        for (const std::string invalid : {"{\"a\":1,\"a\":2}", "[01]", "[1e+]", "[NaN]", "\"\\uD800\""}) {
            bool rejected = false;
            try { trellis::bundle_json::Parser(invalid).parse(); } catch (const std::exception&) { rejected = true; }
            check(rejected, "JSON reader accepted invalid or ambiguous input");
        }
        {
            trellis::GenerationDataCapture capture((root / "generation.trg").string());
            capture.begin(params, 42, true); fixture.complete(capture, (root / "model.glb").string());
            check(capture.available(), "valid capture failed");
            trellis::write_generation_package((root / "generation.trgpk").string(), (root / "model.glb").string(), capture);
            auto saved = trellis::read_generation_data(capture.path());
            check(saved.roots == fixture.roots && saved.coordinates == fixture.coordinates && saved.shape == fixture.shape &&
                  saved.conditioning == fixture.conditioning && saved.original_noise == fixture.noise, "saved input round trip changed values");
            trellis::validate_texture_models(saved, params.models);
            trellis::SavedTextureOption option; option.seed = 9;
            option.field.assign(saved.coordinates.size() * 6, .5f); option.preview.assign(saved.surface.vertices.size() * 2, .5f);
            auto option_path = (root / "option.tropt").string();
            trellis::write_texture_option(option_path, saved, option);
            auto selected = trellis::read_texture_option(option_path, saved);
            check(selected.seed == 9 && selected.field == option.field && selected.preview == option.preview, "selected field round trip changed values");
            saved.hash[0] = saved.hash[0] == 'a' ? 'b' : 'a';
            bool rejected = false;
            try { trellis::read_texture_option(option_path, saved); } catch (const std::exception&) { rejected = true; }
            check(rejected, "option accepted a different source bundle");
            std::ifstream source(capture.path(), std::ios::binary);
            const std::string original((std::istreambuf_iterator<char>(source)), std::istreambuf_iterator<char>());
            const std::vector<std::pair<std::string, std::string>> mutations{
                {"\"offset\":0", "\"offset\":8"}, {"float32-le", "float64-le"},
                {"textured-512-v1", "textured-102-v1"},
                {"\"hierarchy_counts\":[2,4,8,16,32]", "\"hierarchy_counts\":[2,4,8,16,31]"},
                {"\"to_asset_transform\":[1,0", "\"to_asset_transform\":[0,0"}};
            size_t mutation_index = 0;
            for (const auto& mutation : mutations) {
                auto changed = original;
                auto offset = changed.find(mutation.first); check(offset != std::string::npos, "invalid metadata test fixture");
                changed.replace(offset, mutation.first.size(), mutation.second);
                auto path = root / ("invalid-metadata-" + std::to_string(mutation_index++) + ".trg");
                std::ofstream out(path, std::ios::binary); out.write(changed.data(), std::streamsize(changed.size())); out.close();
                bool rejected = false;
                try { trellis::read_generation_data(path.string()); } catch (const std::exception&) { rejected = true; }
                check(rejected, "native reader accepted invalid metadata");
            }
        }
        for (int mode = 0; mode < 12; ++mode) {
            auto invalid = fixture; auto p = params;
            std::string path = (root / ("invalid-" + std::to_string(mode) + ".trg")).string();
            if (mode == 0) p.texture = false;
            if (mode == 1) p.set_res(1024);
            if (mode == 2) invalid.coordinates[0][0]++;
            if (mode == 3) invalid.masks[0][0] = 2;
            if (mode == 4) invalid.shape[0] = std::numeric_limits<float>::quiet_NaN();
            if (mode == 5) invalid.faces[0] = 3;
            if (mode == 6) invalid.noise.pop_back();
            if (mode == 7) invalid.conditioning[123] = std::numeric_limits<float>::infinity();
            if (mode == 8) invalid.cutout.pop_back();
            if (mode == 9) invalid.roots[1] = invalid.roots[0];
            if (mode == 10) path = (root / "missing-parent" / "invalid.trg").string();
            if (mode == 11) p.models = (root / "missing-models").string();
            trellis::GenerationDataCapture capture(path); capture.begin(p, 42, false);
            invalid.complete(capture, (root / "model.glb").string());
            check(!capture.available() && !capture.error_code().empty(), "invalid capture became available");
            check(!fs::exists(path), "invalid capture published a partial bundle");
            check(fs::file_size(root / "model.glb") == 12, "capture failure changed ordinary GLB");
            if (mode == 0) {
                check(capture.error_code() == "unsupported_capture_profile", "wrong unsupported-profile code");
                trellis::write_generation_package((root / "unsupported.trgpk").string(), (root / "model.glb").string(), capture);
            }
        }
        {
            trellis::GenerationDataCapture capture((root / "generation.trg").string());
            capture.begin(params, 42, false); fixture.complete(capture, (root / "model.glb").string());
            check(!capture.available(), "capture overwrote an existing bundle");
        }
        {
            trellis::GenerationDataCapture capture((root / "incomplete.trg").string());
            capture.begin(params, 42, false); fixture.guide(capture); capture.finish((root / "model.glb").string());
            check(!capture.available() && !fs::exists(capture.path()), "incomplete capture published");
        }
        {
            trellis::GenerationDataCapture capture((root / "tampered.trg").string());
            capture.begin(params, 42, false); fixture.guide(capture); capture.noise(fixture.noise);
            capture.texture_backend(false, false); capture.texture_backend(true, false);
            capture.dense_surface(fixture.vertices, fixture.faces); capture.output_surface(fixture.vertices, fixture.faces, false);
            for (const auto& entry : fs::directory_iterator(root)) {
                if (entry.path().filename().string().find("tampered.trg.capture-") != 0) continue;
                std::fstream payload(entry.path() / "payload", std::ios::binary | std::ios::in | std::ios::out);
                payload.put('\x7f'); payload.close();
            }
            capture.finish((root / "model.glb").string());
            check(!capture.available() && !fs::exists(capture.path()), "corrupt staging payload was published");
        }
        {
            trellis::GenerationDataCapture capture((root / "changed-during-run.trg").string());
            capture.begin(params, 42, false);
            std::ofstream model(fs::path(params.models) / "ss_dec.gguf", std::ios::binary); model << "abcd"; model.close();
            fixture.complete(capture, (root / "model.glb").string());
            check(!capture.available() && !fs::exists(capture.path()), "capture accepted a model changed during generation");
        }
        {
            // A deliberate model change between runs is supported and must
            // invalidate the previous cached digest, rather than mislabel it.
            trellis::GenerationDataCapture capture((root / "changed-between-runs.trg").string());
            capture.begin(params, 42, false); fixture.complete(capture, (root / "model.glb").string());
            check(capture.available(), "capture rejected a valid changed model set");
            std::ofstream model(fs::path(params.models) / "ss_dec.gguf", std::ios::binary); model << "abc";
        }
        for (const auto& entry : fs::directory_iterator(root))
            check(entry.path().filename().string().find(".capture-") == std::string::npos, "temporary capture leaked");
        std::cout << "PASS: capture, 12 invalid states, overwrite protection, incomplete capture, staging corruption, model changes, cleanup\n";
        return 0;
    } catch (const std::exception& error) { std::cerr << error.what() << '\n'; return 1; }
}
