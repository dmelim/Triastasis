#include "generation_data.h"
#include "trellis_args.h"
#include "stb_image_write.h"
#include "bundle_json.h"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <functional>
#include <iomanip>
#include <limits>
#include <map>
#include <mutex>
#include <sstream>
#include <stdexcept>

#ifndef TRELLIS_BUILD_BACKEND
#define TRELLIS_BUILD_BACKEND "cpu"
#endif
#ifndef TRIASTASIS_VERSION
#define TRIASTASIS_VERSION "development"
#endif
#ifndef TRELLIS_GIT_COMMIT
#define TRELLIS_GIT_COMMIT ""
#endif
#ifndef TRELLIS_GIT_DIRTY
#define TRELLIS_GIT_DIRTY 1
#endif

namespace trellis {
namespace {
namespace fs = std::filesystem;
constexpr uint64_t MAX_BUNDLE_BYTES = 512ull * 1024 * 1024;
constexpr uint64_t MAX_ROOTS = 32 * 32 * 32;
constexpr uint64_t MAX_VOXELS = 9'000'000;
constexpr uint64_t MAX_VERTICES = 15'000'000;
constexpr uint64_t MAX_TRIANGLES = 30'000'000;
constexpr uint64_t MAX_MANIFEST_BYTES = 1024 * 1024;
static_assert(sizeof(float) == 4 && std::numeric_limits<float>::is_iec559, "IEEE float32 required");
static_assert(sizeof(int) == 4, "32-bit native coordinates required");
static_assert(sizeof(std::array<int, 3>) == 12, "packed coordinate triples required");

void require(bool valid, const char* message) {
    if (!valid) throw std::runtime_error(message);
}

// FIPS 180-4 SHA-256, including streamed files. No platform crypto runtime or
// new third-party dependency is needed for the portable native bundle format.
class Sha256 {
    uint32_t state_[8] = {0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
                          0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19};
    unsigned char block_[64]{};
    size_t used_ = 0;
    uint64_t bytes_ = 0;
    static uint32_t rotate(uint32_t x, unsigned n) { return (x >> n) | (x << (32 - n)); }
    void transform() {
        static constexpr uint32_t k[64] = {
            0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
            0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
            0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
            0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
            0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
            0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
            0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
            0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2};
        uint32_t w[64];
        for (int i = 0; i < 16; ++i) {
            const auto* b = block_ + i * 4;
            w[i] = (uint32_t(b[0]) << 24) | (uint32_t(b[1]) << 16) | (uint32_t(b[2]) << 8) | b[3];
        }
        for (int i = 16; i < 64; ++i) {
            uint32_t a = w[i-15], b = w[i-2];
            w[i] = w[i-16] + (rotate(a,7)^rotate(a,18)^(a>>3)) + w[i-7] + (rotate(b,17)^rotate(b,19)^(b>>10));
        }
        uint32_t a=state_[0], b=state_[1], c=state_[2], d=state_[3],
                 e=state_[4], f=state_[5], g=state_[6], h=state_[7];
        for (int i = 0; i < 64; ++i) {
            uint32_t t1 = h + (rotate(e,6)^rotate(e,11)^rotate(e,25)) + ((e&f)^(~e&g)) + k[i] + w[i];
            uint32_t t2 = (rotate(a,2)^rotate(a,13)^rotate(a,22)) + ((a&b)^(a&c)^(b&c));
            h=g; g=f; f=e; e=d+t1; d=c; c=b; b=a; a=t1+t2;
        }
        state_[0]+=a; state_[1]+=b; state_[2]+=c; state_[3]+=d;
        state_[4]+=e; state_[5]+=f; state_[6]+=g; state_[7]+=h;
    }
public:
    void add(const void* data, size_t size) {
        const auto* cursor = static_cast<const unsigned char*>(data);
        bytes_ += size;
        while (size) {
            size_t n = std::min(size, sizeof(block_) - used_);
            std::memcpy(block_ + used_, cursor, n);
            used_ += n; cursor += n; size -= n;
            if (used_ == sizeof(block_)) { transform(); used_ = 0; }
        }
    }
    std::string finish() {
        uint64_t bits = bytes_ * 8;
        unsigned char pad = 0x80, zero = 0;
        add(&pad, 1);
        while (used_ != 56) add(&zero, 1);
        unsigned char length[8];
        for (int i = 0; i < 8; ++i) length[i] = static_cast<unsigned char>(bits >> (56 - i * 8));
        add(length, 8);
        std::ostringstream out;
        out << std::hex << std::setfill('0');
        for (uint32_t x : state_) out << std::setw(8) << x;
        return out.str();
    }
};

using Consumer = std::function<void(const void*, size_t)>;
void file_chunks(const fs::path& path, const Consumer& consume) {
    std::ifstream in(path, std::ios::binary);
    require(bool(in), "cannot read bundle input");
    std::vector<char> buffer(1024 * 1024);
    while (in) {
        in.read(buffer.data(), std::streamsize(buffer.size()));
        if (in.gcount()) consume(buffer.data(), size_t(in.gcount()));
    }
    require(in.eof(), "bundle input read failed");
}
std::string hash_memory(const void* data, size_t size) {
    Sha256 hash; hash.add(data, size); return hash.finish();
}
std::string hash_file(const fs::path& path) {
    Sha256 hash; file_chunks(path, [&](const void* data, size_t n) { hash.add(data, n); });
    return hash.finish();
}

// Cache only file digests, never weights. A changed file is rehashed. Paths are
// used internally as cache keys and are never written into portable manifests.
std::string model_hash(const fs::path& path) {
    struct Cached { uintmax_t bytes; fs::file_time_type modified; std::string hash; };
    static std::map<fs::path, Cached> cache;
    static std::mutex mutex;
    auto canonical = fs::canonical(path);
    auto size = fs::file_size(canonical);
    auto modified = fs::last_write_time(canonical);
    std::lock_guard<std::mutex> lock(mutex);
    auto found = cache.find(canonical);
    if (found != cache.end() && found->second.bytes == size && found->second.modified == modified)
        return found->second.hash;
    auto hash = hash_file(canonical);
    require(fs::file_size(canonical) == size && fs::last_write_time(canonical) == modified,
            "model changed during capture");
    if (cache.size() >= 32) cache.clear();
    cache[canonical] = {size, modified, hash};
    return hash;
}

std::string quote(const std::string& value) {
    std::ostringstream out; out << '"';
    for (unsigned char c : value) {
        if (c == '"' || c == '\\') out << '\\' << char(c);
        else if (c < 32) out << "\\u00" << std::hex << std::setw(2) << std::setfill('0') << int(c);
        else out << char(c);
    }
    out << '"'; return out.str();
}
void u32(std::ostream& out, uint32_t value) {
    unsigned char bytes[4];
    for (int i = 0; i < 4; ++i) bytes[i] = static_cast<unsigned char>(value >> (i * 8));
    out.write(reinterpret_cast<const char*>(bytes), 4);
}
uint64_t aligned(uint64_t n) { require(n <= MAX_BUNDLE_BYTES, "bundle size limit exceeded"); return (n + 7) & ~uint64_t(7); }
void zeros(std::ostream& out, uint64_t count) {
    const char pad[8]{}; require(count <= 7, "invalid padding"); out.write(pad, std::streamsize(count));
}

struct Entry { std::string name; uint64_t offset, bytes; std::string hash, representation; };

class ContainerWriter {
    fs::path destination_, workspace_;
    std::ofstream payload_;
    uint64_t bytes_ = 0;
    std::vector<Entry> entries_;
public:
    explicit ContainerWriter(const fs::path& destination) : destination_(destination) {
        const uint32_t endian = 1;
        require(*reinterpret_cast<const unsigned char*>(&endian) == 1, "little-endian native arrays required");
        require(!fs::exists(destination_), "bundle destination already exists");
        static std::atomic<uint64_t> serial{0};
        auto stamp = std::chrono::steady_clock::now().time_since_epoch().count();
        // A private sibling directory prevents partial-file collisions between
        // concurrent server processes and keeps the final rename on one volume.
        for (int attempt = 0; attempt < 32; ++attempt) {
            workspace_ = destination_.string() + ".capture-" + std::to_string(stamp) + "-" + std::to_string(serial++);
            if (fs::create_directory(workspace_)) break;
            workspace_.clear();
        }
        require(!workspace_.empty(), "cannot reserve capture workspace");
        payload_.open(workspace_ / "payload", std::ios::binary);
        if (!payload_) { fs::remove_all(workspace_); throw std::runtime_error("cannot create capture payload"); }
    }
    ~ContainerWriter() {
        payload_.close();
        std::error_code error;
        if (!workspace_.empty()) fs::remove_all(workspace_, error);
    }
    void add(const std::string& name, uint64_t size, const std::string& representation,
             const std::function<void(const Consumer&)>& produce) {
        require(entries_.size() < 32 && size && size <= MAX_BUNDLE_BYTES &&
                aligned(size) <= MAX_BUNDLE_BYTES - bytes_, "bundle size limit exceeded");
        require(name.find_first_of("/\\") == std::string::npos && name != "." && name != "..", "invalid entry name");
        for (const auto& entry : entries_) require(entry.name != name, "duplicate entry");
        Sha256 hash; uint64_t written = 0;
        produce([&](const void* data, size_t n) {
            require(n <= size - written, "bundle input grew");
            payload_.write(static_cast<const char*>(data), std::streamsize(n));
            require(bool(payload_), "capture payload write failed");
            hash.add(data, n); written += n;
        });
        require(written == size, "bundle input truncated");
        entries_.push_back({name, bytes_, size, hash.finish(), representation});
        zeros(payload_, aligned(size) - size); bytes_ += aligned(size);
    }
    void memory(const std::string& name, const void* data, size_t bytes, const std::string& representation) {
        add(name, bytes, representation, [&](const Consumer& consume) { consume(data, bytes); });
    }
    void file(const std::string& name, const fs::path& path, const std::string& representation) {
        auto size = fs::file_size(path);
        add(name, size, representation, [&](const Consumer& consume) { file_chunks(path, consume); });
    }
    std::string digest(const std::string& name) const {
        for (const auto& entry : entries_) if (entry.name == name) return entry.hash;
        throw std::runtime_error("missing capture entry");
    }
    void publish(const char* magic, const std::string& metadata) {
        std::ostringstream table;
        table << "{\"files\":[";
        for (size_t i = 0; i < entries_.size(); ++i) {
            const auto& entry = entries_[i];
            if (i) table << ',';
            table << "{\"name\":" << quote(entry.name) << ",\"offset\":" << entry.offset
                  << ",\"bytes\":" << entry.bytes << ",\"sha256\":" << quote(entry.hash)
                  << ',' << entry.representation << '}';
        }
        table << "]," << metadata << '}';
        std::string manifest = table.str();
        require(manifest.size() <= MAX_MANIFEST_BYTES, "manifest size limit exceeded");
        require(16 + aligned(manifest.size()) + bytes_ <= MAX_BUNDLE_BYTES, "complete container exceeds the 512 MiB file limit");
        payload_.flush(); require(bool(payload_), "capture payload flush failed"); payload_.close();
        // Verify every staged entry from disk before publishing a reference.
        std::ifstream verify(workspace_ / "payload", std::ios::binary);
        require(bool(verify), "cannot verify capture payload");
        std::vector<char> buffer(1024 * 1024);
        for (const auto& entry : entries_) {
            verify.seekg(std::streamoff(entry.offset)); Sha256 hash; uint64_t remaining = entry.bytes;
            while (remaining) {
                size_t n = size_t(std::min<uint64_t>(remaining, buffer.size()));
                verify.read(buffer.data(), std::streamsize(n));
                require(uint64_t(verify.gcount()) == n, "capture verification truncated");
                hash.add(buffer.data(), n); remaining -= n;
            }
            require(hash.finish() == entry.hash, "capture digest verification failed");
        }
        verify.close();
        fs::path staged = workspace_ / "container";
        std::ofstream out(staged, std::ios::binary);
        require(bool(out), "cannot write bundle");
        out.write(magic, 8); u32(out, uint32_t(manifest.size())); u32(out, uint32_t(entries_.size()));
        out.write(manifest.data(), std::streamsize(manifest.size())); zeros(out, aligned(manifest.size()) - manifest.size());
        file_chunks(workspace_ / "payload", [&](const void* data, size_t n) { out.write(static_cast<const char*>(data), std::streamsize(n)); });
        out.flush(); require(bool(out), "bundle write failed"); out.close(); require(!out.fail(), "bundle close failed");
        require(fs::file_size(staged) == 16 + aligned(manifest.size()) + bytes_, "bundle length verification failed");
        require(!fs::exists(destination_), "bundle destination already exists");
        fs::rename(staged, destination_);
    }
};

void finite_values(const float* values, size_t count) {
    require(values || !count, "missing tensor");
    for (size_t i = 0; i < count; ++i) require(std::isfinite(values[i]), "nonfinite capture value");
}

std::string array_representation(const char* type, uint64_t rows, uint64_t channels) {
    return "\"dtype\":" + quote(type) + ",\"shape\":[" + std::to_string(rows) + "," + std::to_string(channels) + "]";
}

void write_mesh(ContainerWriter& writer, const char* name, const std::vector<float>& vertices,
                const std::vector<int32_t>& faces) {
    require(!vertices.empty() && vertices.size() % 3 == 0 && vertices.size() / 3 <= MAX_VERTICES,
            "invalid capture vertices");
    require(!faces.empty() && faces.size() % 3 == 0 && faces.size() / 3 <= MAX_TRIANGLES,
            "invalid capture faces");
    finite_values(vertices.data(), vertices.size());
    for (float value : vertices) require(std::abs(value) <= 16, "capture mesh exceeds normalized-space safety limits");
    uint32_t v = uint32_t(vertices.size() / 3), f = uint32_t(faces.size() / 3);
    for (int32_t index : faces) require(index >= 0 && uint32_t(index) < v, "capture face index out of range");
    writer.add(name, 8 + uint64_t(vertices.size()) * 4 + uint64_t(faces.size()) * 4,
               "\"encoding\":\"triastasis-mesh-le-v1\",\"vertices\":" + std::to_string(v) + ",\"triangles\":" + std::to_string(f),
               [&](const Consumer& consume) {
                   uint32_t header[2] = {v, f}; consume(header, sizeof(header));
                   consume(vertices.data(), vertices.size() * 4); consume(faces.data(), faces.size() * 4);
               });
}

void png_bytes(void* context, void* data, int size) {
    auto& bytes = *static_cast<std::vector<unsigned char>*>(context);
    bytes.insert(bytes.end(), static_cast<unsigned char*>(data), static_cast<unsigned char*>(data) + size);
}
}  // namespace

struct GenerationDataCapture::State {
    std::string destination, error;
    TrellisParams params;
    std::unique_ptr<ContainerWriter> writer;
    uint32_t seed = 0;
    bool begun = false, ready = false, has_guide = false, has_noise = false,
         has_dense = false, has_surface = false, double_sided = false, birefnet = false;
    uint64_t roots = 0;
    std::vector<uint64_t> hierarchy;
    std::string coordinate_hash;
    std::string flow_backend, decoder_backend;
    struct ModelStamp { std::string name; uintmax_t bytes; fs::file_time_type modified; };
    std::vector<ModelStamp> models;
    template<class F> void attempt(F&& action) {
        if (!error.empty() || ready) return;
        try { action(); }
        catch (const std::exception&) { error = "generation_data_capture_failed"; writer.reset(); }
        catch (...) { error = "generation_data_capture_failed"; writer.reset(); }
    }
};

GenerationDataCapture::GenerationDataCapture(std::string destination) : state_(new State) {
    state_->destination = std::move(destination);
}
GenerationDataCapture::~GenerationDataCapture() = default;
const std::string& GenerationDataCapture::path() const { return state_->destination; }
const std::string& GenerationDataCapture::error_code() const { return state_->error; }
bool GenerationDataCapture::available() const { return state_->ready; }
void GenerationDataCapture::fail(const std::string& code) {
    if (state_->error.empty()) state_->error = code;
    state_->ready = false; state_->writer.reset();
}

void GenerationDataCapture::begin(const TrellisParams& params, uint32_t effective_seed, bool birefnet) {
    auto& s = *state_;
    if (params.cascade || !params.texture || params.bg_only) { fail("unsupported_capture_profile"); return; }
    s.attempt([&] {
        require(!s.begun && effective_seed != 0, "invalid capture start");
        s.params = params; s.seed = effective_seed; s.birefnet = birefnet;
        const char* models[] = {"ss_flow.gguf", "ss_dec.gguf", "shape_flow_512.gguf", "shape_dec.gguf",
                                "tex_flow_512.gguf", "tex_dec.gguf", "dinov3.gguf", "birefnet.gguf"};
        for (const char* name : models) {
            if (std::strcmp(name, "birefnet.gguf") == 0 && !birefnet) continue;
            fs::path model = fs::path(params.models) / name;
            s.models.push_back({name, fs::file_size(model), fs::last_write_time(model)});
        }
        s.writer = std::make_unique<ContainerWriter>(s.destination); s.begun = true;
    });
}

void GenerationDataCapture::guide(const std::vector<std::array<int, 3>>& roots,
                                 const std::vector<float>& shape,
                                 const std::vector<std::vector<uint8_t>>& masks,
                                 const std::vector<std::array<int, 3>>& final_coordinates,
                                 int resolution, const float* conditioning, int tokens,
                                 const std::vector<unsigned char>& cutout, int cutout_size) {
    auto& s = *state_;
    s.attempt([&] {
        require(s.begun && !s.has_guide && resolution == 512 && masks.size() == 4,
                "unsupported texture guide");
        require(!roots.empty() && roots.size() <= MAX_ROOTS && shape.size() == roots.size() * 32,
                "invalid shape dimensions");
        require(!final_coordinates.empty() && final_coordinates.size() <= MAX_VOXELS,
                "capture voxel limit exceeded");
        require(tokens == 1029, "unsupported conditioning dimensions");
        require(cutout_size > 0 && cutout_size <= 8192 && cutout.size() == uint64_t(cutout_size) * cutout_size * 4,
                "invalid RGBA cutout");
        finite_values(shape.data(), shape.size()); finite_values(conditioning, size_t(tokens) * 1024);
        std::vector<bool> occupied(MAX_ROOTS, false);
        for (const auto& c : roots) {
            for (int axis : c) require(axis >= 0 && axis < 32, "invalid root coordinate");
            size_t key = size_t(c[0]) + 32 * size_t(c[1]) + 1024 * size_t(c[2]);
            require(!occupied[key], "duplicate root coordinate"); occupied[key] = true;
        }
        s.roots = roots.size(); s.hierarchy = {s.roots};
        auto coordinates = roots;
        for (const auto& mask : masks) {
            require(mask.size() == coordinates.size() * 8, "invalid subdivision dimensions");
            uint64_t count = 0;
            for (uint8_t bit : mask) { require(bit <= 1, "invalid subdivision bit"); count += bit; }
            require(count && count <= MAX_VOXELS, "capture hierarchy limit exceeded");
            std::vector<std::array<int, 3>> next; next.reserve(size_t(count));
            for (size_t parent = 0; parent < coordinates.size(); ++parent) {
                const auto& c = coordinates[parent];
                for (int octant = 0; octant < 8; ++octant) if (mask[parent * 8 + octant])
                    next.push_back({c[0] * 2 + (octant & 1), c[1] * 2 + ((octant >> 1) & 1), c[2] * 2 + ((octant >> 2) & 1)});
            }
            coordinates = std::move(next); s.hierarchy.push_back(count);
        }
        require(coordinates == final_coordinates, "texture coordinate ordering differs from hierarchy");
        s.coordinate_hash = hash_memory(final_coordinates.data(), final_coordinates.size() * sizeof(final_coordinates[0]));
        s.writer->memory("roots.i32", roots.data(), roots.size() * sizeof(roots[0]), array_representation("int32-le", roots.size(), 3));
        s.writer->memory("shape.norm.f32", shape.data(), shape.size() * 4, array_representation("float32-le", roots.size(), 32));
        for (size_t i = 0; i < masks.size(); ++i)
            s.writer->memory("subdivision-" + std::to_string(i) + ".u8", masks[i].data(), masks[i].size(), array_representation("uint8", s.hierarchy[i], 8));
        s.writer->memory("conditioning.f32", conditioning, size_t(tokens) * 1024 * 4, array_representation("float32-le", tokens, 1024));
        std::vector<unsigned char> png;
        require(stbi_write_png_to_func(png_bytes, &png, cutout_size, cutout_size, 4, cutout.data(), cutout_size * 4) != 0,
                "cutout PNG encoding failed");
        s.writer->memory("cutout.png", png.data(), png.size(), "\"encoding\":\"png-rgba\",\"width\":" + std::to_string(cutout_size) + ",\"height\":" + std::to_string(cutout_size));
        s.has_guide = true;
    });
}

void GenerationDataCapture::noise(const std::vector<float>& noise) {
    auto& s = *state_;
    s.attempt([&] {
        require(s.has_guide && !s.has_noise && noise.size() == s.roots * 32, "invalid texture noise dimensions");
        finite_values(noise.data(), noise.size());
        s.writer->memory("original-noise.f32", noise.data(), noise.size() * 4, array_representation("float32-le", s.roots, 32));
        s.has_noise = true;
    });
}

void GenerationDataCapture::texture_backend(bool decoder, bool on_gpu) {
    auto& s = *state_;
    s.attempt([&] {
        require(s.begun, "capture has not started");
        (decoder ? s.decoder_backend : s.flow_backend) = on_gpu ? TRELLIS_BUILD_BACKEND : "cpu";
    });
}

void GenerationDataCapture::dense_surface(const std::vector<float>& vertices, const std::vector<int32_t>& faces) {
    auto& s = *state_;
    s.attempt([&] {
        require(s.has_guide && !s.has_dense, "invalid dense capture order");
        write_mesh(*s.writer, "dense-snap.mesh", vertices, faces); s.has_dense = true;
    });
}

void GenerationDataCapture::output_surface(const std::vector<float>& vertices, const std::vector<int32_t>& faces, bool double_sided) {
    auto& s = *state_;
    s.attempt([&] {
        require(s.has_dense && !s.has_surface, "invalid surface capture order");
        write_mesh(*s.writer, "surface.mesh", vertices, faces); s.has_surface = true; s.double_sided = double_sided;
    });
}

void GenerationDataCapture::finish(const std::string& source_glb) {
    auto& s = *state_;
    s.attempt([&] {
        require(s.has_guide && s.has_noise && s.has_dense && s.has_surface &&
                !s.flow_backend.empty() && !s.decoder_backend.empty(), "incomplete capture");
        require(fs::file_size(source_glb) > 0, "empty source GLB");
        std::ostringstream metadata;
        metadata << "\"schema\":\"triastasis-generation-data\",\"version\":1,\"profile\":\"textured-512-v1\""
                 << ",\"producer\":{\"name\":\"triastasis-native\",\"capture_version\":1,\"app_version\":"
                 << quote(TRIASTASIS_VERSION) << ",\"git_commit\":" << quote(TRELLIS_GIT_COMMIT)
                 << ",\"git_dirty\":" << (TRELLIS_GIT_DIRTY ? "true" : "false") << '}'
                 << ",\"generation_seed\":" << s.seed << ",\"resolution\":512,\"texture_resolution\":512,\"root_grid\":32"
                 << ",\"roots\":" << s.roots << ",\"hierarchy_counts\":[";
        for (size_t i = 0; i < s.hierarchy.size(); ++i) { if (i) metadata << ','; metadata << s.hierarchy[i]; }
        metadata << "],\"coordinate_order_sha256\":" << quote(s.coordinate_hash)
                 << ",\"conditioning_shape\":[1029,1024],\"negative_conditioning\":\"zeros\""
                 << ",\"shape_normalization\":\"trellis2-native-shape-f32-v1\",\"texture_normalization\":\"trellis2-native-texture-f32-v1\""
                 << ",\"array_order\":\"item-major\",\"octant_order\":\"x-bit0-y-bit1-z-bit2\""
                 << ",\"sampler\":{\"steps\":12,\"guidance_strength\":1,\"guidance_rescale\":0,\"gi0\":0.6,\"gi1\":0.9,\"rescale_t\":3}"
                 << ",\"rng\":\"mt19937-std-normal-f32\",\"original_texture_noise_stored\":true"
                 << ",\"mesh_frame\":\"trellis-normalized\",\"to_asset_transform\":[1,0,0,0,0,0,-1,0,0,1,0,0,0,0,0,1]"
                 << ",\"to_asset_transform_order\":\"column-major\""
                 << ",\"double_sided\":" << (s.double_sided ? "true" : "false")
                 << ",\"copyright\":" << quote(s.params.copyright)
                 << ",\"source_surface_sha256\":" << quote(s.writer->digest("surface.mesh"))
                 << ",\"source_glb_sha256\":" << quote(hash_file(source_glb))
                 << ",\"preprocessing\":{\"version\":1,\"mode\":" << quote(s.birefnet ? "birefnet" : "threshold-or-input-alpha") << '}'
                 << ",\"numeric\":{\"requested_gpu\":" << s.params.gpu << ",\"sparse_f32\":" << (s.params.f32 ? "true" : "false")
                 << ",\"compiled_backend\":" << quote(TRELLIS_BUILD_BACKEND)
                 << ",\"texture_flow_backend\":" << quote(s.flow_backend) << ",\"texture_decode_backend\":" << quote(s.decoder_backend)
                 << ",\"no_flash_attention\":" << (s.params.no_fa ? "true" : "false") << ",\"cpu_threads\":" << s.params.threads << '}'
                 << ",\"model_provenance\":{";
        bool first = true;
        for (const auto& stamp : s.models) {
            fs::path model = fs::path(s.params.models) / stamp.name;
            require(fs::file_size(model) == stamp.bytes && fs::last_write_time(model) == stamp.modified,
                    "model changed during generation");
            if (!first) metadata << ','; first = false;
            metadata << quote(stamp.name) << ':' << quote(model_hash(model));
        }
        metadata << '}';
        s.writer->publish("TRGST001", metadata.str()); s.writer.reset(); s.ready = true;
    });
}

void write_generation_package(const std::string& destination, const std::string& glb,
                              const GenerationDataCapture& capture) {
    ContainerWriter writer(destination);
    writer.file("model.glb", glb, "\"encoding\":\"glb\"");
    if (capture.available()) writer.file("generation.trg", capture.path(), "\"encoding\":\"triastasis-generation-data-v1\"");
    std::string metadata = "\"schema\":\"triastasis-generation-package\",\"version\":1";
    if (!capture.available()) metadata += ",\"generation_data_error\":{\"code\":" + quote(capture.error_code().empty() ? "generation_data_capture_failed" : capture.error_code()) + '}';
    writer.publish("TRGPK001", metadata);
}

namespace {
using Json = bundle_json::Value;
uint64_t manifest_integer(const Json& value, uint64_t maximum) {
    auto result = value.integer(); require(result <= maximum, "manifest allocation limit exceeded"); return result;
}
std::string manifest_hash(const Json& value) {
    auto result = value.text(); require(result.size() == 64, "invalid manifest digest");
    for (char c : result) require((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'), "invalid manifest digest");
    return result;
}
class ContainerReader {
    std::ifstream input_;
    uint64_t payload_start_ = 0;
    std::map<std::string, const Json*> entries_;
public:
    Json manifest;
    ContainerReader(const std::string& path, const char* magic, const char* schema,
                    const std::vector<std::string>& names) {
        uint64_t size = fs::file_size(path);
        require(size >= 16 && size <= MAX_BUNDLE_BYTES, "invalid container size");
        input_.open(path, std::ios::binary); require(bool(input_), "cannot open container");
        unsigned char header[16]{}; input_.read(reinterpret_cast<char*>(header), 16);
        require(input_.gcount() == 16 && std::memcmp(header, magic, 8) == 0, "unsupported container magic");
        auto word = [&](int offset) { return uint32_t(header[offset]) | uint32_t(header[offset+1]) << 8 | uint32_t(header[offset+2]) << 16 | uint32_t(header[offset+3]) << 24; };
        uint32_t length = word(8), count = word(12);
        require(length && length <= MAX_MANIFEST_BYTES && count == names.size(), "invalid container manifest size");
        payload_start_ = 16 + aligned(length); require(payload_start_ <= size, "truncated container manifest");
        std::string text(length, '\0'); input_.read(text.data(), length);
        require(uint64_t(input_.gcount()) == length, "truncated container manifest");
        manifest = bundle_json::Parser(text).parse();
        require(manifest.at("schema").text() == schema && manifest.at("version").integer() == 1, "unsupported container schema");
        const auto& files = manifest.at("files");
        require(files.kind == Json::Array && files.array.size() == count, "invalid entry count");
        uint64_t cursor = 0;
        for (const auto& entry : files.array) {
            auto name = entry.at("name").text();
            require(std::find(names.begin(), names.end(), name) != names.end() && !entries_.count(name), "invalid container entry name");
            auto offset = manifest_integer(entry.at("offset"), MAX_BUNDLE_BYTES);
            auto bytes = manifest_integer(entry.at("bytes"), MAX_BUNDLE_BYTES);
            manifest_hash(entry.at("sha256"));
            require(bytes && offset == cursor && offset <= size - payload_start_ && bytes <= size - payload_start_ - offset, "invalid container entry bounds");
            entries_[name] = &entry; cursor += aligned(bytes);
            require(cursor <= MAX_BUNDLE_BYTES, "container allocation limit exceeded");
        }
        require(payload_start_ + cursor == size, "container length mismatch");
    }
    const Json& entry(const std::string& name) const {
        auto it = entries_.find(name); require(it != entries_.end(), "missing container payload"); return *it->second;
    }
    void read(const std::string& name, const Consumer& consume) {
        const auto& e = entry(name);
        uint64_t remaining = e.at("bytes").integer();
        input_.clear(); input_.seekg(std::streamoff(payload_start_ + e.at("offset").integer()));
        std::vector<char> buffer(1024 * 1024); Sha256 hash;
        while (remaining) {
            size_t n = size_t(std::min<uint64_t>(remaining, buffer.size())); input_.read(buffer.data(), std::streamsize(n));
            require(size_t(input_.gcount()) == n, "truncated container payload");
            hash.add(buffer.data(), n); consume(buffer.data(), n); remaining -= n;
        }
        require(hash.finish() == e.at("sha256").text(), "container payload digest mismatch");
    }
    void dimensions(const std::string& name, const char* dtype, uint64_t rows, uint64_t channels, uint64_t width = 4) const {
        const auto& e = entry(name); const auto& shape = e.at("shape");
        require(e.at("dtype").text() == dtype && shape.kind == Json::Array && shape.array.size() == 2 &&
                shape.array[0].integer() == rows && shape.array[1].integer() == channels &&
                e.at("bytes").integer() == rows * channels * width, "invalid tensor dimensions");
    }
    template<class T> std::vector<T> values(const std::string& name) {
        uint64_t size = entry(name).at("bytes").integer();
        require(size % sizeof(T) == 0, "unaligned tensor length");
        std::vector<T> out(size_t(size / sizeof(T))); size_t offset = 0;
        read(name, [&](const void* data, size_t n) { std::memcpy(reinterpret_cast<char*>(out.data()) + offset, data, n); offset += n; });
        return out;
    }
    GenerationSurface mesh(const std::string& name) {
        const auto& e = entry(name);
        require(e.at("encoding").text() == "triastasis-mesh-le-v1", "unsupported mesh encoding");
        uint64_t v = manifest_integer(e.at("vertices"), MAX_VERTICES), f = manifest_integer(e.at("triangles"), MAX_TRIANGLES);
        require(v && f && e.at("bytes").integer() == 8 + 12 * (v + f), "invalid mesh dimensions");
        auto bytes = values<unsigned char>(name); uint32_t counts[2]; std::memcpy(counts, bytes.data(), 8);
        require(counts[0] == v && counts[1] == f, "mesh header mismatch");
        GenerationSurface out; out.vertices.resize(size_t(v) * 3); out.faces.resize(size_t(f) * 3);
        std::memcpy(out.vertices.data(), bytes.data() + 8, size_t(v) * 12);
        std::memcpy(out.faces.data(), bytes.data() + 8 + size_t(v) * 12, size_t(f) * 12);
        finite_values(out.vertices.data(), out.vertices.size());
        for (float value : out.vertices) require(std::abs(value) <= 16, "saved mesh exceeds normalized-space safety limits");
        for (int32_t index : out.faces) require(index >= 0 && uint64_t(index) < v, "mesh index out of range");
        return out;
    }
};
void pbr_values(const std::vector<float>& values) {
    for (float value : values) require(std::isfinite(value) && value >= 0 && value <= 1, "invalid material value");
}
void sampler_profile(const Json& sampler) {
    const std::pair<const char*, double> settings[] = {{"steps",12},{"guidance_strength",1},{"guidance_rescale",0},{"gi0",.6},{"gi1",.9},{"rescale_t",3}};
    for (const auto& setting : settings) {
        const auto& value = sampler.at(setting.first);
        require(value.kind == Json::Number && std::abs(value.number - setting.second) < 1e-9, "unsupported texture sampler");
    }
}
}

SavedGenerationData read_generation_data(const std::string& path) {
    const uint32_t endian = 1;
    require(*reinterpret_cast<const unsigned char*>(&endian) == 1, "little-endian replay required");
    ContainerReader reader(path, "TRGST001", "triastasis-generation-data", {
        "roots.i32", "shape.norm.f32", "subdivision-0.u8", "subdivision-1.u8", "subdivision-2.u8", "subdivision-3.u8",
        "conditioning.f32", "original-noise.f32", "cutout.png", "surface.mesh", "dense-snap.mesh"});
    const auto& m = reader.manifest;
    require(m.at("profile").text() == "textured-512-v1" && m.at("resolution").integer() == 512 &&
            m.at("texture_resolution").integer() == 512 && m.at("root_grid").integer() == 32, "unsupported texture guide profile");
    require(m.at("array_order").text() == "item-major" && m.at("octant_order").text() == "x-bit0-y-bit1-z-bit2" &&
            m.at("negative_conditioning").text() == "zeros", "unsupported texture array profile");
    require(m.at("shape_normalization").text() == "trellis2-native-shape-f32-v1" &&
            m.at("texture_normalization").text() == "trellis2-native-texture-f32-v1", "unsupported texture normalization");
    sampler_profile(m.at("sampler"));
    require(m.at("mesh_frame").text() == "trellis-normalized" && m.at("to_asset_transform_order").text() == "column-major", "unsupported saved mesh frame");
    const auto& transform = m.at("to_asset_transform");
    const double expected_transform[16] = {1,0,0,0,0,0,-1,0,0,1,0,0,0,0,0,1};
    require(transform.kind == Json::Array && transform.array.size() == 16, "invalid saved mesh transform");
    for (size_t i = 0; i < 16; ++i) require(transform.array[i].kind == Json::Number && transform.array[i].number == expected_transform[i], "unsupported saved mesh transform");
    uint64_t n = manifest_integer(m.at("roots"), MAX_ROOTS); require(n, "empty texture roots");
    const auto& counts = m.at("hierarchy_counts");
    require(counts.kind == Json::Array && counts.array.size() == 5 && counts.array[0].integer() == n, "invalid hierarchy counts");
    for (const auto& count : counts.array) require(manifest_integer(count, MAX_VOXELS) > 0, "empty subdivision level");
    const auto& condition_shape = m.at("conditioning_shape");
    require(condition_shape.kind == Json::Array && condition_shape.array.size() == 2 && condition_shape.array[0].integer() == 1029 &&
            condition_shape.array[1].integer() == 1024, "unsupported conditioning shape");
    reader.dimensions("roots.i32", "int32-le", n, 3); reader.dimensions("shape.norm.f32", "float32-le", n, 32);
    reader.dimensions("original-noise.f32", "float32-le", n, 32); reader.dimensions("conditioning.f32", "float32-le", 1029, 1024);
    SavedGenerationData out;
    if (m.object.count("copyright")) out.copyright = m.at("copyright").text();
    out.seed = uint32_t(manifest_integer(m.at("generation_seed"), UINT32_MAX)); require(out.seed, "invalid generation seed");
    out.surface_hash = manifest_hash(m.at("source_surface_sha256")); out.coordinate_hash = manifest_hash(m.at("coordinate_order_sha256"));
    manifest_hash(m.at("source_glb_sha256"));
    require(reader.entry("surface.mesh").at("sha256").text() == out.surface_hash, "surface binding mismatch");
    out.flow_model_hash = manifest_hash(m.at("model_provenance").at("tex_flow_512.gguf"));
    out.decoder_model_hash = manifest_hash(m.at("model_provenance").at("tex_dec.gguf"));
    out.double_sided = m.at("double_sided").flag(); out.f32 = m.at("numeric").at("sparse_f32").flag(); out.no_fa = m.at("numeric").at("no_flash_attention").flag();
    out.roots = reader.values<std::array<int,3>>("roots.i32");
    std::vector<bool> occupied(MAX_ROOTS);
    for (const auto& c : out.roots) {
        for (int axis : c) require(axis >= 0 && axis < 32, "invalid root coordinate");
        size_t key = size_t(c[0]) + size_t(c[1]) * 32 + size_t(c[2]) * 1024;
        require(!occupied[key], "duplicate root coordinate"); occupied[key] = true;
    }
    out.coordinates = out.roots;
    for (size_t level = 0; level < 4; ++level) {
        std::string name = "subdivision-" + std::to_string(level) + ".u8";
        reader.dimensions(name, "uint8", counts.array[level].integer(), 8, 1);
        auto mask = reader.values<uint8_t>(name); uint64_t count = 0;
        for (uint8_t bit : mask) { require(bit <= 1, "invalid subdivision bit"); count += bit; }
        require(count == counts.array[level+1].integer(), "subdivision count mismatch");
        std::vector<std::array<int,3>> next; next.reserve(size_t(count));
        for (size_t parent = 0; parent < out.coordinates.size(); ++parent) for (int octant = 0; octant < 8; ++octant) if (mask[parent*8+octant]) {
            const auto& c = out.coordinates[parent];
            next.push_back({c[0]*2+(octant&1),c[1]*2+((octant>>1)&1),c[2]*2+((octant>>2)&1)});
        }
        out.subdivisions.push_back(std::move(mask)); out.coordinates = std::move(next);
    }
    require(hash_memory(out.coordinates.data(), out.coordinates.size() * 12) == out.coordinate_hash, "coordinate ordering digest mismatch");
    out.shape = reader.values<float>("shape.norm.f32"); out.conditioning = reader.values<float>("conditioning.f32"); out.original_noise = reader.values<float>("original-noise.f32");
    finite_values(out.shape.data(), out.shape.size()); finite_values(out.conditioning.data(), out.conditioning.size()); finite_values(out.original_noise.data(), out.original_noise.size());
    reader.read("cutout.png", [](const void*, size_t) {});
    out.surface = reader.mesh("surface.mesh"); out.dense = reader.mesh("dense-snap.mesh");
    out.hash = hash_file(path); return out;
}

void validate_texture_models(const SavedGenerationData& data, const std::string& models) {
    require(model_hash(fs::path(models) / "tex_flow_512.gguf") == data.flow_model_hash &&
            model_hash(fs::path(models) / "tex_dec.gguf") == data.decoder_model_hash, "installed texture models are incompatible with the saved generation");
}

void write_texture_option(const std::string& path, const SavedGenerationData& data, const SavedTextureOption& option) {
    require(option.seed && option.field.size() == data.coordinates.size() * 6 && option.preview.size() == data.surface.vertices.size() * 2 &&
            option.missing_samples <= data.surface.vertices.size() / 3, "invalid texture option dimensions");
    pbr_values(option.field); pbr_values(option.preview);
    ContainerWriter writer(path);
    writer.memory("field.f32", option.field.data(), option.field.size() * 4, array_representation("float32-le", data.coordinates.size(), 6));
    writer.memory("preview.f32", option.preview.data(), option.preview.size() * 4, array_representation("float32-le", data.surface.vertices.size() / 3, 6));
    std::ostringstream manifest;
    manifest << "\"schema\":\"triastasis-texture-option\",\"version\":1,\"profile\":\"textured-512-v1\""
             << ",\"generation_data_sha256\":" << quote(data.hash) << ",\"source_surface_sha256\":" << quote(data.surface_hash)
             << ",\"coordinate_order_sha256\":" << quote(data.coordinate_hash) << ",\"seed\":" << option.seed
             << ",\"rng_mode\":" << quote(option.original_noise ? "original-noise" : "fresh") << ",\"sampler_profile\":\"trellis2-texture-12-v1\""
             << ",\"flow_model_sha256\":" << quote(data.flow_model_hash) << ",\"decoder_model_sha256\":" << quote(data.decoder_model_hash)
             << ",\"missing_samples\":" << option.missing_samples << ",\"phase_seconds\":{\"flow\":" << option.flow_seconds
             << ",\"decode\":" << option.decode_seconds << ",\"preview\":" << option.preview_seconds << '}';
    writer.publish("TROPT001", manifest.str());
}

SavedTextureOption read_texture_option(const std::string& path, const SavedGenerationData& data) {
    ContainerReader reader(path, "TROPT001", "triastasis-texture-option", {"field.f32", "preview.f32"});
    const auto& m = reader.manifest;
    require(m.at("profile").text() == "textured-512-v1" && m.at("sampler_profile").text() == "trellis2-texture-12-v1", "unsupported texture option profile");
    require(manifest_hash(m.at("generation_data_sha256")) == data.hash && manifest_hash(m.at("source_surface_sha256")) == data.surface_hash &&
            manifest_hash(m.at("coordinate_order_sha256")) == data.coordinate_hash && manifest_hash(m.at("flow_model_sha256")) == data.flow_model_hash &&
            manifest_hash(m.at("decoder_model_sha256")) == data.decoder_model_hash, "texture option belongs to a different generation");
    SavedTextureOption out; out.seed = uint32_t(manifest_integer(m.at("seed"), UINT32_MAX)); require(out.seed, "invalid option seed");
    const auto& rng = m.at("rng_mode").text(); require(rng == "fresh" || rng == "original-noise", "unsupported texture RNG mode");
    out.original_noise = rng == "original-noise"; require(!out.original_noise || out.seed == data.seed, "original noise seed mismatch");
    out.missing_samples = size_t(manifest_integer(m.at("missing_samples"), data.surface.vertices.size() / 3));
    reader.dimensions("field.f32", "float32-le", data.coordinates.size(), 6); reader.dimensions("preview.f32", "float32-le", data.surface.vertices.size() / 3, 6);
    out.field = reader.values<float>("field.f32"); out.preview = reader.values<float>("preview.f32");
    pbr_values(out.field); pbr_values(out.preview); return out;
}

}  // namespace trellis
