// trellis-server — resident HTTP wrapper around the TRELLIS.2 image->3D pipeline.
//
//   GET  /health     -> "ok"
//   POST /generate    multipart/form-data with an "image" file part; optional text
//                      fields "seed", "resolution" (512/1024/1536), "bg_removal"
//                      (threshold|birefnet), "uv" (xatlas = default, unique
//                      chart space; box = faster projection), "target_faces" /
//                      "targetFaces" (10K..1M QEM target), "texture" (on|off),
//                      "atlas_size" / "atlasSize" (128..4096),
//                      "texture_resolution" / "textureResolution" (512|1024),
//                      "remesh_band" / "remeshBand" (0..8), and
//                      "texture_encoding" / "textureEncoding" (auto|webp|png).
//                      Existing aliases "band", "atlas", "tex_res", and "webp"
//                      remain accepted. Returns model/gltf-binary.
//
// Launch-time defaults come from CLI flags (see trellis::parse_args);
// each request copies those defaults and applies its own overrides. The model
// directory is resolved once; each request runs the full pipeline via trellis_run()
// (per-stage load/free, like trellis-cli), serialized by a mutex. Keeping the
// process resident avoids re-initializing the Vulkan backend on every request.
#include "trellis_args.h"
#include "trellis_run.h"
#include "httplib.h"

#include <atomic>
#include <charconv>
#include <cstdint>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <initializer_list>
#include <mutex>
#include <string>

namespace {

std::string read_file_bytes(const std::string& path) {
    std::ifstream f(path, std::ios::binary);
    return std::string((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
}

bool write_file_bytes(const std::string& path, const std::string& data) {
    std::ofstream f(path, std::ios::binary);
    if (!f) return false;
    f.write(data.data(), (std::streamsize) data.size());
    return f.good();
}

// Read one logical form field, accepting the documented snake_case/camelCase aliases.
// Supplying two aliases with different values is rejected instead of silently choosing one.
bool read_text_field(const httplib::Request& req, std::initializer_list<const char*> names,
                     std::string& value, std::string& used_name, std::string& error) {
    bool found = false;
    for (const char* name : names) {
        if (!req.has_file(name)) continue;
        const std::string candidate = req.get_file_value(name).content;
        if (!found) {
            found = true;
            value = candidate;
            used_name = name;
        } else if (candidate != value) {
            error = "conflicting values supplied for " + used_name + " and " + name;
            return false;
        }
    }
    return found;
}

bool parse_int_field(const httplib::Request& req, std::initializer_list<const char*> names,
                     int minimum, int maximum, int& out, std::string& error,
                     bool* supplied = nullptr) {
    std::string value, used_name;
    const bool found = read_text_field(req, names, value, used_name, error);
    if (supplied) *supplied = found;
    if (!error.empty()) return false;
    if (!found) return true;
    if (value.empty()) {
        error = used_name + " must be an integer";
        return false;
    }

    int parsed = 0;
    const auto result = std::from_chars(value.data(), value.data() + value.size(), parsed);
    if (result.ec != std::errc() || result.ptr != value.data() + value.size()) {
        error = used_name + " must be an integer";
        return false;
    }
    if (parsed < minimum || parsed > maximum) {
        error = used_name + " must be between " + std::to_string(minimum) + " and " + std::to_string(maximum);
        return false;
    }
    out = parsed;
    return true;
}

bool parse_uint32_field(const httplib::Request& req, std::initializer_list<const char*> names,
                        uint32_t& out, std::string& error) {
    std::string value, used_name;
    const bool found = read_text_field(req, names, value, used_name, error);
    if (!error.empty() || !found) return error.empty();
    if (value.empty()) {
        error = used_name + " must be an unsigned 32-bit integer";
        return false;
    }

    uint32_t parsed = 0;
    const auto result = std::from_chars(value.data(), value.data() + value.size(), parsed);
    if (result.ec != std::errc() || result.ptr != value.data() + value.size()) {
        error = used_name + " must be between 0 and 4294967295";
        return false;
    }
    out = parsed;
    return true;
}

bool parse_toggle_field(const httplib::Request& req, std::initializer_list<const char*> names,
                        bool& out, std::string& error) {
    std::string value, used_name;
    const bool found = read_text_field(req, names, value, used_name, error);
    if (!error.empty() || !found) return error.empty();
    if (value == "on" || value == "true" || value == "1") {
        out = true;
        return true;
    }
    if (value == "off" || value == "false" || value == "0") {
        out = false;
        return true;
    }
    error = used_name + " must be one of on, off, true, false, 1, or 0";
    return false;
}

bool parse_texture_encoding(const httplib::Request& req, std::initializer_list<const char*> names,
                            int& out, std::string& error) {
    std::string value, used_name;
    const bool found = read_text_field(req, names, value, used_name, error);
    if (!error.empty() || !found) return error.empty();
    if (value == "auto") {
        out = -1;
        return true;
    }
    if (value == "webp" || value == "on" || value == "true" || value == "1") {
        out = 1;
        return true;
    }
    if (value == "png" || value == "off" || value == "false" || value == "0") {
        out = 0;
        return true;
    }
    error = used_name + " must be auto, webp, png, on, or off";
    return false;
}

std::string json_escape(const std::string& value) {
    std::string escaped;
    for (char c : value) {
        switch (c) {
            case '"':  escaped += "\\\""; break;
            case '\\': escaped += "\\\\"; break;
            case '\n':  escaped += "\\n"; break;
            case '\r':  escaped += "\\r"; break;
            case '\t':  escaped += "\\t"; break;
            default:
                if ((unsigned char)c < 0x20) break;
                escaped += c;
        }
    }
    return escaped;
}

void set_json_error(httplib::Response& res, int status, const std::string& message) {
    res.status = status;
    res.set_content("{\"error\":\"" + json_escape(message) + "\"}", "application/json");
}

// std::tmpnam on MSVC yields drive-root paths ("\sXXX.N") that a non-elevated
// process cannot write; stage scratch files in the real temp directory instead.
std::string temp_stem() {
    static std::atomic<unsigned> counter{0};
    std::error_code ec;
    std::filesystem::path dir = std::filesystem::temp_directory_path(ec);
    if (ec) dir = ".";
    auto n = counter.fetch_add(1);
    return (dir / ("trellis-req-" + std::to_string(n))).string();
}

}  // namespace

int main(int argc, char** argv) {
    // Stage progress goes to stdout, which is fully buffered when piped (e.g.
    // under Lemonade's output capture) — keep it line-visible for diagnostics.
    setvbuf(stdout, nullptr, _IONBF, 0);

    trellis::TrellisParams base;
    if (!trellis::parse_args(argc, argv, base)) {
        trellis::print_usage(argv[0], /*server=*/true);
        return base.help ? 0 : 1;
    }

    std::mutex gen_mu;
    httplib::Server svr;

    // Trellis Studio (and any browser client) calls this server from a different
    // origin — a Tauri webview is tauri://localhost / http://tauri.localhost, and a
    // browser-served UI is another port — so every response needs permissive CORS
    // headers, and a multipart POST with non-simple headers may be preflighted with
    // OPTIONS. Applied to every route via the post-routing hook + a catch-all OPTIONS.
    svr.set_post_routing_handler([](const httplib::Request&, httplib::Response& res) {
        res.set_header("Access-Control-Allow-Origin", "*");
        res.set_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        res.set_header("Access-Control-Allow-Headers", "Content-Type");
        res.set_header("Access-Control-Max-Age", "86400");
    });
    svr.Options(R"(.*)", [](const httplib::Request&, httplib::Response& res) {
        res.status = 204;  // headers added by the post-routing handler above
    });

    svr.Get("/health", [](const httplib::Request&, httplib::Response& res) {
        res.set_content("ok", "text/plain");
    });

    svr.Post("/generate", [&](const httplib::Request& req, httplib::Response& res) {
        if (!req.has_file("image")) {
            set_json_error(res, 400, "missing 'image' file part");
            return;
        }
        const auto& image = req.get_file_value("image");

        // Per-request params start from the launch defaults, then apply overrides.
        trellis::TrellisParams p = base;
        std::string validation_error;
        auto bad_request = [&](const std::string& message) {
            set_json_error(res, 400, message);
        };

        // These limits are deliberately bounded at the HTTP boundary: they cover the
        // current Trellis defaults and practical power-user values while preventing a
        // typo from requesting unbounded QEM work or multi-gigabyte texture atlases.
        if (!parse_uint32_field(req, {"seed"}, p.seed, validation_error)) {
            bad_request(validation_error);
            return;
        }

        int resolution = p.cascade ? p.hr_res : 512;
        bool resolution_supplied = false;
        if (!parse_int_field(req, {"resolution"}, 512, 1536, resolution, validation_error, &resolution_supplied)) {
            bad_request(validation_error);
            return;
        }
        if (resolution_supplied && resolution != 512 && resolution != 1024 && resolution != 1536) {
            bad_request("resolution must be 512, 1024, or 1536");
            return;
        }
        if (resolution_supplied) p.set_res(resolution);

        {
            std::string value, used_name;
            const bool found = read_text_field(req, {"bg_removal"}, value, used_name, validation_error);
            if (!validation_error.empty()) {
                bad_request(validation_error);
                return;
            }
            if (found) {
                if (value == "auto") p.birefnet = -1;
                else if (value == "birefnet") p.birefnet = 1;
                else if (value == "threshold") p.birefnet = 0;
                else {
                    bad_request(used_name + " must be auto, threshold, or birefnet");
                    return;
                }
            }
        }

        {
            std::string value, used_name;
            const bool found = read_text_field(req, {"uv"}, value, used_name, validation_error);
            if (!validation_error.empty()) {
                bad_request(validation_error);
                return;
            }
            if (found) {
                if (value == "xatlas") p.xatlas = true;
                else if (value == "box") p.xatlas = false;
                else {
                    bad_request(used_name + " must be xatlas or box");
                    return;
                }
            }
        }

        if (!parse_int_field(req, {"target_faces", "targetFaces"}, 10000, 1000000,
                             p.target_faces, validation_error)) {
            bad_request(validation_error);
            return;
        }
        if (!parse_toggle_field(req, {"texture", "texture_enabled", "textureEnabled"},
                                p.texture, validation_error)) {
            bad_request(validation_error);
            return;
        }
        if (!parse_int_field(req, {"atlas", "atlas_size", "atlasSize"}, 128, 4096,
                             p.tex, validation_error)) {
            bad_request(validation_error);
            return;
        }
        int texture_resolution = p.tex_res;
        bool texture_resolution_supplied = false;
        if (!parse_int_field(req, {"tex_res", "texRes", "texture_resolution", "textureResolution"},
                             512, 1024, texture_resolution, validation_error,
                             &texture_resolution_supplied)) {
            bad_request(validation_error);
            return;
        }
        if (texture_resolution_supplied && texture_resolution != 512 && texture_resolution != 1024) {
            bad_request("texture_resolution must be 512 or 1024");
            return;
        }
        if (texture_resolution_supplied) p.tex_res = texture_resolution;
        if (!parse_int_field(req, {"band", "remesh_band", "remeshBand"}, 0, 8,
                             p.band, validation_error)) {
            bad_request(validation_error);
            return;
        }
        if (!parse_texture_encoding(req, {"webp", "texture_encoding", "textureEncoding"},
                                    p.webp, validation_error)) {
            bad_request(validation_error);
            return;
        }

        const std::string stem = temp_stem();
        p.image  = stem + ".png";
        p.output = stem + ".glb";

        std::string glb;
        std::string error_message = "3D reconstruction failed";
        {
            std::lock_guard<std::mutex> lk(gen_mu);
            if (!write_file_bytes(p.image, image.content)) {
                res.status = 500;
                res.set_content("{\"error\":\"failed to stage input image\"}", "application/json");
                return;
            }
            fprintf(stderr, "[trellis-server] generate: %zu-byte image, seed %u, res %s, bg %s, uv %s\n",
                    image.content.size(), p.seed, p.cascade ? std::to_string(p.hr_res).c_str() : "512",
                    p.birefnet < 0 ? "auto" : (p.birefnet ? "birefnet" : "threshold"), p.xatlas ? "xatlas" : "box");
            try {
                int rc = trellis_run(p);
                if (rc == 0) glb = read_file_bytes(p.output);
            } catch (const std::exception& e) {
                fprintf(stderr, "[trellis-server] generate failed: %s\n", e.what());
                error_message = e.what();
            }
            std::remove(p.image.c_str());
            std::remove(p.output.c_str());
            // trellis_run also writes sibling debug artifacts; clean them up too.
            std::remove((stem + ".ply").c_str());
            std::remove((stem + "_base.png").c_str());
        }

        if (glb.empty()) {
            res.status = 500;
            std::string escaped;
            for (char c : error_message) {
                switch (c) {
                    case '"':  escaped += "\\\""; break;
                    case '\\': escaped += "\\\\"; break;
                    case '\n': escaped += "\\n";  break;
                    case '\r': escaped += "\\r";  break;
                    case '\t': escaped += "\\t";  break;
                    default:
                        if ((unsigned char)c < 0x20) break;
                        escaped += c;
                }
            }
            res.set_content("{\"error\":\"" + escaped + "\"}", "application/json");
            return;
        }
        res.set_content(glb.data(), glb.size(), "model/gltf-binary");
    });

    fprintf(stderr, "[trellis-server] models=%s gpu=%d listening on http://%s:%d\n",
            base.models.c_str(), base.gpu, base.host.c_str(), base.port);
    if (!svr.listen(base.host, base.port)) {
        fprintf(stderr, "[trellis-server] failed to bind %s:%d\n", base.host.c_str(), base.port);
        return 1;
    }
    return 0;
}
