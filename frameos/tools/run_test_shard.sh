#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: tools/run_test_shard.sh <1|2|3> [--print]

Runs one deterministic FrameOS Nim test shard from the frameos/ directory.
Any test files under `src/**/tests/` that are not explicitly listed below are
assigned to shards in a deterministic pseudo-random order.
Pass --print to list the shard contents without running testament.
EOF
}

if [[ $# -lt 1 || $# -gt 2 ]]; then
  usage >&2
  exit 1
fi

shard="$1"
print_only=0

if [[ "${2:-}" == "--print" ]]; then
  print_only=1
elif [[ $# -eq 2 ]]; then
  usage >&2
  exit 1
fi

frameos_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$frameos_dir"

total_shards=3

discover_tests() {
  find src -type f -name '*.nim' | awk -F/ '$(NF-1) == "tests" && $NF ~ /^test.*\.nim$/ { print }' | sort
}

select_extra_tests_for_shard() {
  local shard_index="$1"

  while IFS= read -r discovered_test; do
    [[ -z "$discovered_test" ]] && continue

    if ! printf '%s\n' "${all_listed_tests[@]}" | grep -Fqx -- "$discovered_test"; then
      extra_tests+=("$discovered_test")
    fi
  done < <(discover_tests)

  if (( ${#extra_tests[@]} == 0 )); then
    return
  fi

  local idx=0
  local hash
  local test_file

  while IFS=$'\t' read -r hash test_file; do
    if (( idx % total_shards == shard_index - 1 )); then
      shard_extra_tests+=("$test_file")
    fi
    idx=$((idx + 1))
  done < <(
    for test_file in "${extra_tests[@]}"; do
      hash="$(printf '%s' "$test_file" | cksum | awk '{print $1}')"
      printf '%s\t%s\n' "$hash" "$test_file"
    done | sort -n -k1,1 -k2,2
  )
}

declare -a tests=()
declare -a extra_tests=()
declare -a shard_extra_tests=()
declare -a shard_1_tests=(
  "src/frameos/tests/test_runner_loop.nim"
  "src/frameos/server/tests/test_api.nim"
  "src/frameos/tests/test_portal.nim"
  "src/frameos/tests/test_scenes_helpers.nim"
  "src/apps/tests/test_apps_dispatch.nim"
  "src/apps/data/openaiImage/tests/test_app.nim"
  "src/scenes/tests/test_scenes_registry.nim"
  "src/apps/data/rstpSnapshot/tests/test_app.nim"
  "src/system/wifiHotspot/tests/test_scene.nim"
  "src/system/bootGuard/tests/test_scene.nim"
  "src/frameos/tests/test_tls_proxy.nim"
  "src/apps/data/qr/tests/test_app.nim"
  "src/apps/data/icalJson/tests/test_app.nim"
  "src/apps/data/openaiText/tests/test_app.nim"
  "src/frameos/server/tests/test_auth.nim"
  "src/frameos/server/tests/test_common.nim"
  "src/frameos/server/tests/test_state.nim"
  "src/frameos/tests/test_metrics.nim"
  "src/apps/data/newImage/tests/test_app.nim"
  "src/frameos/tests/test_apps_helpers.nim"
  "src/frameos/tests/test_config.nim"
  "src/apps/logic/setAsState/tests/test_app.nim"
  "src/frameos/tests/test_channels.nim"
  "src/apps/logic/nextSleepDuration/tests/test_app.nim"
  "src/apps/data/clock/tests/test_app.nim"
  "src/apps/logic/breakIfRendering/tests/test_app.nim"
  "src/frameos/tests/test_boot_guard.nim"
  "src/frameos/utils/tests/test_period.nim"
)
declare -a shard_2_tests=(
  "src/frameos/server/tests/test_admin_api_routes_behavior.nim"
  "src/frameos/server/tests/test_routes.nim"
  "src/frameos/tests/test_frameos_startup.nim"
  "src/frameos/tests/test_scenes_registry_state_cleanup.nim"
  "src/frameos/tests/test_interpreter_errors.nim"
  "src/system/tests/test_scenes_registry.nim"
  "src/apps/data/downloadImage/tests/test_app.nim"
  "src/apps/data/chromiumScreenshot/tests/test_app.nim"
  "src/apps/data/frameOSGallery/tests/test_app.nim"
  "src/frameos/tests/test_setup_proxy.nim"
  "src/apps/render/text/tests/test_app.nim"
  "src/frameos/utils/tests/test_text.nim"
  "src/drivers/httpUpload/tests/test_http_upload.nim"
  "src/apps/data/beRecycle/tests/test_app.nim"
  "src/apps/data/weather/tests/test_app.nim"
  "src/apps/data/downloadUrl/tests/test_app.nim"
  "src/apps/data/resizeImage/tests/test_app.nim"
  "src/drivers/inkyPython/tests/test_helpers.nim"
  "src/frameos/tests/test_values.nim"
  "src/apps/data/rotateImage/tests/test_app.nim"
  "src/apps/data/xmlToJson/tests/test_app.nim"
  "src/apps/render/opacity/tests/test_app.nim"
  "src/drivers/waveshare/tests/test_types.nim"
  "src/apps/render/split/tests/test_split_math.nim"
  "src/apps/data/prettyJson/tests/test_app.nim"
  "src/drivers/inkyHyperPixel2r/tests/test_helpers.nim"
  "src/frameos/tests/test_types_ids.nim"
  "src/frameos/utils/tests/test_system.nim"
)
declare -a shard_3_tests=(
  "src/frameos/server/tests/test_frame_api_routes_behavior.nim"
  "src/frameos/server/tests/test_web_routes_behavior.nim"
  "src/frameos/server/tests/test_server.nim"
  "src/frameos/tests/test_scenes_persistence.nim"
  "src/frameos/tests/test_interpreter_smoke.nim"
  "src/system/index/tests/test_scene.nim"
  "src/apps/data/unsplash/tests/test_app.nim"
  "src/apps/data/localImage/tests/test_app.nim"
  "src/apps/render/svg/tests/test_app.nim"
  "src/frameos/utils/tests/test_image.nim"
  "src/apps/render/image/tests/test_app.nim"
  "src/frameos/tests/test_logger.nim"
  "src/frameos/tests/test_scheduler.nim"
  "src/apps/data/icalJson/tests/test_ical.nim"
  "src/apps/data/haSensor/tests/test_app.nim"
  "src/frameos/utils/tests/test_font.nim"
  "src/frameos/tests/test_js_runtime_helpers.nim"
  "src/frameos/tests/test_config_helpers.nim"
  "src/apps/data/eventsToAgenda/tests/test_events_to_agenda.nim"
  "src/apps/render/calendar/tests/test_grouping.nim"
  "src/apps/data/log/tests/test_app.nim"
  "src/frameos/utils/tests/test_url.nim"
  "src/apps/render/color/tests/test_app.nim"
  "src/apps/data/parseJson/tests/test_app.nim"
  "src/apps/render/gradient/tests/test_app.nim"
  "src/apps/logic/ifElse/tests/test_app.nim"
  "src/frameos/utils/tests/test_dither.nim"
  "src/frameos/utils/tests/test_time.nim"
)
declare -a all_listed_tests=(
  "${shard_1_tests[@]}"
  "${shard_2_tests[@]}"
  "${shard_3_tests[@]}"
)

case "$shard" in
  1)
    tests=("${shard_1_tests[@]}")
    ;;
  2)
    tests=("${shard_2_tests[@]}")
    ;;
  3)
    tests=("${shard_3_tests[@]}")
    ;;
  *)
    usage >&2
    exit 1
    ;;
esac

extra_test_count=0
select_extra_tests_for_shard "$shard"

if [[ ${shard_extra_tests[*]+_} ]]; then
  extra_test_count=${#shard_extra_tests[@]}
  if (( extra_test_count > 0 )); then
    tests+=("${shard_extra_tests[@]}")
  fi
fi

echo "FrameOS Nim test shard ${shard}: ${#tests[@]} files (${extra_test_count} auto-discovered)"

if (( print_only )); then
  printf '%s\n' "${tests[@]}"
  exit 0
fi

for test_file in "${tests[@]}"; do
  echo "==> ${test_file}"
  testament pattern "./${test_file}" --lineTrace:on
done
