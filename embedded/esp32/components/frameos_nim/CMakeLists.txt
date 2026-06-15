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
        # frameos_quickjs: the Nim js_runtime binds QuickJS (include path +
        # fos_js_new_runtime); esp_http_client/mbedtls back the Nim HTTP HAL.
        PRIV_REQUIRES esp_timer pthread frameos_quickjs esp_http_client esp-tls mbedtls
    )
    # Nim's generated C is not warning-clean; it's machine output. Nim also
    # passes long* where the overflow builtins want int* (same width on
    # Xtensa) — GCC 14 makes that an error unless told otherwise.
    # implicit-function-declaration: Nim's os module emits lstat(), which
    # newlib doesn't declare; the glue provides a stat()-backed shim (SPIFFS
    # has no symlinks).
    target_compile_options(${COMPONENT_LIB} PRIVATE
        -w -Wno-error=incompatible-pointer-types
        -Wno-error=implicit-function-declaration
        -fno-strict-aliasing -fno-lto)
    target_compile_definitions(${COMPONENT_LIB} PRIVATE FRAMEOS_NIM_ENABLED=1)
else()
    idf_component_register(
        SRCS "frameos_nim_stub.c"
        INCLUDE_DIRS "include"
    )
    message(STATUS "frameos_nim: no nimcache/, building stub (run build_nim.sh)")
endif()
