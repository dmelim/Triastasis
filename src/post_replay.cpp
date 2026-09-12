// post-replay — re-run the post-neural stages (weld, hole fill, decimation, UV
// bake, GLB write) from a TRELLIS_DUMP_POST dump, skipping the ~10-minute
// neural pipeline. Development harness for iterating on mesh/texture
// post-processing.
//
//   post-replay <dump.bin> <out.glb> [--box-uv] [--faces N] [--atlas T]
//               [--decim GRID] [--no-weld] [--no-fill]
// Research: --codec-study writes <out> (WebP), <out>.png.glb and raw atlas
// bytes from one bake. --sampling-study writes box/default, box/project-first
// and xatlas/default PNG variants from one final mesh, using <out> as a prefix.
// --probe-points <xyz.txt> writes material CSV at <out>, after original-mesh
// weld/fill and BVH construction, skipping remesh, simplification and baking.
#include "uv_bake.h"
#include "tri_bvh.h"
#include "remesh_dc.h"
#include "mesh_glb.h"
#include "trellis_diagnostics.h"
#include <chrono>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>
#include <filesystem>
#include <utility>
#include <fstream>
#include <iomanip>
#include <cmath>
#include <algorithm>

using trellis::VoxelPbr;

static double now() {
    return std::chrono::duration<double>(std::chrono::steady_clock::now().time_since_epoch()).count();
}

// boundary/non-manifold audit over the welded index space (positions assumed welded)
#include <unordered_map>
static void audit(const char* tag, const std::vector<int32_t>& faces) {
    std::unordered_map<uint64_t,int> e;
    e.reserve(faces.size() * 2);
    const size_t F = faces.size() / 3;
    auto k = [](int a, int b){ if (a>b){int t=a;a=b;b=t;} return ((uint64_t)(uint32_t)a<<32)|(uint32_t)b; };
    for (size_t f = 0; f < F; ++f)
        for (int j = 0; j < 3; ++j) e[k(faces[3*f+j], faces[3*f+(j+1)%3])]++;
    size_t nb = 0, nm = 0;
    for (auto& kv : e) { if (kv.second == 1) ++nb; else if (kv.second > 2) ++nm; }
    printf("  [audit] %-22s F=%-9zu boundary_edges=%-7zu nonmanifold=%zu\n", tag, F, nb, nm);
    fflush(stdout);
}

int main(int argc, char** argv) {
    if (argc < 3) { fprintf(stderr, "usage: post-replay <dump.bin> <out.glb> [opts]\n"); return 1; }
    const char* dump = argv[1];
    const char* out = argv[2];
    trellis::diagnostics::Session diagnostics(0, out);
    trellis::diagnostics::event("replay", {{"seed_known", false}});
    bool boxuv = false, do_weld = true, do_fill = true, do_bake = true, do_remesh = true, do_snap = true;
    bool codec_study = false, sampling_study = false;
    std::string probe_points;
    int band = 1;
    int faces_target = 300000, atlas = 2048, decim = -1;
    for (int i = 3; i < argc; ++i) {
        std::string a = argv[i];
        if (a == "--box-uv") boxuv = true;
        else if (a == "--faces" && i+1 < argc) faces_target = atoi(argv[++i]);
        else if (a == "--atlas" && i+1 < argc) atlas = atoi(argv[++i]);
        else if (a == "--decim" && i+1 < argc) decim = atoi(argv[++i]);
        else if (a == "--no-weld") do_weld = false;
        else if (a == "--no-fill") do_fill = false;
        else if (a == "--no-bake") do_bake = false;
        else if (a == "--no-remesh") do_remesh = false;
        else if (a == "--band" && i+1 < argc) band = atoi(argv[++i]);
        else if (a == "--no-snap") do_snap = false;
        else if (a == "--codec-study") codec_study = true;
        else if (a == "--sampling-study") sampling_study = true;
        else if (a == "--probe-points" && i+1 < argc) probe_points = argv[++i];
        else { fprintf(stderr, "unknown or incomplete option: %s\n", a.c_str()); return 2; }
    }
    if (faces_target <= 0 || atlas <= 0 || band <= 0 ||
        (codec_study && sampling_study) || ((codec_study || sampling_study) && !do_bake) ||
        (sampling_study && !do_snap) || (!probe_points.empty() && (codec_study || sampling_study || !do_snap))) {
        fprintf(stderr, "invalid or conflicting replay study settings\n"); return 2;
    }

    FILE* f = fopen(dump, "rb");
    if (!f) { fprintf(stderr, "cannot open %s\n", dump); return 1; }
    // The order of '+' operands is unspecified; separate fread calls in one
    // sum can consume this header backwards under MSVC.
    int header[4];
    if (fread(header, sizeof(int), 4, f) != 4) {
        fclose(f); fprintf(stderr, "truncated replay header\n"); return 1;
    }
    const int V = header[0], F = header[1], Mv = header[2], res = header[3];
    if (V <= 0 || F <= 0 || Mv <= 0 || res <= 0) {
        fclose(f); fprintf(stderr, "invalid replay dimensions\n"); return 1;
    }
    std::vector<float> verts((size_t)V*3);
    std::vector<int32_t> faces((size_t)F*3);
    std::vector<std::array<int,3>> coords((size_t)Mv);
    std::vector<float> pbr6((size_t)Mv*6);
    if (fread(verts.data(),4,verts.size(),f) != verts.size()) return 1;
    if (fread(faces.data(),4,faces.size(),f) != faces.size()) return 1;
    for (auto& c : coords) if (fread(c.data(),4,3,f) != 3) return 1;
    if (fread(pbr6.data(),4,pbr6.size(),f) != pbr6.size()) return 1;
    fclose(f);
    trellis::diagnostics::event("replay_settings", {{"resolution", res}, {"vertices", V}, {"faces", F},
        {"material_voxels", Mv}, {"band", band}, {"target_faces", faces_target}, {"atlas_size", atlas},
        {"remesh", do_remesh}, {"snap", do_snap}, {"weld", do_weld}, {"fill", do_fill},
        {"bake", do_bake}, {"cluster_grid", decim}, {"uv", boxuv ? "box" : "xatlas"},
        {"codec_study", codec_study}, {"sampling_study", sampling_study}, {"probe_only", !probe_points.empty()}});
    trellis::diagnostics::pbr("replayed_voxel_pbr", pbr6);
    printf("loaded: V=%d F=%d voxels=%d res=%d\n", V, F, Mv, res);

    double t = now();
    if (do_weld) trellis::weld_vertices(verts, faces, nullptr, 1.0f / ((float)res * 8.0f));
    printf("  [weld %.1fs]\n", now()-t); t = now();
    audit("weld", faces);
    if (do_fill) trellis::fill_small_holes(faces);
    printf("  [fill %.1fs]\n", now()-t); t = now();
    audit("fill_small_holes", faces);

    trellis::TriBvh bvh = trellis::TriBvh::build(verts.data(), (int64_t)verts.size()/3,
                                                 faces.data(), (int64_t)faces.size()/3);
    printf("  [bvh %.1fs]\n", now()-t); t = now();
    if (!probe_points.empty()) {
        std::ifstream input(std::filesystem::u8path(probe_points));
        std::vector<std::array<float,3>> points;
        std::array<float,3> point;
        while (input >> point[0]) {
            if (!(input >> point[1] >> point[2]) ||
                !std::isfinite(point[0]) || !std::isfinite(point[1]) || !std::isfinite(point[2]) ||
                std::max({std::fabs(point[0]),std::fabs(point[1]),std::fabs(point[2])}) > 2 || points.size() >= 1000000) {
                fprintf(stderr, "invalid or excessive probe points\n"); return 2;
            }
            points.push_back(point);
        }
        if (!input.eof() || points.empty()) { fprintf(stderr, "cannot read probe points\n"); return 2; }
        if (std::filesystem::exists(std::filesystem::u8path(out))) {
            fprintf(stderr, "probe output already exists\n"); return 2;
        }
        const auto probes = trellis::probe_voxel_samples(VoxelPbr{&coords, &pbr6, res, &bvh}, points);
        std::ofstream output(std::filesystem::u8path(out));
        output << "x,y,z,direct_valid,projected_valid,direct_support,projected_support,direct_corners,projected_corners,distance_voxels,projected_face,projected_x,projected_y,projected_z";
        for (const char* prefix : {"direct", "projected"})
            for (const char* channel : {"r", "g", "b", "metallic", "roughness", "alpha"}) output << ',' << prefix << '_' << channel;
        output << '\n' << std::setprecision(9);
        for (size_t i = 0; i < probes.size(); ++i) {
            const auto& r = probes[i];
            output << points[i][0] << ',' << points[i][1] << ',' << points[i][2]
                << ',' << r.direct_valid << ',' << r.projected_valid << ',' << r.direct_support << ',' << r.projected_support
                << ',' << r.direct_corners << ',' << r.projected_corners << ',' << r.distance_voxels << ',' << r.projected_face;
            for (float v : r.projected_point) output << ',' << v;
            for (float v : r.direct) output << ',' << v;
            for (float v : r.projected) output << ',' << v;
            output << '\n';
        }
        output.close();
        if (!output) { fprintf(stderr, "cannot write probe CSV\n"); return 1; }
        trellis::diagnostics::event("voxel_probe", {{"points", points.size()}, {"max_projection_voxels", 8}});
        diagnostics.finish("probe_only");
        printf("wrote %zu material probes\n", probes.size()); return 0;
    }
    trellis::Mesh rm;
    if (do_remesh) {
        rm = trellis::remesh_narrow_band_dc(verts.data(), (int64_t)verts.size()/3,
                                            faces.data(), (int64_t)faces.size()/3, bvh, res, band);
        printf("  [remesh %.1fs]\n", now()-t); t = now();
        audit("remesh", rm.faces);
        // match the CLI: clean degenerates/unify winding, drop floater components
        if (rm.F() > 0) {
            trellis::clean_mesh(rm.V(), rm.faces);
            audit("clean_mesh", rm.faces);
            int ndrop = trellis::drop_small_components(rm.verts, rm.faces, 0.02f);
            printf("  [clean+drop %.1fs] dropped=%d\n", now()-t, ndrop); t = now();
            audit("drop_components", rm.faces);
        }
    }
    const std::vector<float>& sverts = rm.F() > 0 ? rm.verts : verts;
    const std::vector<int32_t>& sfaces = rm.F() > 0 ? rm.faces : faces;

    std::vector<float> dv, dp; std::vector<int32_t> df;
    if (decim > 0) trellis::decimate_cluster(sverts, (int)sverts.size()/3, sfaces, (int)sfaces.size()/3, {}, decim, dv, df, dp);
    else if (decim == 0) { dv = sverts; df = sfaces; }
    else {
        // match the CLI: faithful QEM port (not the old meshopt/FQMS decimate_simplify)
        trellis::decimate_qem(sverts, (int)sverts.size()/3, sfaces, (int)sfaces.size()/3, faces_target, dv, df);
        audit("decimate_qem", df);
        trellis::weld_vertices(dv, df, nullptr, 1.0f / ((float)res * 8.0f));
        audit("weld2", df);
        trellis::fill_small_holes(df);
        audit("fill2", df);
        int ndrop2 = trellis::drop_small_components(dv, df, 0.03f);
        if (ndrop2) printf("  dropped %d more comps\n", ndrop2);
        audit("drop2", df);
    }
    printf("  [decimate %.1fs]\n", now()-t); t = now();
    if (!do_bake) { diagnostics.finish("postprocess_only"); printf("(--no-bake) done\n"); return 0; }

    VoxelPbr vox{&coords, &pbr6, res, do_snap ? &bvh : nullptr};
    const std::vector<float> no_vp;
    auto save = [&](const trellis::BakedMesh& baked, const std::string& path, bool webp) {
        trellis::diagnostics::Stage stage("replay_export");
        trellis::diagnostics::event("replay_output", {{"filename", std::filesystem::u8path(path).filename().string()},
            {"vertices", baked.verts.size()/3}, {"faces", baked.faces.size()/3}, {"atlas_size", baked.T}});
        return trellis::write_glb_textured(path.c_str(), baked.verts.data(), baked.verts.size()/3, baked.uv.data(),
            baked.faces.data(), baked.faces.size()/3, baked.base.data(), baked.mr.data(), baked.T,
            rm.F() == 0, -1, nullptr, webp);
    };
    auto dump_atlas = [](const trellis::BakedMesh& baked, const std::string& path) {
        for (const auto& entry : {std::make_pair(".base.rgba", &baked.base), std::make_pair(".mr.rgba", &baked.mr)}) {
            FILE* file = fopen((path + entry.first).c_str(), "wb");
            if (!file) return false;
            const bool ok = fwrite(entry.second->data(), 1, entry.second->size(), file) == entry.second->size();
            const bool closed = fclose(file) == 0;
            if (!ok || !closed) return false;
        }
        return true;
    };
    if (sampling_study) {
        bool written = true;
        for (int variant = 0; variant < 3; ++variant) {
            const char* name = variant == 0 ? "box-default" : variant == 1 ? "box-project-first" : "xatlas-default";
            vox.project_first = variant == 1;
            trellis::diagnostics::Stage stage("replay_variant");
            trellis::diagnostics::event("replay_variant", {{"name", name}, {"project_first", vox.project_first}});
            auto baked = variant == 2
                ? trellis::uv_bake(dv, dv.size()/3, df, df.size()/3, no_vp, atlas, &vox)
                : trellis::uv_box_project(dv, dv.size()/3, df, df.size()/3, no_vp, atlas, &vox);
            // Do not silently substitute another UV method in a controlled study.
            if (!baked.ok()) { diagnostics.finish("failed"); return 1; }
            const std::string path = std::string(out) + "." + name + ".glb";
            written = save(baked, path, false) && written;
            written = dump_atlas(baked, path) && written;
        }
        diagnostics.finish(written ? "completed" : "output_failed");
        return written ? 0 : 1;
    }
    trellis::diagnostics::Stage bake_stage("replay_unwrap_and_bake");
    trellis::BakedMesh bm = boxuv
        ? trellis::uv_box_project(dv, (int)dv.size()/3, df, (int)df.size()/3, no_vp, atlas, &vox)
        : trellis::uv_bake(dv, (int)dv.size()/3, df, (int)df.size()/3, no_vp, atlas, &vox);
    if (!boxuv && !bm.ok())
        bm = trellis::uv_chart_project(dv, (int)dv.size()/3, df, (int)df.size()/3, no_vp, atlas, &vox);
    printf("  [bake %.1fs]\n", now()-t);
    bake_stage.end();
    if (!bm.ok()) { fprintf(stderr, "bake failed\n"); return 1; }
    printf("  [audit] bake: faces in=%zu out=%zu (dropped %lld)\n",
           df.size()/3, bm.faces.size()/3, (long long)(df.size()/3) - (long long)(bm.faces.size()/3));
    bool written = save(bm, out, true);
    if (codec_study) {
        written = save(bm, std::string(out) + ".png.glb", false) && written;
        written = dump_atlas(bm, out) && written;
    }
    printf("wrote %s (atlas %d)\n", out, bm.T);
    diagnostics.finish(written ? "completed" : "output_failed");
    return written ? 0 : 1;
}
