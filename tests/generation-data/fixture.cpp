#include "fixture.h"
#define STB_IMAGE_WRITE_IMPLEMENTATION
#include "stb_image_write.h"
#include <fstream>

CaptureFixture::CaptureFixture() : shape(roots.size() * 32), conditioning(1029 * 1024), noise(roots.size() * 32) {
    for (size_t i = 0; i < shape.size(); ++i) { shape[i] = float(i) / 8; noise[i] = -float(i) / 16; }
    for (size_t i = 0; i < conditioning.size(); ++i) conditioning[i] = float(i % 67) / 67;
    coordinates = roots;
    for (int level = 0; level < 4; ++level) {
        std::vector<uint8_t> mask(coordinates.size() * 8);
        std::vector<std::array<int, 3>> next;
        for (size_t p = 0; p < coordinates.size(); ++p) {
            auto c = coordinates[p];
            for (int octant : {0, 7}) {
                mask[p * 8 + octant] = 1;
                next.push_back({c[0] * 2 + (octant & 1), c[1] * 2 + ((octant >> 1) & 1), c[2] * 2 + ((octant >> 2) & 1)});
            }
        }
        masks.push_back(std::move(mask)); coordinates = std::move(next);
    }
}
void CaptureFixture::guide(trellis::GenerationDataCapture& capture) const {
    capture.guide(roots, shape, masks, coordinates, 512, conditioning.data(), 1029, cutout, 2);
}
void CaptureFixture::complete(trellis::GenerationDataCapture& capture, const std::string& glb) const {
    guide(capture); capture.texture_backend(false, false); capture.noise(noise);
    capture.texture_backend(true, false); capture.dense_surface(vertices, faces);
    capture.output_surface(vertices, faces, false); capture.finish(glb);
}
void fixture_models(const std::filesystem::path& directory) {
    std::filesystem::create_directories(directory);
    const char* names[] = {"ss_flow.gguf", "ss_dec.gguf", "shape_flow_512.gguf", "shape_dec.gguf",
                          "tex_flow_512.gguf", "tex_dec.gguf", "dinov3.gguf", "birefnet.gguf"};
    for (size_t i = 0; i < 8; ++i) {
        std::ofstream out(directory / names[i], std::ios::binary);
        if (i == 0) continue;             // SHA-256 empty-message test vector
        if (i == 1) { out << "abc"; continue; }
        for (size_t n = 0; n < (i == 7 ? 1'048'577 : i * 61); ++n) out.put(char(n % 256));
    }
}
void fixture_glb(const std::filesystem::path& path) {
    std::ofstream out(path, std::ios::binary);
    const char bytes[] = {'g','l','T','F',2,0,0,0,12,0,0,0};
    out.write(bytes, sizeof(bytes));
}
