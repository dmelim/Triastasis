// Opt-in, local-only observations. Never change tensors or generation decisions.
#pragma once
#include <array>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <filesystem>
#include <initializer_list>
#include <string>
#include <type_traits>
#include <vector>

namespace trellis::diagnostics {

std::string quote(const std::string& value);
std::string number(double value);
struct Field {
    std::string key, json;
    Field(const char* k, const char* v) : key(k), json(quote(v)) {}
    Field(const char* k, const std::string& v) : key(k), json(quote(v)) {}
    Field(const char* k, bool v) : key(k), json(v ? "true" : "false") {}
    template<class T, std::enable_if_t<std::is_arithmetic_v<T> && !std::is_same_v<T, bool>, int> = 0>
    Field(const char* k, T v) : key(k), json(number(static_cast<double>(v))) {}
};

// Each generation gets a fresh ID, even if its seed repeats. The resident server
// serializes generation; thread-local context avoids attributing other work to it.
class Session {
public:
    explicit Session(uint32_t seed, const std::string& output = {});
    Session(uint32_t seed, bool enabled, FILE* sink,
            const std::filesystem::path& directory = {}); // test seam
    ~Session();
    Session(const Session&) = delete;
    Session& operator=(const Session&) = delete;
    void finish(const char* status) noexcept;
    bool enabled() const { return enabled_; }
    void emit(const char* event, std::initializer_list<Field> fields) noexcept;
private:
    Session* previous_;
    bool enabled_, finished_ = false;
    FILE* sink_;
    FILE* stored_ = nullptr;
    std::string id_;
    uint64_t sequence_ = 0;
    std::chrono::steady_clock::time_point start_;
};

bool enabled();
void event(const char* name, std::initializer_list<Field> fields = {}) noexcept;

// Inclusive host wall time, including model loading and diagnostic overhead.
// Scope completion does not imply that an operation returned a valid result.
class Stage {
public:
    explicit Stage(const char* name);
    ~Stage();
    Stage(const Stage&) = delete;
    Stage& operator=(const Stage&) = delete;
    void end() noexcept;
private:
    const char* name_;
    bool active_;
    int exceptions_;
    std::chrono::steady_clock::time_point start_;
};

struct Stats {
    uint64_t count = 0, nonfinite = 0, below_zero = 0, above_one = 0;
    uint64_t low = 0, high = 0;
    double mean = 0, m2 = 0, min = 0, max = 0;
    void add(double value);
    void log(const char* stage, const char* channel) const;
};

void tensor(const char* stage, const std::vector<float>& values);
// Affine conversion permits observing decoder values BEFORE production clamping.
void pbr(const char* stage, const std::vector<float>& values, double scale = 1, double bias = 0);
// Mask selects successfully baked texels; nullptr selects the full atlas.
void atlas(const char* stage, const std::vector<uint8_t>& base,
           const std::vector<uint8_t>& mr, const std::vector<uint8_t>* mask = nullptr);

} // namespace trellis::diagnostics
