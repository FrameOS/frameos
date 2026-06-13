# FrameOS Nim runtime as an IDF component.
#
# build_nim.sh (in the project root) compiles frameos/src/embedded with
# `nim c --compileOnly --os:freertos --cpu:esp` and drops the generated C
# plus nimbase.h into nimcache/. When that directory exists we compile it;
# otherwise a stub keeps the firmware buildable (thin-client only).
file(GLOB NIM_GENERATED_SRCS "${CMAKE_CURRENT_LIST_DIR}/nimcache/*.c")

if(NIM_GENERATED_SRCS)
    idf_component_register(
        SRCS ${NIM_GENERATED_SRCS} "frameos_nim_glue.c"
        INCLUDE_DIRS "include"
        PRIV_INCLUDE_DIRS "nimcache"
        PRIV_REQUIRES esp_timer pthread
    )
    # Nim's generated C is not warning-clean; it's machine output. Nim also
    # passes long* where the overflow builtins want int* (same width on
    # Xtensa) — GCC 14 makes that an error unless told otherwise.
    target_compile_options(${COMPONENT_LIB} PRIVATE
        -w -Wno-error=incompatible-pointer-types -fno-strict-aliasing -fno-lto)
    target_compile_definitions(${COMPONENT_LIB} PRIVATE FRAMEOS_NIM_ENABLED=1)
else()
    idf_component_register(
        SRCS "frameos_nim_stub.c"
        INCLUDE_DIRS "include"
    )
    message(STATUS "frameos_nim: no nimcache/, building stub (run build_nim.sh)")
endif()
