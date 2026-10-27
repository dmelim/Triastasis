// Only the inference entry point is replaced. The real server routes, request
// validation, response streaming, progress registry and capture writer run.
#include "fixture.h"
#include "trellis_run.h"
#include "trellis_progress.h"
#include "texture_replay.h"
#include <fstream>
#include <iterator>

int trellis_run(const trellis::TrellisParams& params) { return trellis_run(params, nullptr); }
int trellis_run(const trellis::TrellisParams& params, trellis::GenerationDataCapture* capture) {
    fixture_glb(params.output);
    trellis::report_progress("package", 0, 0, 0, 0, -1);
    if (capture) {
        std::ifstream input(params.image, std::ios::binary);
        std::string scenario((std::istreambuf_iterator<char>(input)), std::istreambuf_iterator<char>());
        capture->begin(params, params.seed ? params.seed : 43, false);
        CaptureFixture fixture;
        if (scenario == "invalid-shape") fixture.coordinates[0][0]++;
        fixture.complete(*capture, params.output);
        if (scenario == "package-write-failure") {
            std::ofstream occupied(params.output.substr(0, params.output.size() - 4) + ".trgpk");
            occupied << "synthetic collision";
        }
    }
    return 0;
}

namespace trellis {
SavedTextureOption replay_texture(const SavedGenerationData& data, const TrellisParams&, uint32_t seed, bool original_noise) {
    SavedTextureOption option; option.seed = seed ? seed : 43; option.original_noise = original_noise;
    option.field.assign(data.coordinates.size() * 6, .5f);
    option.preview.assign(data.surface.vertices.size() * 2, .5f);
    report_progress("texture_flow", 12, 12, 12, 12, 0);
    return option;
}
void bake_texture_option(const SavedGenerationData&, const SavedTextureOption&, const std::string& output, int, int) { fixture_glb(output); }
}
