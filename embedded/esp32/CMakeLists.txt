cmake_minimum_required(VERSION 3.16)

# The app version baked into the image descriptor and reported everywhere the
# firmware identifies itself: `frameos_version` at cloud enrollment and in
# every `hello` (main/fos_cloud.c), the local /api status payload
# (main/fos_http.c), and the OTA "is there something newer" comparison.
#
# Without this ESP-IDF falls through PROJECT_VER → version.txt → `git
# describe` → the literal string "1", and since this tree carries neither of
# the first two, EVERY build — released or local — reported "1". A fleet of
# ESP32 frames all claiming version "1" cannot be told apart in the workspace,
# and a version-gated update check against it is meaningless.
#
# Read from the repo's versions.json (the same `frameos` version the Pi
# images and the backend report), with the `+<sha>` build suffix stripped so
# the value matches what a buildroot frame reports. FRAMEOS_VERSION in the
# environment wins, for builds that happen outside a checkout. Parsed with a
# regex rather than string(JSON …) because that needs CMake 3.19 and ESP-IDF
# only asks for 3.16. Must be set BEFORE project().
if(DEFINED ENV{FRAMEOS_VERSION} AND NOT "$ENV{FRAMEOS_VERSION}" STREQUAL "")
    set(PROJECT_VER "$ENV{FRAMEOS_VERSION}")
else()
    set(FRAMEOS_VERSIONS_JSON "${CMAKE_CURRENT_LIST_DIR}/../../versions.json")
    if(EXISTS "${FRAMEOS_VERSIONS_JSON}")
        file(READ "${FRAMEOS_VERSIONS_JSON}" FRAMEOS_VERSIONS_CONTENT)
        # The character class excludes '+', which is what drops the build sha.
        string(REGEX MATCH "\"frameos\"[ \t]*:[ \t]*\"([^\"+]+)"
               FRAMEOS_VERSION_MATCH "${FRAMEOS_VERSIONS_CONTENT}")
        if(CMAKE_MATCH_1)
            set(PROJECT_VER "${CMAKE_MATCH_1}")
        endif()
    endif()
endif()
if(NOT DEFINED PROJECT_VER)
    # Better than IDF's "1": says plainly that this image cannot be placed.
    set(PROJECT_VER "0.0.0-unknown")
endif()
message(STATUS "FrameOS ESP32 app version: ${PROJECT_VER}")

include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(frameos_esp32)

# Code layout on Xtensa (the S3; the C3's RISC-V image is 1.4 MB and has
# neither problem). Both measured in docs/esp32-image-size.md, "Calls,
# alignment and strings" (2026-11-18).
if(CONFIG_IDF_TARGET_ARCH_XTENSA)
    # A CALL8 is 3 bytes and reaches 512 KB; a call further than that stays
    # the 6-byte L32R + CALLX8 that -mlongcalls emits. link_order.txt names
    # FrameOS's objects in an order that keeps callers near what they call
    # (tools/link_order.py writes it from a finished build): a third of the
    # image's calls were long, a tenth are.
    set(FOS_LINK_ORDER_LD "${CMAKE_BINARY_DIR}/link_order.ld")
    idf_build_get_property(fos_python PYTHON)
    execute_process(
        COMMAND "${fos_python}" "${CMAKE_CURRENT_LIST_DIR}/tools/link_order.py" emit
                --order "${CMAKE_CURRENT_LIST_DIR}/link_order.txt"
                --nimcache "${CMAKE_CURRENT_LIST_DIR}/components/frameos_nim/nimcache"
                --out "${FOS_LINK_ORDER_LD}"
        RESULT_VARIABLE FOS_LINK_ORDER_RESULT)
    if(NOT FOS_LINK_ORDER_RESULT EQUAL 0)
        message(FATAL_ERROR "tools/link_order.py emit failed")
    endif()
    set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS
        "${CMAKE_CURRENT_LIST_DIR}/link_order.txt" "${CMAKE_CURRENT_LIST_DIR}/tools/link_order.py")
    target_link_options(${CMAKE_PROJECT_NAME}.elf PRIVATE
        "-Wl,--section-ordering-file=${FOS_LINK_ORDER_LD}")
    set_property(TARGET ${CMAKE_PROJECT_NAME}.elf APPEND PROPERTY LINK_DEPENDS "${FOS_LINK_ORDER_LD}")

    # The assembler widens 2-byte instructions to 3 so that branch targets
    # land on a word boundary (a taken branch to an instruction that straddles
    # one costs a cycle), and the linker keeps that alignment when it shrinks
    # a call, by widening something else. Neither for the image: denser code
    # measured faster on the SenseCAP, not slower (the instruction cache is
    # what the frame rate waits for). The modules built at -O2 because their
    # loops are the frame rate still ask the assembler for it
    # (-mtarget-align on those files in components/frameos_nim and
    # components/frameos_quickjs); the linker's --size-opt is one flag for
    # the whole link.
    idf_build_set_property(COMPILE_OPTIONS "-mno-target-align" APPEND)
    target_link_options(${CMAKE_PROJECT_NAME}.elf PRIVATE "-Wl,--size-opt")
endif()
