#include "uv_bake.h"
#include "tri_bvh.h"
#include <iostream>
#include <stdexcept>

void check(bool value, const char* message) { if (!value) throw std::runtime_error(message); }
int main() {
    try {
        const float p = .5f / 512 - .5f;
        std::vector<std::array<int,3>> coordinates{{0,0,0}};
        std::vector<float> dense{p,p,p, p+1.f/512,p,p, p,p+1.f/512,p};
        std::vector<int32_t> faces{0,1,2};
        const std::vector<float> vertices{p,p,p, .4f,.4f,.4f};
        std::vector<float> first{.4f,.7f,.3f,.1f,.9f,1}, expected, actual;
        auto bvh = trellis::TriBvh::build(dense.data(), 3, faces.data(), 1);
        trellis::VoxelPbr volume{&coordinates,&first,512,&bvh};
        check(trellis::sample_pbr_vertices(vertices,volume,expected) == 1, "fresh sampler miss count");
        trellis::PbrVertexSampler cached(coordinates,dense,faces);
        coordinates.clear(); dense.clear(); faces.clear();
        check(cached.sample(vertices,first,actual) == 1 && actual == expected, "cached sampler differs or borrows source arrays");
        first.clear(); first.shrink_to_fit();
        std::vector<float> second{.1f,.2f,.9f,.7f,.2f,1};
        cached.sample(vertices,second,actual);
        check(actual[0] == .1f && actual[1] == .2f && actual[3] == .7f && actual[4] == .2f, "cached sampler retained an old field");
        const float point[3] = {p,p,p};
        check(cached.snap().closest(point,1).face >= 0, "cached dense arrays did not outlive the BVH");
        bool rejected = false;
        try { cached.sample(vertices,{},actual); } catch (const std::exception&) { rejected = true; }
        check(rejected, "cached sampler accepted invalid field dimensions");
        std::cout << "PASS cached sampler parity, source ownership, independent fields, BVH lifetime and bounds\n";
        return 0;
    } catch (const std::exception& error) { std::cerr << error.what() << '\n'; return 1; }
}
