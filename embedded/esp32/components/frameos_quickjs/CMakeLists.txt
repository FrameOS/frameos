# QuickJS (bellard.org, vendored at frameos/quickjs) as an IDF component.
#
# Compiles the engine only — quickjs-libc (std/os modules, POSIX worker
# threads, pipes) stays out; scenes get their API surface from the Nim
# js_runtime bridge instead. fos_qjs_glue.c provides fos_js_new_runtime():
# a runtime whose heap lives in PSRAM and whose stack limit fits the render
# task.
set(QUICKJS_DIR "${CMAKE_CURRENT_LIST_DIR}/../../../../frameos/quickjs")
get_filename_component(QUICKJS_DIR "${QUICKJS_DIR}" ABSOLUTE)
get_filename_component(QUICKJS_PARENT "${QUICKJS_DIR}/.." ABSOLUTE)

if(NOT EXISTS "${QUICKJS_DIR}/quickjs.c")
    message(FATAL_ERROR "frameos_quickjs: vendored QuickJS not found at ${QUICKJS_DIR} (run `nimble build_quickjs` in frameos/)")
endif()

file(STRINGS "${QUICKJS_DIR}/VERSION" QUICKJS_VERSION LIMIT_COUNT 1)

idf_component_register(
    SRCS
        "${QUICKJS_DIR}/quickjs.c"
        "${QUICKJS_DIR}/dtoa.c"
        "${QUICKJS_DIR}/libregexp.c"
        "${QUICKJS_DIR}/libunicode.c"
        "${QUICKJS_DIR}/cutils.c"
        "fos_qjs_glue.c"
    # QUICKJS_PARENT lets Nim-generated C (and the glue) include
    # "quickjs/quickjs.h" with the same path it uses on Linux.
    INCLUDE_DIRS "include" "${QUICKJS_PARENT}"
    PRIV_INCLUDE_DIRS "${QUICKJS_DIR}"
    PRIV_REQUIRES heap
)

target_compile_definitions(${COMPONENT_LIB} PRIVATE
    _GNU_SOURCE
    CONFIG_VERSION="${QUICKJS_VERSION}"
    # newlib's struct tm has no tm_gmtoff; the device runs UTC (SNTP), so the
    # local-time offset is genuinely 0. tm_isdst exists and is 0 in UTC.
    "tm_gmtoff=tm_isdst")

# newlib has no malloc_usable_size; quickjs.c only uses it in the default
# allocator's accounting, which fos_js_new_runtime replaces. Upstream's own
# fallback comment says "change this to return 0". (A compile option because
# target_compile_definitions drops function-like macros.)
target_compile_options(${COMPONENT_LIB} PRIVATE
    "SHELL:-D'malloc_usable_size(ptr)=0'")

# Same semantics the upstream Makefile builds with; QuickJS C is not
# warning-clean under the IDF's default -Werror set. Xtensa newlib types
# int32_t as long, and quickjs.c mixes int*/int32_t* (same width) — GCC 14
# treats that as an error unless downgraded.
target_compile_options(${COMPONENT_LIB} PRIVATE
    -funsigned-char -fwrapv -fno-strict-aliasing -fno-lto -w
    -Wno-error=incompatible-pointer-types)
