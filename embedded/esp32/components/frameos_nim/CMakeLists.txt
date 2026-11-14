# FrameOS Nim runtime as an IDF component.
#
# build_nim.sh (in the project root) compiles frameos/src/embedded with
# `nim c --compileOnly --os:freertos --cpu:esp` and drops the generated C
# plus nimbase.h into nimcache/. When that directory exists we compile it;
# otherwise a stub keeps the firmware buildable (thin-client only).
file(GLOB NIM_GENERATED_SRCS "${CMAKE_CURRENT_LIST_DIR}/nimcache/*.c")

if(NIM_GENERATED_SRCS)
    idf_component_register(
        SRCS ${NIM_GENERATED_SRCS} "frameos_nim_glue.c" "fos_log_backoff.c" "fos_netguard.c" "fos_version.c" "fos_rows.c"
             "fos_heap_walk.c" "fos_log_ring.c"
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
    # animated logo's raster went from 31 to 26 ms on the SenseCAP Indicator.
    # The SVG, XML and string modules gained nothing and stay -Os
    # (docs/realtime-rendering.md). Nim names a module's C file after its
    # path, `@m` and `@s` for the separators (`@m..@s..@spixie@ssrc@spixie@spaths`),
    # and nixpkgs' Nim (the flox dev shell) ROT13s that name (`@z..@f..@fcvkvr@ffep
    # @fcvkvr@fcnguf`): each module is listed both ways. Until 2026-11-10 only
    # the ROT13 names were, so a build with the official Nim (the Docker image,
    # CI, every release) compiled all of these at -Os: DVD Logo Bounce on the
    # SenseCAP ran ~5 ms a frame slower than on the flox bench builds of #626.
    # ci_build_image.sh checks the image it builds took -O2 for each.
    # The price, measured 2026-11-10: +38.5 KB of flash (images +14.0 K, paths
    # +12.7 K, blends +6.8 K, common +2.9 K). Worth it: these loops are every
    # frame of an animation and most of a render. Find bytes elsewhere before
    # taking a module off this list (docs/esp32-image-size.md).
    set(FRAMEOS_NIM_HOT_MODULES
        "@spixie@spaths.nim.c"     "@fcvkvr@fcnguf.nim.c"     # pixie/paths: flattening, coverage, fills
        "@spixie@simages.nim.c"    "@fcvkvr@fvzntrf.nim.c"    # pixie/images
        "@spixie@sblends.nim.c"    "@fcvkvr@foyraqf.nim.c"    # pixie/blends
        "@spixie@sinternal.nim.c"  "@fcvkvr@fvagreany.nim.c"  # pixie/internal
        "@spixie@srgb565.nim.c"    "@fcvkvr@feto565.nim.c"    # pixie/rgb565
        "@spixie@scommon.nim.c"    "@fcvkvr@fpbzzba.nim.c"    # pixie/common
        "@sframeos@sutils@sresample.nim.c" "@fsenzrbf@fhgvyf@ferfnzcyr.nim.c" # frameos/utils/resample: zoomPan's frame
        "@sframeos@sjs_runtime@spixel_ops.nim.c" "@fsenzrbf@fwf_ehagvzr@fcvkry_bcf.nim.c" # frameos/js_runtime/pixel_ops: frameos.pixels
        "@sframeos@sjs_runtime@styped_ops.nim.c" "@fsenzrbf@fwf_ehagvzr@fglcrq_bcf.nim.c") # frameos/js_runtime/typed_ops: frameos.ops
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
        SRCS "frameos_nim_stub.c" "fos_netguard.c" "fos_version.c" "fos_heap_walk.c" "fos_log_ring.c"
        INCLUDE_DIRS "include"
        PRIV_REQUIRES lwip
    )
    message(STATUS "frameos_nim: no nimcache/, building stub (run build_nim.sh)")
endif()
