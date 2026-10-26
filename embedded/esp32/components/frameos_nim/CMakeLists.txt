# FrameOS Nim runtime as an IDF component.
#
# build_nim.sh (in the project root) compiles frameos/src/embedded with
# `nim c --compileOnly --os:freertos --cpu:esp` and drops the generated C
# plus nimbase.h into nimcache/. When that directory exists we compile it;
# otherwise a stub keeps the firmware buildable (thin-client only).
file(GLOB NIM_GENERATED_SRCS "${CMAKE_CURRENT_LIST_DIR}/nimcache/*.c")

if(NIM_GENERATED_SRCS)
    idf_component_register(
        SRCS ${NIM_GENERATED_SRCS} "frameos_nim_glue.c" "fos_log_backoff.c" "fos_netguard.c" "fos_version.c"
        INCLUDE_DIRS "include"
        PRIV_INCLUDE_DIRS "nimcache"
        # frameos_quickjs: the Nim js_runtime binds QuickJS (include path +
        # fos_js_new_runtime); esp_http_client/mbedtls back the Nim HTTP HAL;
        # lwip is fos_netguard.c's getaddrinfo(); esp_netif tells a failed
        # connect apart from a station with no IP.
        PRIV_REQUIRES esp_timer pthread frameos_quickjs esp_http_client esp-tls mbedtls lwip esp_netif spiffs fatfs
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
    # pixie's raster modules compile at -O2 instead of the image's -Os: an
    # animated logo's raster went from 31 to 26 ms on the SenseCAP Indicator
    # for 36 KB of flash. The SVG, XML and string modules gained nothing and
    # stay -Os (docs/realtime-rendering.md). Nim names a module's C file
    # after its path, ROT13'd: "@fcvkvr@fcnguf" is "@spixie@spaths".
    set(FRAMEOS_NIM_HOT_MODULES
        "@fcvkvr@fcnguf.nim.c"     # pixie/paths: flattening, coverage, fills
        "@fcvkvr@fvzntrf.nim.c"    # pixie/images
        "@fcvkvr@foyraqf.nim.c"    # pixie/blends
        "@fcvkvr@fvagreany.nim.c"  # pixie/internal
        "@fcvkvr@feto565.nim.c"    # pixie/rgb565
        "@fcvkvr@fpbzzba.nim.c"    # pixie/common
        "@fsenzrbf@fhgvyf@ferfnzcyr.nim.c") # frameos/utils/resample: zoomPan's frame
    foreach(src ${NIM_GENERATED_SRCS})
        foreach(hot ${FRAMEOS_NIM_HOT_MODULES})
            string(FIND "${src}" "${hot}" at)
            if(NOT at EQUAL -1)
                set_source_files_properties("${src}" PROPERTIES COMPILE_OPTIONS "-O2")
            endif()
        endforeach()
    endforeach()
else()
    # fos_netguard.c is in both branches on purpose: fos_cloud.c arms the
    # private-network policy unconditionally, so a thin-client image that
    # dropped this file would fail to link.
    idf_component_register(
        SRCS "frameos_nim_stub.c" "fos_netguard.c" "fos_version.c"
        INCLUDE_DIRS "include"
        PRIV_REQUIRES lwip
    )
    message(STATUS "frameos_nim: no nimcache/, building stub (run build_nim.sh)")
endif()
