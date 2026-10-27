cmake_minimum_required(VERSION 3.18)
project(triastasis_generation_data_tests LANGUAGES CXX)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
enable_testing()
find_package(Python3 REQUIRED COMPONENTS Interpreter)
find_package(Threads REQUIRED)
get_filename_component(REPO "${CMAKE_CURRENT_SOURCE_DIR}/../.." ABSOLUTE)

# This CPU-only contract suite also builds independently of ggml, CUDA, model
# files and the desktop app: cmake -S tests/generation-data -B build-data-tests.
add_library(generation-data-test-support STATIC
  "${REPO}/src/generation_data.cpp" fixture.cpp)
target_include_directories(generation-data-test-support PUBLIC
  "${REPO}/include" "${REPO}/src" "${REPO}/thirdparty/stb")
add_executable(generation-data-test core.cpp)
target_link_libraries(generation-data-test PRIVATE generation-data-test-support)
add_executable(generation-data-test-server "${REPO}/src/trellis-server.cpp"
  "${REPO}/src/trellis_args.cpp" server_stub.cpp)
target_include_directories(generation-data-test-server PRIVATE "${REPO}/thirdparty/cpp-httplib")
target_link_libraries(generation-data-test-server PRIVATE generation-data-test-support Threads::Threads)
add_test(NAME generation-data-contract COMMAND "${Python3_EXECUTABLE}"
  "${CMAKE_CURRENT_SOURCE_DIR}/contract_test.py"
  "$<TARGET_FILE:generation-data-test>" "$<TARGET_FILE:generation-data-test-server>")

add_executable(generation-data-sampler-test sampler.cpp "${REPO}/src/uv_bake.cpp" "${REPO}/src/tri_bvh.cpp"
  "${REPO}/thirdparty/xatlas/xatlas.cpp" "${REPO}/thirdparty/meshoptimizer/simplifier.cpp")
target_include_directories(generation-data-sampler-test PRIVATE "${REPO}/include"
  "${REPO}/thirdparty/xatlas" "${REPO}/thirdparty/meshoptimizer" "${REPO}/thirdparty/fqms")
target_link_libraries(generation-data-sampler-test PRIVATE Threads::Threads)
add_test(NAME generation-data-sampler COMMAND generation-data-sampler-test)
