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

# The quickts this checkout pins. A quickjs/ left from before a pin change
# fails deep inside quickjs.c, or worse, builds the old engine without a word.
file(STRINGS "${QUICKJS_PARENT}/frameos.nimble" QUICKJS_PIN_LINE REGEX "QuickjsVersion *= *\"" LIMIT_COUNT 1)
string(REGEX REPLACE ".*QuickjsVersion *= *\"([^\"]+)\".*" "\\1" QUICKJS_PIN "${QUICKJS_PIN_LINE}")
if(NOT QUICKJS_PIN_LINE)
    message(FATAL_ERROR "frameos_quickjs: no QuickjsVersion in ${QUICKJS_PARENT}/frameos.nimble")
elseif(NOT QUICKJS_VERSION STREQUAL QUICKJS_PIN)
    message(FATAL_ERROR "frameos_quickjs: ${QUICKJS_DIR} holds QuickJS ${QUICKJS_VERSION}, frameos.nimble pins ${QUICKJS_PIN}: remove it and run `nimble build_quickjs` in frameos/")
endif()

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
    # QuickJS carves its small blocks out of arenas, one list per size class
    # (31 of them), so an interpreter's heap is its objects plus the empty
    # part of an arena per class in use: the SenseCAP kitchen sink's ~156 KB
    # of objects sat in 268 KB with 4 KB arenas. 1 KB leaves a quarter of
    # that empty. (newlib's missing tm_gmtoff and malloc_usable_size are
    # quickts's own business since 2026-06-04-quickts.2.)
    JS_MALLOC_ARENA_SIZE=1024)

# Same semantics the upstream Makefile builds with; QuickJS C is not
# warning-clean under the IDF's default -Werror set. Xtensa newlib types
# int32_t as long, and quickjs.c mixes int*/int32_t* (same width) — GCC 14
# treats that as an error unless downgraded.
target_compile_options(${COMPONENT_LIB} PRIVATE
    -funsigned-char -fwrapv -fno-strict-aliasing -fno-lto -w
    -Wno-error=incompatible-pointer-types)
