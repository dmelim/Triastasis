// Developer-only replay of TRELLIS_TEX_TRACE_DIR inputs. No flow or mesh work.
#include "trellis_model.h"
#include "shape_decoder.h"
#include <array>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <limits>
#include <stdexcept>
#include <vector>

namespace fs = std::filesystem;

template<class T> static std::vector<T> read_array(const fs::path& path) {
    const auto bytes = fs::file_size(path);
    if (!bytes || bytes % sizeof(T) || bytes > size_t(std::numeric_limits<int>::max()) * 32)
        throw std::runtime_error("invalid array size: " + path.string());
    std::vector<T> data(bytes / sizeof(T));
    std::ifstream f(path, std::ios::binary);
    if (!f.read(reinterpret_cast<char*>(data.data()), bytes))
        throw std::runtime_error("cannot read " + path.string());
    return data;
}

int main(int argc, char** argv) {
    if (argc < 4 || argc > 5) {
        std::cerr << "usage: " << argv[0] << " <tex_dec.gguf> <capture-dir> <new-output-dir> [gpu=0]\n";
        return 1;
    }
    trellis::Model model;
    try {
        static_assert(sizeof(int) == 4 && sizeof(float) == 4);
        const fs::path input(argv[2]), output(argv[3]);
        const int gpu = argc == 5 ? std::stoi(argv[4]) : 0;
        auto coords = read_array<std::array<int, 3>>(input / "input.coords.i32");
        auto latent = read_array<float>(input / "input.latent.f32");
        if (coords.size() > size_t(std::numeric_limits<int>::max()) || latent.size() != coords.size()*32)
            throw std::runtime_error("latent/coordinate size mismatch");
        for (float v : latent) if (!std::isfinite(v)) throw std::runtime_error("nonfinite latent");
        size_t rows = coords.size();
        std::vector<std::vector<uint8_t>> masks;
        for (int stage = 0; stage < 4; ++stage) {
            auto mask = read_array<uint8_t>(input / ("guide-" + std::to_string(stage) + ".u8"));
            if (mask.size() != rows*8) throw std::runtime_error("guide size mismatch");
            rows = 0;
            for (auto v : mask) {
                if (v > 1) throw std::runtime_error("guide must contain only 0/1");
                rows += v;
            }
            if (!rows || rows > size_t(std::numeric_limits<int>::max()))
                throw std::runtime_error("invalid child count");
            masks.push_back(std::move(mask));
        }
        // Require a new directory so research evidence cannot be overwritten.
        if (!fs::create_directory(output)) throw std::runtime_error("output directory already exists");
        const auto start = std::chrono::steady_clock::now();
        model = trellis::Model::load(argv[1], gpu);
        if (model.arch != "trellis2-tex-dec") throw std::runtime_error("expected texture decoder architecture");
        if (gpu >= 0 && !model.on_gpu) throw std::runtime_error("requested GPU unavailable");
        const auto loaded = std::chrono::steady_clock::now();
        auto raw = trellis::tex_decode(model, latent, coords, masks);
        const auto decoded = std::chrono::steady_clock::now();
        if (raw.size() != rows*6) throw std::runtime_error("unexpected output shape");
        for (float v : raw) if (!std::isfinite(v)) throw std::runtime_error("nonfinite output");
        std::ofstream f(output / "output.raw.f32", std::ios::binary);
        f.write(reinterpret_cast<const char*>(raw.data()), raw.size()*sizeof(float));
        f.close();
        if (!f) throw std::runtime_error("output write failed");
        std::ofstream report(output / "replay.json");
        report << "{\"input_rows\":" << coords.size() << ",\"output_rows\":" << rows
               << ",\"gpu\":" << gpu << ",\"load_seconds\":"
               << std::chrono::duration<double>(loaded-start).count() << ",\"decode_seconds\":"
               << std::chrono::duration<double>(decoded-loaded).count() << "}\n";
        report.close();
        if (!report) throw std::runtime_error("report write failed");
        model.free();
        std::cout << "[tex-replay] decoded " << rows << " rows\n";
        return 0;
    } catch (const std::exception& e) {
        model.free();
        std::cerr << "[tex-replay] " << e.what() << '\n';
        return 1;
    }
}
