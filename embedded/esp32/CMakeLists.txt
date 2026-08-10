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
