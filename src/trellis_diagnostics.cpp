#include "trellis_diagnostics.h"
#include <algorithm>
#include <atomic>
#include <cstdlib>
#include <cstring>
#include <exception>
#include <iomanip>
#include <locale>
#include <mutex>
#include <sstream>

#ifndef TRELLIS_GIT_COMMIT
#define TRELLIS_GIT_COMMIT "unknown"
#endif
#ifndef TRELLIS_GIT_DIRTY
#define TRELLIS_GIT_DIRTY 0
#endif
#ifndef TRELLIS_BUILD_BACKEND
#define TRELLIS_BUILD_BACKEND "unknown"
#endif
#ifndef TRIASTASIS_VERSION
#define TRIASTASIS_VERSION "unknown"
#endif
#ifndef TRELLIS_BUILD_TIMESTAMP
#define TRELLIS_BUILD_TIMESTAMP "unknown"
#endif
#ifndef TRELLIS_UPSTREAM_VERSION
#define TRELLIS_UPSTREAM_VERSION "unknown"
#endif

namespace trellis::diagnostics {
namespace {
thread_local Session* current = nullptr;
std::atomic<uint64_t> next_id{0};
std::mutex sink_mutex;
bool requested() {
    const char* value = std::getenv("TRIASTASIS_DIAGNOSTICS");
    return value && std::strcmp(value, "1") == 0;
}
std::filesystem::path storage_directory(const std::string& output) {
    if (!requested()) return {};
#ifdef _WIN32
    if (const wchar_t* dir = _wgetenv(L"TRIASTASIS_DIAGNOSTICS_DIR"))
        if (*dir) return std::filesystem::path(dir);
#else
    if (const char* dir = std::getenv("TRIASTASIS_DIAGNOSTICS_DIR"))
        if (*dir) return std::filesystem::u8path(dir);
#endif
    const auto parent = std::filesystem::u8path(output).parent_path();
    return parent.empty() ? std::filesystem::path(".") : parent;
}
const char* channels[] = {"base_r", "base_g", "base_b", "metallic", "roughness", "alpha", "base_code_luma"};
void add_pbr(std::array<Stats, 7>& stats, const double* values) {
    for (int k = 0; k < 6; ++k) stats[k].add(values[k]);
    // An encoded-colour darkness proxy, NOT linear luminance or a quality score.
    stats[6].add(0.2126 * values[0] + 0.7152 * values[1] + 0.0722 * values[2]);
}
void log_pbr(const char* stage, const std::array<Stats, 7>& stats) {
    for (int k = 0; k < 7; ++k) stats[k].log(stage, channels[k]);
}
}

std::string quote(const std::string& value) {
    std::string out = "\"";
    for (unsigned char c : value) {
        if (c == '"' || c == '\\') { out += '\\'; out += char(c); }
        else if (c < 0x20) {
            const char* hex = "0123456789abcdef";
            out += "\\u00"; out += hex[c >> 4]; out += hex[c & 15];
        } else out += char(c);
    }
    return out + '"';
}
std::string number(double value) {
    if (!std::isfinite(value)) return "null";
    std::ostringstream out;
    out.imbue(std::locale::classic());
    out << std::setprecision(17) << value;
    return out.str();
}
Session::Session(uint32_t seed, const std::string& output)
    : Session(seed, requested(), stderr, storage_directory(output)) {}
Session::Session(uint32_t seed, bool on, FILE* sink, const std::filesystem::path& directory)
    : previous_(current), enabled_(on && sink), sink_(sink), start_(std::chrono::steady_clock::now()) {
    current = this;
    if (!enabled_) return;
    const auto epoch = std::chrono::duration_cast<std::chrono::nanoseconds>(
        std::chrono::system_clock::now().time_since_epoch()).count();
    id_ = std::to_string(epoch) + "-" + std::to_string(++next_id);
    if (!directory.empty()) {
        // The caller owns directory creation. In particular, logging must not
        // create a missing GLB parent and change a failed export into a success.
        const auto path = directory / ("triastasis-diagnostics-" + id_ + ".jsonl");
#ifdef _WIN32
        stored_ = _wfopen(path.c_str(), L"wx");
#else
        stored_ = std::fopen(path.c_str(), "wx");
#endif
    }
    emit("run_start", {{"seed", seed}, {"runtime_commit", TRELLIS_GIT_COMMIT},
         {"runtime_dirty", TRELLIS_GIT_DIRTY != 0}, {"compiled_backend", TRELLIS_BUILD_BACKEND},
         {"product_version", TRIASTASIS_VERSION}, {"upstream_basis", TRELLIS_UPSTREAM_VERSION},
         {"build_utc", TRELLIS_BUILD_TIMESTAMP}, {"stored", stored_ != nullptr}});
    if (!directory.empty() && !stored_)
        emit("diagnostic_error", {{"stage", "storage"}, {"reason", "cannot_create_log"}});
}
Session::~Session() {
    if (!finished_) finish("incomplete");
    if (stored_) std::fclose(stored_);
    current = previous_;
}
void Session::emit(const char* name, std::initializer_list<Field> fields) noexcept {
    if (!enabled_) return;
    try {
        const double ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - start_).count();
        std::string line = "[triastasis-diag] {\"schema_version\":1,\"run_id\":" + quote(id_) +
            ",\"sequence\":" + std::to_string(++sequence_) + ",\"elapsed_ms\":" + number(ms) +
            ",\"event\":" + quote(name);
        for (const auto& f : fields) line += ',' + quote(f.key) + ':' + f.json;
        line += "}\n";
        std::lock_guard<std::mutex> lock(sink_mutex);
        std::fwrite(line.data(), 1, line.size(), sink_);
        std::fflush(sink_);
        if (stored_) {
            // Persist plain JSONL; stderr additionally carries a searchable prefix.
            constexpr size_t prefix_size = sizeof("[triastasis-diag] ") - 1;
            const size_t size = line.size() - prefix_size;
            const bool written = std::fwrite(line.data() + prefix_size, 1, size, stored_) == size;
            if (!written || std::fflush(stored_) != 0) {
                std::fclose(stored_); stored_ = nullptr;
                std::fputs("[triastasis-diag-storage] write failed; continuing with stderr only\n", sink_);
                std::fflush(sink_);
            }
        }
    } catch (...) { /* Diagnostics are best-effort; no generation error on sink failure. */ }
}
void Session::finish(const char* status) noexcept {
    if (!finished_) { emit("run_end", {{"status", status}}); finished_ = true; }
}
bool enabled() { return current && current->enabled(); }
void event(const char* name, std::initializer_list<Field> fields) noexcept {
    if (current) current->emit(name, fields);
}
Stage::Stage(const char* name) : name_(name), active_(enabled()),
    exceptions_(std::uncaught_exceptions()), start_(std::chrono::steady_clock::now()) {
    if (active_) event("stage_start", {{"stage", name_}});
}
Stage::~Stage() { end(); }
void Stage::end() noexcept {
    if (!active_) return;
    event("stage_end", {{"stage", name_}, {"wall_ms", std::chrono::duration<double, std::milli>(
        std::chrono::steady_clock::now() - start_).count()},
        {"unwinding", std::uncaught_exceptions() > exceptions_}});
    active_ = false;
}
void Stats::add(double x) {
    if (!std::isfinite(x)) { ++nonfinite; return; }
    if (!count) min = max = x;
    min = std::min(min, x); max = std::max(max, x);
    ++count;
    const double delta = x - mean;
    mean += delta / double(count); m2 += delta * (x - mean);
    below_zero += x < 0; above_one += x > 1;
    low += x <= 0.05; high += x >= 0.95;
}
void Stats::log(const char* stage, const char* channel) const {
    const double missing = std::nan("");
    event("distribution", {{"stage", stage}, {"channel", channel}, {"finite", count},
        {"nonfinite", nonfinite}, {"min", count ? min : missing}, {"max", count ? max : missing},
        {"mean", count ? mean : missing}, {"stddev", count ? std::sqrt(std::max(0.0, m2 / count)) : missing},
        {"below_zero", below_zero}, {"above_one", above_one}, {"le_0_05", low}, {"ge_0_95", high}});
}
void tensor(const char* stage, const std::vector<float>& values) {
    if (!enabled()) return;
    Stats stats;
    for (float value : values) stats.add(value);
    stats.log(stage, "all");
}
void pbr(const char* stage, const std::vector<float>& values, double scale, double bias) {
    if (!enabled()) return;
    std::array<Stats, 7> stats;
    for (size_t i = 0; i + 5 < values.size(); i += 6) {
        double sample[6];
        for (int k = 0; k < 6; ++k) sample[k] = values[i+k] * scale + bias;
        add_pbr(stats, sample);
    }
    event("pbr_layout", {{"stage", stage}, {"values", values.size()}, {"trailing_values", values.size() % 6}});
    log_pbr(stage, stats);
}
void atlas(const char* stage, const std::vector<uint8_t>& base,
           const std::vector<uint8_t>& mr, const std::vector<uint8_t>* mask) {
    if (!enabled()) return;
    const size_t pixels = base.size() / 4;
    if (base.size() % 4 || mr.size() != base.size() || (mask && mask->size() != pixels)) {
        event("diagnostic_error", {{"stage", stage}, {"reason", "atlas_layout"}}); return;
    }
    std::array<Stats, 7> stats;
    size_t selected = 0;
    for (size_t i = 0; i < pixels; ++i) {
        if (mask && !(*mask)[i]) continue;
        ++selected;
        const double sample[] = {base[4*i]/255.0, base[4*i+1]/255.0, base[4*i+2]/255.0,
            mr[4*i+2]/255.0, mr[4*i+1]/255.0, base[4*i+3]/255.0};
        add_pbr(stats, sample);
    }
    event("atlas_population", {{"stage", stage}, {"total_pixels", pixels}, {"selected_pixels", selected},
        {"population", mask ? "successfully_baked_texels" : "whole_atlas_including_gutters"}});
    log_pbr(stage, stats);
}
} // namespace trellis::diagnostics
