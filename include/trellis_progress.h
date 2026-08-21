// Canonical pipeline progress reporting.
//
// trellis_run() reports stage boundaries and per-sampler-iteration counts
// through a process-global sink. The CLI leaves the sink unset (stdout logging
// stays unchanged); trellis-server installs one that records progress per
// request id so any client can poll GET /progress/{id} — including clients
// that adopted an already-running server and cannot see its stdout.
//
// Percentages are derived ONLY from real sampler iterations (completed/total
// steps of every flow run). Stages without iterations report no percentage
// rather than inventing one from elapsed time or arbitrary stage weights.
#pragma once
#include <chrono>
#include <mutex>
#include <string>

namespace trellis {

struct ProgressStage {
    const char* id;
    const char* label;
};

inline const ProgressStage kProgressStages[] = {
    {"preprocess",       "Preparing the image"},
    {"condition",        "Understanding the image"},
    {"sparse_structure", "Building the coarse structure"},
    {"shape_slat_lr",    "Refining the 3D structure"},
    {"shape_slat_hr",    "Refining the 3D structure at high resolution"},
    {"mesh",             "Building the mesh"},
    {"texture_flow",     "Generating materials"},
    {"texture_decode",   "Decoding materials"},
    {"package",          "Packing and validating the model"},
};

inline const char* progress_stage_label(const std::string& id) {
    for (const auto& stage : kProgressStages) {
        if (id == stage.id) return stage.label;
    }
    return "Working";
}

// One snapshot pushed by the pipeline.
//
// stage_completed_steps/stage_total_steps describe sampler iterations within
// the active stage (total <= 0 => this stage has no iteration count).
// overall_completed_steps/overall_total_steps locate that work inside the
// COMPLETE sampler plan known at job start, so consumers get a fixed
// denominator and a monotonic percentage; overall_total <= 0 means "no
// measurable sampler has run yet" (indeterminate).
// stage_eta_seconds estimates only the ACTIVE sampler, never the whole job.
struct ProgressReport {
    std::string stage_id;
    std::string stage_label;
    int stage_completed_steps = 0;
    int stage_total_steps = 0;
    int overall_completed_steps = 0;
    int overall_total_steps = 0;
    double stage_eta_seconds = -1.0;
};

using ProgressFn = void (*)(const ProgressReport&, void* user);

inline std::mutex& progress_sink_mutex() {
    static std::mutex m;
    return m;
}

inline ProgressFn& progress_sink_fn() {
    static ProgressFn fn = nullptr;
    return fn;
}

inline void*& progress_sink_user() {
    static void* user = nullptr;
    return user;
}

inline void set_progress_sink(ProgressFn fn, void* user) {
    std::lock_guard<std::mutex> lk(progress_sink_mutex());
    progress_sink_fn() = fn;
    progress_sink_user() = user;
}

inline void clear_progress_sink() { set_progress_sink(nullptr, nullptr); }

// Called by the pipeline at stage boundaries and after each sampler step.
// Pass overall_* <= 0 at stages that have no sampler plan contribution.
inline void report_progress(const char* stage_id,
                            int stage_done, int stage_total,
                            int overall_done, int overall_total,
                            double stage_eta_seconds) {
    if (!stage_id) return;
    ProgressFn fn;
    void* user;
    {
        std::lock_guard<std::mutex> lk(progress_sink_mutex());
        fn = progress_sink_fn();
        user = progress_sink_user();
    }
    if (!fn) return;
    ProgressReport report;
    report.stage_id = stage_id;
    report.stage_label = progress_stage_label(stage_id);
    report.stage_completed_steps = stage_done;
    report.stage_total_steps = stage_total;
    report.overall_completed_steps = overall_done;
    report.overall_total_steps = overall_total;
    report.stage_eta_seconds = stage_eta_seconds;
    fn(report, user);
}

inline double epoch_seconds() {
    return std::chrono::duration<double>(
               std::chrono::system_clock::now().time_since_epoch())
        .count();
}

}  // namespace trellis
