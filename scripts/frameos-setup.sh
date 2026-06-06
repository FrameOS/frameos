#!/bin/sh
set -eu

FRAMEOS_RELEASE_VERSION="${FRAMEOS_RELEASE_VERSION:-2026.6.8}"
FRAMEOS_RELEASE_BASE_URL="${FRAMEOS_RELEASE_BASE_URL:-https://github.com/FrameOS/frameos/releases/download/}"
FRAMEOS_DIR="${FRAMEOS_DIR:-/srv/frameos}"
FRAMEOS_AGENT_DIR="${FRAMEOS_AGENT_DIR:-/srv/frameos/agent}"
FRAMEOS_ASSETS_DIR="${FRAMEOS_ASSETS_DIR:-/srv/assets}"
SUPPORTED_RELEASES="debian:buster debian:bullseye debian:bookworm debian:trixie ubuntu:22.04 ubuntu:24.04 ubuntu:26.04"
SUPPORTED_ARCHES="arm64 armhf amd64"
TTY="/dev/tty"
GENERATED_ADMIN_PASSWORD=""

if [ ! -r "$TTY" ] || [ ! -w "$TTY" ] || ! ( : <"$TTY" ) 2>/dev/null; then
  TTY=""
fi

say() {
  printf '%s\n' "$*"
}

warn() {
  printf '%s\n' "$*" >&2
}

die() {
  warn "$*"
  exit 1
}

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    die "Missing required command: $1"
  fi
}

prompt_out() {
  if [ -n "$TTY" ]; then
    printf '%s' "$*" >"$TTY"
  else
    printf '%s' "$*" >&2
  fi
}

prompt_line() {
  if [ -n "$TTY" ]; then
    printf '%s\n' "$*" >"$TTY"
  else
    printf '%s\n' "$*" >&2
  fi
}

ask() {
  prompt="$1"
  default="${2:-}"
  answer=""
  if [ -n "$default" ]; then
    prompt_out "$prompt [$default]: "
  else
    prompt_out "$prompt: "
  fi
  if [ -n "$TTY" ]; then
    IFS= read -r answer <"$TTY" || answer=""
  fi
  if [ -z "$answer" ]; then
    answer="$default"
  fi
  printf '%s\n' "$answer"
}

ask_required() {
  prompt="$1"
  default="${2:-}"
  while :; do
    answer="$(ask "$prompt" "$default")"
    if [ -n "$answer" ]; then
      printf '%s\n' "$answer"
      return
    fi
    if [ -z "$TTY" ]; then
      die "No terminal is available to ask: $prompt"
    fi
    warn "A value is required."
  done
}

ask_yes_no() {
  prompt="$1"
  default="${2:-n}"
  while :; do
    case "$default" in
      y|Y|yes|YES|true|1) suffix="Y/n" ;;
      *) suffix="y/N" ;;
    esac
    answer="$(ask "$prompt ($suffix)" "")"
    if [ -z "$answer" ]; then
      answer="$default"
    fi
    case "$answer" in
      y|Y|yes|YES|true|TRUE|1) printf '%s\n' "true"; return ;;
      n|N|no|NO|false|FALSE|0) printf '%s\n' "false"; return ;;
      *) warn "Please answer yes or no." ;;
    esac
  done
}

ask_secret() {
  prompt="$1"
  default_marker="${2:-}"
  answer=""
  if [ -n "$default_marker" ]; then
    prompt_out "$prompt [$default_marker]: "
  else
    prompt_out "$prompt: "
  fi
  if [ -n "$TTY" ]; then
    old_stty="$(stty -g <"$TTY" 2>/dev/null || true)"
    stty -echo <"$TTY" 2>/dev/null || true
    IFS= read -r answer <"$TTY" || answer=""
    if [ -n "$old_stty" ]; then
      stty "$old_stty" <"$TTY" 2>/dev/null || true
    else
      stty echo <"$TTY" 2>/dev/null || true
    fi
    prompt_line ""
  fi
  printf '%s\n' "$answer"
}

ask_int() {
  prompt="$1"
  default="$2"
  while :; do
    answer="$(ask "$prompt" "$default")"
    case "$answer" in
      ''|*[!0-9]*) warn "Please enter a whole number." ;;
      *) printf '%s\n' "$answer"; return ;;
    esac
  done
}

ask_float() {
  prompt="$1"
  default="$2"
  while :; do
    answer="$(ask "$prompt" "$default")"
    if python3 - "$answer" <<'PY'
import sys
try:
    value = float(sys.argv[1])
    raise SystemExit(0 if value > 0 else 1)
except Exception:
    raise SystemExit(1)
PY
    then
      printf '%s\n' "$answer"
      return
    fi
    warn "Please enter a positive number."
  done
}

install_packages() {
  if ! command -v apt-get >/dev/null 2>&1; then
    warn "apt-get not found; skipping package install: $*"
    return 0
  fi

  missing=""
  for package in "$@"; do
    if dpkg-query -W -f='${Status}' "$package" 2>/dev/null | grep -q '^install ok installed$'; then
      continue
    fi
    missing="$missing $package"
  done
  if [ -z "$missing" ]; then
    return 0
  fi

  if ! env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends $missing; then
    env DEBIAN_FRONTEND=noninteractive apt-get update
    env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends $missing
  fi
}

install_optional_packages() {
  if ! command -v apt-get >/dev/null 2>&1; then
    return 0
  fi
  if ! install_packages "$@"; then
    warn "Optional package install failed: $*"
  fi
}

download_file() {
  url="$1"
  destination="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$url" -o "$destination"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$destination" "$url"
  else
    die "Missing required command: curl or wget"
  fi
}

detect_arch() {
  case "$(uname -m)" in
    aarch64|arm64|armv8) echo arm64 ;;
    armv8l|armv7l|armv6l|armhf) echo armhf ;;
    x86_64|amd64) echo amd64 ;;
    *) die "Unsupported CPU architecture: $(uname -m). Supported architectures: $SUPPORTED_ARCHES" ;;
  esac
}

release_supported() {
  candidate="$1:$2"
  for supported in $SUPPORTED_RELEASES; do
    if [ "$candidate" = "$supported" ]; then
      return 0
    fi
  done
  return 1
}

print_supported_targets() {
  warn "Supported OS releases:"
  warn "  Debian: buster, bullseye, bookworm, trixie"
  warn "  Ubuntu: 22.04, 24.04, 26.04"
  warn "Supported architectures: $SUPPORTED_ARCHES"
}

detect_os_target() {
  arch="$(detect_arch)"
  if [ -n "${FRAMEOS_TARGET:-}" ]; then
    echo "$FRAMEOS_TARGET"
    return
  fi

  if [ ! -r /etc/os-release ]; then
    die "Cannot read /etc/os-release."
  fi

  # shellcheck disable=SC1091
  . /etc/os-release
  distro="${FRAMEOS_DISTRO_OVERRIDE:-${ID:-}}"
  release="${FRAMEOS_OS_RELEASE_OVERRIDE:-}"

  if [ -z "$release" ]; then
    release="${VERSION_CODENAME:-}"
  fi
  if [ -z "$release" ]; then
    release="${UBUNTU_CODENAME:-}"
  fi
  if [ -z "$release" ]; then
    release="${VERSION_ID:-}"
  fi

  case "$distro" in
    raspbian|raspios) distro=debian ;;
    debian|ubuntu) ;;
    *)
      case "${ID_LIKE:-}" in
        *debian*) distro=debian ;;
      esac
      ;;
  esac

  if [ "$distro" = "ubuntu" ]; then
    case "$release" in
      jammy|22.04*) release=22.04 ;;
      noble|24.04*) release=24.04 ;;
      resolute|26.04*) release=26.04 ;;
    esac
  fi

  if release_supported "$distro" "$release"; then
    echo "$distro-$release-$arch"
    return
  fi

  warn "Unsupported OS detected: ${PRETTY_NAME:-${ID:-unknown}} (${distro:-unknown} ${release:-unknown})"
  print_supported_targets
  if [ "${FRAMEOS_ALLOW_UNSUPPORTED:-}" = "1" ]; then
    override_release="${FRAMEOS_OS_RELEASE_OVERRIDE:-}"
    override_distro="${FRAMEOS_DISTRO_OVERRIDE:-$distro}"
  else
    if [ -z "$TTY" ]; then
      die "No terminal is available for an OS override. Set FRAMEOS_TARGET, or set FRAMEOS_DISTRO_OVERRIDE and FRAMEOS_OS_RELEASE_OVERRIDE."
    fi
    override_distro="$(ask "Use release builds for distro" "${distro:-debian}")"
    override_release="$(ask "Use release build version/codename" "bookworm")"
  fi
  if ! release_supported "$override_distro" "$override_release"; then
    die "Unsupported override: $override_distro $override_release"
  fi
  echo "$override_distro-$override_release-$arch"
}

json_get() {
  file="$1"
  path="$2"
  default="$3"
  if [ ! -f "$file" ]; then
    printf '%s\n' "$default"
    return
  fi
  python3 - "$file" "$path" "$default" <<'PY'
import json
import sys

filename, path, default = sys.argv[1], sys.argv[2], sys.argv[3]
try:
    with open(filename, "r", encoding="utf-8") as fh:
        data = json.load(fh)
except Exception:
    print(default)
    raise SystemExit(0)

node = data
for key in path.split("."):
    if isinstance(node, dict) and key in node:
        node = node[key]
    else:
        print(default)
        raise SystemExit(0)

if node is None:
    print(default)
elif isinstance(node, bool):
    print("true" if node else "false")
elif isinstance(node, (int, float, str)):
    print(node)
else:
    print(default)
PY
}

random_secret() {
  python3 - <<'PY'
import secrets
print(secrets.token_urlsafe(32))
PY
}

detect_timezone() {
  if command -v timedatectl >/dev/null 2>&1; then
    zone="$(timedatectl show -p Timezone --value 2>/dev/null || true)"
    if [ -n "$zone" ]; then
      echo "$zone"
      return
    fi
  fi
  if [ -r /etc/timezone ]; then
    zone="$(sed -n '1p' /etc/timezone 2>/dev/null || true)"
    if [ -n "$zone" ]; then
      echo "$zone"
      return
    fi
  fi
  echo "UTC"
}

device_dimensions() {
  device="$1"
  python3 - "$device" <<'PY'
import sys

device = sys.argv[1]
raw = """
pimoroni.hyperpixel2r:480x480
pimoroni.hyperpixel2r_native:480x480
pimoroni.inky_impression_13:1600x1200
pimoroni.inky_impression_13_2025:1600x1200
pimoroni.inky_impression_4:600x400
pimoroni.inky_impression_4_2025:600x400
pimoroni.inky_impression_4_7_color:640x400
pimoroni.inky_impression_4_spectra6:600x400
pimoroni.inky_impression_5_7:600x448
pimoroni.inky_impression_5_7_color:600x448
pimoroni.inky_impression_7:800x480
pimoroni.inky_impression_7_2025:800x480
pimoroni.inky_impression_7_3:800x480
pimoroni.inky_impression_7_color:800x480
pimoroni.inky_phat_4:250x122
pimoroni.inky_phat_4_color:250x122
pimoroni.inky_phat_black:212x104
pimoroni.inky_phat_jd79661:250x122
pimoroni.inky_phat_red:212x104
pimoroni.inky_phat_red_ht:212x104
pimoroni.inky_phat_ssd1608:250x122
pimoroni.inky_phat_ssd1608_black:250x122
pimoroni.inky_phat_ssd1608_red:250x122
pimoroni.inky_phat_ssd1608_yellow:250x122
pimoroni.inky_phat_yellow:212x104
pimoroni.inky_what_4:400x300
pimoroni.inky_what_4_color:400x300
pimoroni.inky_what_black:400x300
pimoroni.inky_what_jd79668:400x300
pimoroni.inky_what_legacy_yellow:400x300
pimoroni.inky_what_red:400x300
pimoroni.inky_what_red_ht:400x300
pimoroni.inky_what_ssd1683:400x300
pimoroni.inky_what_ssd1683_black:400x300
pimoroni.inky_what_ssd1683_red:400x300
pimoroni.inky_what_ssd1683_yellow:400x300
pimoroni.inky_what_yellow:400x300
waveshare.EPD_10in2b:960x640
waveshare.EPD_10in3:1872x1404
waveshare.EPD_12in48:1304x984
waveshare.EPD_12in48b:1304x984
waveshare.EPD_12in48b_V2:1304x984
waveshare.EPD_13in3b:960x680
waveshare.EPD_13in3e:1200x1600
waveshare.EPD_13in3k:960x680
waveshare.EPD_1in02d:80x128
waveshare.EPD_1in54:200x200
waveshare.EPD_1in54_DES:152x152
waveshare.EPD_1in54_V2:200x200
waveshare.EPD_1in54b:200x200
waveshare.EPD_1in54b_V2:200x200
waveshare.EPD_1in54c:152x152
waveshare.EPD_1in64g:168x168
waveshare.EPD_2in13:122x250
waveshare.EPD_2in13_DES:104x212
waveshare.EPD_2in13_V2:122x250
waveshare.EPD_2in13_V3:122x250
waveshare.EPD_2in13_V4:122x250
waveshare.EPD_2in13b:104x212
waveshare.EPD_2in13b_V3:104x212
waveshare.EPD_2in13b_V4:122x250
waveshare.EPD_2in13bc:104x212
waveshare.EPD_2in13c:104x212
waveshare.EPD_2in13d:104x212
waveshare.EPD_2in13g:122x250
waveshare.EPD_2in13g_V2:122x250
waveshare.EPD_2in15b:160x296
waveshare.EPD_2in15g:160x296
waveshare.EPD_2in36g:168x296
waveshare.EPD_2in66:152x296
waveshare.EPD_2in66b:152x296
waveshare.EPD_2in66g:184x360
waveshare.EPD_2in7:176x264
waveshare.EPD_2in7_V2:176x264
waveshare.EPD_2in7b:176x264
waveshare.EPD_2in7b_V2:176x264
waveshare.EPD_2in9:128x296
waveshare.EPD_2in9_DES:128x296
waveshare.EPD_2in9_V2:128x296
waveshare.EPD_2in9b:128x296
waveshare.EPD_2in9b_V3:128x296
waveshare.EPD_2in9b_V4:128x296
waveshare.EPD_2in9bc:128x296
waveshare.EPD_2in9c:128x296
waveshare.EPD_2in9d:128x296
waveshare.EPD_3in0g:168x400
waveshare.EPD_3in52:240x360
waveshare.EPD_3in52b:240x360
waveshare.EPD_3in7:280x480
waveshare.EPD_4in01f:640x400
waveshare.EPD_4in0e:400x600
waveshare.EPD_4in2:400x300
waveshare.EPD_4in26:800x480
waveshare.EPD_4in2_V2:400x300
waveshare.EPD_4in2b:400x300
waveshare.EPD_4in2b_V2:400x300
waveshare.EPD_4in2b_V2_old:400x300
waveshare.EPD_4in2bc:400x300
waveshare.EPD_4in2c:400x300
waveshare.EPD_4in37b:176x480
waveshare.EPD_4in37g:512x368
waveshare.EPD_5in65f:600x448
waveshare.EPD_5in79:792x272
waveshare.EPD_5in79b:792x272
waveshare.EPD_5in79g:792x272
waveshare.EPD_5in83:600x448
waveshare.EPD_5in83_V2:648x480
waveshare.EPD_5in83b:600x448
waveshare.EPD_5in83b_V2:648x480
waveshare.EPD_5in83bc:600x448
waveshare.EPD_5in83c:600x448
waveshare.EPD_5in84:768x256
waveshare.EPD_7in3e:800x480
waveshare.EPD_7in3f:800x480
waveshare.EPD_7in3g:800x480
waveshare.EPD_7in5:640x384
waveshare.EPD_7in5_HD:880x528
waveshare.EPD_7in5_V2:800x480
waveshare.EPD_7in5_V2_gray:800x480
waveshare.EPD_7in5b:640x384
waveshare.EPD_7in5b_HD:880x528
waveshare.EPD_7in5b_V2:800x480
waveshare.EPD_7in5b_V2_old:800x480
waveshare.EPD_7in5bc:640x384
waveshare.EPD_7in5c:640x384
web_only:800x480
framebuffer:800x480
http.upload:800x480
"""
for line in raw.splitlines():
    if not line or ":" not in line:
        continue
    key, dims = line.split(":", 1)
    if key == device:
        print(dims.replace("x", " "))
        raise SystemExit(0)
raise SystemExit(1)
PY
}

print_pimoroni_devices() {
  cat <<'EOF'
  pimoroni.inky_impression_13
  pimoroni.inky_impression_13_2025
  pimoroni.inky_impression_7_3
  pimoroni.inky_impression_7_color
  pimoroni.inky_impression_7
  pimoroni.inky_impression_7_2025
  pimoroni.inky_impression_5_7
  pimoroni.inky_impression_5_7_color
  pimoroni.inky_impression_4
  pimoroni.inky_impression_4_2025
  pimoroni.inky_impression_4_7_color
  pimoroni.inky_impression_4_spectra6
  pimoroni.inky_phat_black
  pimoroni.inky_phat_red
  pimoroni.inky_phat_yellow
  pimoroni.inky_phat_4
  pimoroni.inky_what_black
  pimoroni.inky_what_red
  pimoroni.inky_what_yellow
  pimoroni.inky_what_4
  pimoroni.hyperpixel2r
  pimoroni.hyperpixel2r_native
EOF
}

print_waveshare_devices() {
  cat <<'EOF'
  waveshare.EPD_1in02d
  waveshare.EPD_1in54
  waveshare.EPD_2in13
  waveshare.EPD_2in13_V3
  waveshare.EPD_2in13_V4
  waveshare.EPD_2in66
  waveshare.EPD_2in7
  waveshare.EPD_2in9
  waveshare.EPD_2in9_V2
  waveshare.EPD_3in7
  waveshare.EPD_4in2
  waveshare.EPD_4in2_V2
  waveshare.EPD_4in26
  waveshare.EPD_5in65f
  waveshare.EPD_5in83
  waveshare.EPD_5in83_V2
  waveshare.EPD_7in3e
  waveshare.EPD_7in3f
  waveshare.EPD_7in3g
  waveshare.EPD_7in5
  waveshare.EPD_7in5_HD
  waveshare.EPD_7in5_V2
  waveshare.EPD_7in5b
  waveshare.EPD_7in5b_V2
  waveshare.EPD_10in3
  waveshare.EPD_12in48
  waveshare.EPD_13in3e
EOF
}

choose_device() {
  default="$1"
  while :; do
    prompt_line ""
    prompt_line "Device choices:"
    prompt_line "  1) web_only (browser/admin preview only)"
    prompt_line "  2) framebuffer (HDMI or Linux framebuffer)"
    prompt_line "  3) http.upload (POST rendered PNG to an HTTP endpoint)"
    prompt_line "  4) pimoroni.inky_impression_7_2025"
    prompt_line "  5) pimoroni.inky_impression_13_2025"
    prompt_line "  6) waveshare.EPD_7in3e"
    prompt_line "  7) waveshare.EPD_13in3e"
    prompt_line "  8) waveshare.EPD_7in5_V2"
    prompt_line "  p) list Pimoroni devices"
    prompt_line "  w) list Waveshare examples"
    prompt_line "  c) custom device key"
    answer="$(ask "Device" "$default")"
    case "$answer" in
      1) echo "web_only"; return ;;
      2) echo "framebuffer"; return ;;
      3) echo "http.upload"; return ;;
      4) echo "pimoroni.inky_impression_7_2025"; return ;;
      5) echo "pimoroni.inky_impression_13_2025"; return ;;
      6) echo "waveshare.EPD_7in3e"; return ;;
      7) echo "waveshare.EPD_13in3e"; return ;;
      8) echo "waveshare.EPD_7in5_V2"; return ;;
      p|P)
        print_pimoroni_devices >&2
        ;;
      w|W)
        print_waveshare_devices >&2
        ;;
      c|C|custom)
        custom="$(ask_required "Custom device key" "$default")"
        echo "$custom"
        return
        ;;
      EPD_*)
        echo "waveshare.$answer"
        return
        ;;
      *)
        if [ -n "$answer" ]; then
          echo "$answer"
          return
        fi
        ;;
    esac
  done
}

copy_scene_payloads() {
  release_dir="$1"
  old_dir="$2"
  mkdir -p "$release_dir"

  if [ -n "$old_dir" ] && [ -f "$old_dir/all_scenes.json.gz" ]; then
    cp "$old_dir/all_scenes.json.gz" "$release_dir/all_scenes.json.gz"
  elif [ -n "$old_dir" ] && [ -f "$old_dir/all_scenes.json" ]; then
    gzip -c "$old_dir/all_scenes.json" > "$release_dir/all_scenes.json.gz"
  else
    printf '[]\n' | gzip -c > "$release_dir/all_scenes.json.gz"
  fi

  if [ -n "$old_dir" ] && [ -f "$old_dir/scenes.json.gz" ]; then
    cp "$old_dir/scenes.json.gz" "$release_dir/scenes.json.gz"
  elif [ -n "$old_dir" ] && [ -f "$old_dir/scenes.json" ]; then
    gzip -c "$old_dir/scenes.json" > "$release_dir/scenes.json.gz"
  else
    printf '[]\n' | gzip -c > "$release_dir/scenes.json.gz"
  fi
}

write_frame_config() {
  existing_config="$1"
  destination="$2"
  FRAMEOS_EXISTING_CONFIG="$existing_config" FRAMEOS_CONFIG_DESTINATION="$destination" python3 - <<'PY'
import json
import os
from pathlib import Path

def env(name, default=""):
    return os.environ.get(name, default)

def env_bool(name):
    return env(name).lower() in {"1", "true", "yes", "y", "on"}

def env_int(name, default):
    try:
        return int(env(name, str(default)))
    except Exception:
        return default

def env_float(name, default):
    try:
        return float(env(name, str(default)))
    except Exception:
        return default

source = Path(env("FRAMEOS_EXISTING_CONFIG"))
if source.is_file():
    try:
        data = json.loads(source.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            data = {}
    except Exception:
        data = {}
else:
    data = {}

device_config = dict(data.get("deviceConfig") or {})
if env("FRAMEOS_DEVICE") == "http.upload":
    device_config["uploadUrl"] = env("FRAMEOS_HTTP_UPLOAD_URL")
else:
    device_config.pop("uploadUrl", None)
if env("FRAMEOS_DEVICE_VCOM"):
    device_config["vcom"] = env_float("FRAMEOS_DEVICE_VCOM", 0)

https_proxy = dict(data.get("httpsProxy") or {})
https_proxy.setdefault("enable", False)
https_proxy.setdefault("port", 8443)
https_proxy.setdefault("exposeOnlyPort", False)

network = dict(data.get("network") or {})
network.update({
    "networkCheck": env_bool("FRAMEOS_NETWORK_CHECK"),
    "networkCheckTimeoutSeconds": env_int("FRAMEOS_NETWORK_CHECK_TIMEOUT_SECONDS", 30),
    "networkCheckUrl": env("FRAMEOS_NETWORK_CHECK_URL", "https://networkcheck.frameos.net/"),
    "wifiHotspot": env("FRAMEOS_WIFI_HOTSPOT", "disabled"),
    "wifiHotspotSsid": env("FRAMEOS_WIFI_HOTSPOT_SSID", "FrameOS-Setup"),
    "wifiHotspotPassword": env("FRAMEOS_WIFI_HOTSPOT_PASSWORD", "frame1234"),
    "wifiHotspotTimeoutSeconds": env_int("FRAMEOS_WIFI_HOTSPOT_TIMEOUT_SECONDS", 300),
})

agent_enabled = env_bool("FRAMEOS_BACKEND_ENABLED")
agent = dict(data.get("agent") or {})
agent.update({
    "agentEnabled": agent_enabled,
    "agentRunCommands": env_bool("FRAMEOS_AGENT_RUN_COMMANDS") if agent_enabled else False,
    "agentSharedSecret": env("FRAMEOS_AGENT_SHARED_SECRET") if agent_enabled else agent.get("agentSharedSecret", ""),
})

frame_admin_auth = dict(data.get("frameAdminAuth") or {})
frame_admin_auth.update({
    "enabled": env_bool("FRAMEOS_ADMIN_AUTH_ENABLED"),
    "user": env("FRAMEOS_ADMIN_USER"),
    "pass": env("FRAMEOS_ADMIN_PASSWORD"),
})

data.update({
    "frameosVersion": env("FRAMEOS_RELEASE_VERSION"),
    "name": env("FRAMEOS_NAME"),
    "mode": "rpios",
    "frameHost": env("FRAMEOS_FRAME_HOST", "localhost"),
    "framePort": env_int("FRAMEOS_FRAME_PORT", 8787),
    "frameAccessKey": env("FRAMEOS_FRAME_ACCESS_KEY"),
    "frameAccess": env("FRAMEOS_FRAME_ACCESS", "private"),
    "httpsProxy": https_proxy,
    "serverHost": env("FRAMEOS_SERVER_HOST"),
    "serverPort": env_int("FRAMEOS_SERVER_PORT", 8989),
    "serverApiKey": env("FRAMEOS_SERVER_API_KEY"),
    "serverSendLogs": env_bool("FRAMEOS_SERVER_SEND_LOGS") if agent_enabled else False,
    "width": env_int("FRAMEOS_WIDTH", 800),
    "height": env_int("FRAMEOS_HEIGHT", 480),
    "device": env("FRAMEOS_DEVICE"),
    "deviceConfig": device_config,
    "interval": env_float("FRAMEOS_INTERVAL", 300),
    "metricsInterval": env_float("FRAMEOS_METRICS_INTERVAL", 60),
    "maxHttpResponseBytes": env_int("FRAMEOS_MAX_HTTP_RESPONSE_BYTES", 67108864),
    "debug": env_bool("FRAMEOS_DEBUG"),
    "scalingMode": env("FRAMEOS_SCALING_MODE", "contain"),
    "imageEngine": env("FRAMEOS_IMAGE_ENGINE", ""),
    "rotate": env_int("FRAMEOS_ROTATE", 0),
    "flip": env("FRAMEOS_FLIP", ""),
    "logToFile": env("FRAMEOS_LOG_TO_FILE"),
    "assetsPath": env("FRAMEOS_ASSETS_PATH", "/srv/assets"),
    "saveAssets": env_bool("FRAMEOS_SAVE_ASSETS"),
    "schedule": data.get("schedule") if isinstance(data.get("schedule"), dict) else {"events": []},
    "gpioButtons": data.get("gpioButtons") if isinstance(data.get("gpioButtons"), list) else [],
    "palette": data.get("palette") if isinstance(data.get("palette"), dict) else {},
    "controlCode": data.get("controlCode") if isinstance(data.get("controlCode"), dict) else {"enabled": False},
    "network": network,
    "agent": agent,
    "mountpoints": data.get("mountpoints") if isinstance(data.get("mountpoints"), dict) else {"enabled": False, "items": []},
    "errorBehavior": data.get("errorBehavior") if isinstance(data.get("errorBehavior"), dict) else {
        "mode": "show_error_retry",
        "retrySeconds": 60,
        "silentRetrySeconds": 60,
        "silentRetryForever": False,
        "silentWindowMinutes": 10,
        "showErrorRetrySeconds": 60,
    },
    "timeZone": env("FRAMEOS_TIME_ZONE"),
    "timeZoneUpdates": data.get("timeZoneUpdates") if isinstance(data.get("timeZoneUpdates"), dict) else {
        "enabled": True,
        "hour": 3,
        "url": "https://tz.frameos.net/tzdata.json.gz",
    },
    "frameAdminAuth": frame_admin_auth,
    "settings": data.get("settings") if isinstance(data.get("settings"), dict) else {},
})

Path(env("FRAMEOS_CONFIG_DESTINATION")).write_text(json.dumps(data, indent=2, sort_keys=True) + "\n", encoding="utf-8")
PY
}

if [ "$(id -u)" -ne 0 ]; then
  die "Run this setup script as root, for example: curl -fsSL https://frameos.net/setup.sh | sudo sh"
fi

need_cmd uname
need_cmd tar
need_cmd find
need_cmd gzip
need_cmd install
need_cmd mktemp
need_cmd systemctl

target="$(detect_os_target)"
if ! command -v python3 >/dev/null 2>&1; then
  install_packages python3
fi
need_cmd python3
install_packages ca-certificates hostapd imagemagick
install_optional_packages caddy
systemctl disable --now caddy.service >/dev/null 2>&1 || true

existing_config=""
existing_release_dir=""
if [ -f "$FRAMEOS_DIR/current/frame.json" ]; then
  existing_config="$FRAMEOS_DIR/current/frame.json"
  existing_release_dir="$(readlink -f "$FRAMEOS_DIR/current" 2>/dev/null || printf '%s' "$FRAMEOS_DIR/current")"
elif [ -f "$FRAMEOS_DIR/frame.json" ]; then
  existing_config="$FRAMEOS_DIR/frame.json"
fi

say "FrameOS standalone setup"
say "Target release: FrameOS $FRAMEOS_RELEASE_VERSION for $target"
if [ -n "$existing_config" ]; then
  say "Using existing defaults from $existing_config"
fi

default_name="$(json_get "$existing_config" name "$(hostname)")"
default_device="$(json_get "$existing_config" device "web_only")"
default_width="$(json_get "$existing_config" width "800")"
default_height="$(json_get "$existing_config" height "480")"
default_frame_port="$(json_get "$existing_config" framePort "8787")"
default_interval="$(json_get "$existing_config" interval "300")"
default_metrics_interval="$(json_get "$existing_config" metricsInterval "60")"
default_rotate="$(json_get "$existing_config" rotate "0")"
default_timezone="$(json_get "$existing_config" timeZone "$(detect_timezone)")"
default_admin_enabled="$(json_get "$existing_config" frameAdminAuth.enabled "true")"
default_admin_user="$(json_get "$existing_config" frameAdminAuth.user "admin")"
existing_admin_password="$(json_get "$existing_config" frameAdminAuth.pass "")"
default_frame_access_key="$(json_get "$existing_config" frameAccessKey "$(random_secret)")"
default_server_host="$(json_get "$existing_config" serverHost "")"
default_server_port="$(json_get "$existing_config" serverPort "8989")"
default_server_api_key="$(json_get "$existing_config" serverApiKey "")"
default_agent_secret="$(json_get "$existing_config" agent.agentSharedSecret "")"
default_agent_enabled="$(json_get "$existing_config" agent.agentEnabled "false")"
default_agent_run_commands="$(json_get "$existing_config" agent.agentRunCommands "true")"
default_server_send_logs="$(json_get "$existing_config" serverSendLogs "true")"
default_network_check="$(json_get "$existing_config" network.networkCheck "true")"
default_wifi_hotspot="$(json_get "$existing_config" network.wifiHotspot "disabled")"
default_wifi_ssid="$(json_get "$existing_config" network.wifiHotspotSsid "FrameOS-Setup")"
default_wifi_password="$(json_get "$existing_config" network.wifiHotspotPassword "frame1234")"
default_log_to_file="$(json_get "$existing_config" logToFile "")"
default_save_assets="$(json_get "$existing_config" saveAssets "true")"

FRAMEOS_NAME="${FRAMEOS_NAME:-$(ask_required "Frame name" "$default_name")}"
FRAMEOS_DEVICE="${FRAMEOS_DEVICE:-$(choose_device "$default_device")}"

dims="$(device_dimensions "$FRAMEOS_DEVICE" 2>/dev/null || true)"
if [ -n "$dims" ]; then
  detected_width="$(printf '%s' "$dims" | awk '{print $1}')"
  detected_height="$(printf '%s' "$dims" | awk '{print $2}')"
else
  detected_width="$default_width"
  detected_height="$default_height"
fi

FRAMEOS_WIDTH="${FRAMEOS_WIDTH:-$(ask_int "Display width" "$detected_width")}"
FRAMEOS_HEIGHT="${FRAMEOS_HEIGHT:-$(ask_int "Display height" "$detected_height")}"
FRAMEOS_ROTATE="${FRAMEOS_ROTATE:-$(ask "Rotation (0, 90, 180, 270)" "$default_rotate")}"
case "$FRAMEOS_ROTATE" in
  0|90|180|270) ;;
  *) die "Unsupported rotation: $FRAMEOS_ROTATE" ;;
esac
FRAMEOS_FRAME_PORT="${FRAMEOS_FRAME_PORT:-$(ask_int "Local admin panel port" "$default_frame_port")}"
FRAMEOS_TIME_ZONE="${FRAMEOS_TIME_ZONE:-$(ask "Timezone" "$default_timezone")}"
FRAMEOS_INTERVAL="${FRAMEOS_INTERVAL:-$default_interval}"
FRAMEOS_METRICS_INTERVAL="${FRAMEOS_METRICS_INTERVAL:-$default_metrics_interval}"
FRAMEOS_ADMIN_AUTH_ENABLED="${FRAMEOS_ADMIN_AUTH_ENABLED:-$(ask_yes_no "Require admin login for the local panel" "$default_admin_enabled")}"
FRAMEOS_ADMIN_USER="${FRAMEOS_ADMIN_USER:-$(ask_required "Admin username" "$default_admin_user")}"

if [ -n "${FRAMEOS_ADMIN_PASSWORD:-}" ]; then
  : # provided through environment
elif [ -n "$existing_admin_password" ]; then
  entered_password="$(ask_secret "Admin password" "keep existing")"
  if [ -n "$entered_password" ]; then
    FRAMEOS_ADMIN_PASSWORD="$entered_password"
  else
    FRAMEOS_ADMIN_PASSWORD="$existing_admin_password"
  fi
else
  entered_password="$(ask_secret "Admin password (blank generates one)" "")"
  if [ -n "$entered_password" ]; then
    confirm_password="$(ask_secret "Confirm admin password" "")"
    if [ "$entered_password" != "$confirm_password" ]; then
      die "Admin passwords did not match."
    fi
    FRAMEOS_ADMIN_PASSWORD="$entered_password"
  else
    FRAMEOS_ADMIN_PASSWORD="$(random_secret)"
    GENERATED_ADMIN_PASSWORD="$FRAMEOS_ADMIN_PASSWORD"
  fi
fi

if [ "$FRAMEOS_DEVICE" = "http.upload" ]; then
  default_upload_url="$(json_get "$existing_config" deviceConfig.uploadUrl "")"
  FRAMEOS_HTTP_UPLOAD_URL="${FRAMEOS_HTTP_UPLOAD_URL:-$(ask_required "HTTP upload URL" "$default_upload_url")}"
else
  FRAMEOS_HTTP_UPLOAD_URL="${FRAMEOS_HTTP_UPLOAD_URL:-}"
fi

case "$FRAMEOS_DEVICE" in
  waveshare.*)
    default_vcom="$(json_get "$existing_config" deviceConfig.vcom "")"
    FRAMEOS_DEVICE_VCOM="${FRAMEOS_DEVICE_VCOM:-$(ask "Waveshare VCOM override, if needed" "$default_vcom")}"
    ;;
  *)
    FRAMEOS_DEVICE_VCOM="${FRAMEOS_DEVICE_VCOM:-}"
    ;;
esac

backend_default="n"
if [ "$default_agent_enabled" = "true" ] || { [ -n "$default_server_host" ] && [ "$default_server_host" != "localhost" ]; }; then
  backend_default="y"
fi
FRAMEOS_BACKEND_ENABLED="${FRAMEOS_BACKEND_ENABLED:-$(ask_yes_no "Connect this frame to a FrameOS backend" "$backend_default")}"

if [ "$FRAMEOS_BACKEND_ENABLED" = "true" ]; then
  FRAMEOS_SERVER_HOST="${FRAMEOS_SERVER_HOST:-$(ask_required "Backend host" "$default_server_host")}"
  FRAMEOS_SERVER_PORT="${FRAMEOS_SERVER_PORT:-$(ask_int "Backend port" "$default_server_port")}"
  FRAMEOS_SERVER_API_KEY="${FRAMEOS_SERVER_API_KEY:-$(ask_required "Backend server API key" "$default_server_api_key")}"
  FRAMEOS_AGENT_SHARED_SECRET="${FRAMEOS_AGENT_SHARED_SECRET:-$(ask_required "FrameOS agent shared secret" "$default_agent_secret")}"
  FRAMEOS_AGENT_RUN_COMMANDS="${FRAMEOS_AGENT_RUN_COMMANDS:-$(ask_yes_no "Allow backend terminal/deploy commands through the agent" "$default_agent_run_commands")}"
  FRAMEOS_SERVER_SEND_LOGS="${FRAMEOS_SERVER_SEND_LOGS:-$(ask_yes_no "Send logs to the backend" "$default_server_send_logs")}"
else
  FRAMEOS_SERVER_HOST="${FRAMEOS_SERVER_HOST:-}"
  FRAMEOS_SERVER_PORT="${FRAMEOS_SERVER_PORT:-8989}"
  FRAMEOS_SERVER_API_KEY="${FRAMEOS_SERVER_API_KEY:-}"
  FRAMEOS_AGENT_SHARED_SECRET="${FRAMEOS_AGENT_SHARED_SECRET:-$default_agent_secret}"
  FRAMEOS_AGENT_RUN_COMMANDS="${FRAMEOS_AGENT_RUN_COMMANDS:-false}"
  FRAMEOS_SERVER_SEND_LOGS="${FRAMEOS_SERVER_SEND_LOGS:-false}"
fi

FRAMEOS_FRAME_HOST="${FRAMEOS_FRAME_HOST:-$(json_get "$existing_config" frameHost "localhost")}"
FRAMEOS_FRAME_ACCESS="${FRAMEOS_FRAME_ACCESS:-$(json_get "$existing_config" frameAccess "private")}"
FRAMEOS_FRAME_ACCESS_KEY="${FRAMEOS_FRAME_ACCESS_KEY:-$default_frame_access_key}"
FRAMEOS_NETWORK_CHECK="${FRAMEOS_NETWORK_CHECK:-$(ask_yes_no "Enable network check before rendering" "$default_network_check")}"
FRAMEOS_NETWORK_CHECK_TIMEOUT_SECONDS="${FRAMEOS_NETWORK_CHECK_TIMEOUT_SECONDS:-30}"
FRAMEOS_NETWORK_CHECK_URL="${FRAMEOS_NETWORK_CHECK_URL:-https://networkcheck.frameos.net/}"
FRAMEOS_WIFI_HOTSPOT="${FRAMEOS_WIFI_HOTSPOT:-$(ask "WiFi setup hotspot mode (disabled/bootOnly)" "$default_wifi_hotspot")}"
case "$FRAMEOS_WIFI_HOTSPOT" in
  disabled|bootOnly) ;;
  *) die "Unsupported WiFi setup hotspot mode: $FRAMEOS_WIFI_HOTSPOT" ;;
esac
if [ "$FRAMEOS_WIFI_HOTSPOT" = "bootOnly" ]; then
  FRAMEOS_WIFI_HOTSPOT_SSID="${FRAMEOS_WIFI_HOTSPOT_SSID:-$(ask "WiFi setup hotspot SSID" "$default_wifi_ssid")}"
  FRAMEOS_WIFI_HOTSPOT_PASSWORD="${FRAMEOS_WIFI_HOTSPOT_PASSWORD:-$(ask "WiFi setup hotspot password" "$default_wifi_password")}"
else
  FRAMEOS_WIFI_HOTSPOT_SSID="${FRAMEOS_WIFI_HOTSPOT_SSID:-$default_wifi_ssid}"
  FRAMEOS_WIFI_HOTSPOT_PASSWORD="${FRAMEOS_WIFI_HOTSPOT_PASSWORD:-$default_wifi_password}"
fi
FRAMEOS_WIFI_HOTSPOT_TIMEOUT_SECONDS="${FRAMEOS_WIFI_HOTSPOT_TIMEOUT_SECONDS:-300}"
FRAMEOS_LOG_TO_FILE="${FRAMEOS_LOG_TO_FILE:-$default_log_to_file}"
FRAMEOS_ASSETS_PATH="${FRAMEOS_ASSETS_PATH:-$FRAMEOS_ASSETS_DIR}"
FRAMEOS_SAVE_ASSETS="${FRAMEOS_SAVE_ASSETS:-$default_save_assets}"
FRAMEOS_MAX_HTTP_RESPONSE_BYTES="${FRAMEOS_MAX_HTTP_RESPONSE_BYTES:-67108864}"
FRAMEOS_DEBUG="${FRAMEOS_DEBUG:-false}"
FRAMEOS_SCALING_MODE="${FRAMEOS_SCALING_MODE:-$(json_get "$existing_config" scalingMode "contain")}"
FRAMEOS_IMAGE_ENGINE="${FRAMEOS_IMAGE_ENGINE:-$(json_get "$existing_config" imageEngine "")}"
FRAMEOS_FLIP="${FRAMEOS_FLIP:-$(json_get "$existing_config" flip "")}"

export FRAMEOS_RELEASE_VERSION
export FRAMEOS_NAME FRAMEOS_DEVICE FRAMEOS_WIDTH FRAMEOS_HEIGHT FRAMEOS_ROTATE
export FRAMEOS_FRAME_HOST FRAMEOS_FRAME_PORT FRAMEOS_FRAME_ACCESS FRAMEOS_FRAME_ACCESS_KEY
export FRAMEOS_SERVER_HOST FRAMEOS_SERVER_PORT FRAMEOS_SERVER_API_KEY FRAMEOS_SERVER_SEND_LOGS
export FRAMEOS_BACKEND_ENABLED FRAMEOS_AGENT_SHARED_SECRET FRAMEOS_AGENT_RUN_COMMANDS
export FRAMEOS_ADMIN_AUTH_ENABLED FRAMEOS_ADMIN_USER FRAMEOS_ADMIN_PASSWORD
export FRAMEOS_HTTP_UPLOAD_URL FRAMEOS_DEVICE_VCOM
export FRAMEOS_NETWORK_CHECK FRAMEOS_NETWORK_CHECK_TIMEOUT_SECONDS FRAMEOS_NETWORK_CHECK_URL
export FRAMEOS_WIFI_HOTSPOT FRAMEOS_WIFI_HOTSPOT_SSID FRAMEOS_WIFI_HOTSPOT_PASSWORD FRAMEOS_WIFI_HOTSPOT_TIMEOUT_SECONDS
export FRAMEOS_LOG_TO_FILE FRAMEOS_ASSETS_PATH FRAMEOS_SAVE_ASSETS
export FRAMEOS_MAX_HTTP_RESPONSE_BYTES FRAMEOS_DEBUG FRAMEOS_SCALING_MODE FRAMEOS_IMAGE_ENGINE FRAMEOS_FLIP
export FRAMEOS_INTERVAL FRAMEOS_METRICS_INTERVAL FRAMEOS_TIME_ZONE

say ""
say "Installing FrameOS..."
base_url="${FRAMEOS_RELEASE_BASE_URL%/}"
archive_url="$base_url/v$FRAMEOS_RELEASE_VERSION/frameos-$FRAMEOS_RELEASE_VERSION-$target.tar.gz"
work_dir="$(mktemp -d)"
release_name="release_setup_$(date +%Y%m%d%H%M%S)"
frameos_release_dir="$FRAMEOS_DIR/releases/$release_name"
agent_release_dir="$FRAMEOS_AGENT_DIR/releases/$release_name"
trap 'rm -rf "$work_dir"' EXIT

download_file "$archive_url" "$work_dir/frameos.tar.gz"
mkdir -p "$work_dir/extract" "$frameos_release_dir" "$agent_release_dir" "$FRAMEOS_AGENT_DIR/logs" "$FRAMEOS_DIR/logs" "$FRAMEOS_DIR/state" "$FRAMEOS_ASSETS_PATH"
tar -xzf "$work_dir/frameos.tar.gz" -C "$work_dir/extract"

frameos_binary="$(find "$work_dir/extract" -type f -name frameos | head -n 1)"
agent_binary="$(find "$work_dir/extract" -type f -name frameos_agent | head -n 1)"
if [ -z "$frameos_binary" ]; then
  die "The precompiled FrameOS release did not contain a frameos binary for $target."
fi
if [ -z "$agent_binary" ]; then
  die "The precompiled FrameOS release did not contain a frameos_agent binary for $target."
fi
artifact_root="${frameos_binary%/*}"

install -m 0755 "$frameos_binary" "$frameos_release_dir/frameos"
install -m 0755 "$agent_binary" "$agent_release_dir/frameos_agent"

if [ -d "$artifact_root/drivers" ]; then
  cp -R "$artifact_root/drivers" "$frameos_release_dir/drivers"
fi
if [ -d "$artifact_root/scenes" ]; then
  cp -R "$artifact_root/scenes" "$frameos_release_dir/scenes"
fi
if [ -d "$artifact_root/vendor" ]; then
  mkdir -p "$FRAMEOS_DIR/vendor"
  cp -R "$artifact_root/vendor/." "$FRAMEOS_DIR/vendor/"
fi

write_frame_config "$existing_config" "$frameos_release_dir/frame.json"
cp "$frameos_release_dir/frame.json" "$agent_release_dir/frame.json"
copy_scene_payloads "$frameos_release_dir" "$existing_release_dir"

agent_user="${SUDO_USER:-}"
if [ -z "$agent_user" ] || [ "$agent_user" = "root" ]; then
  if id pi >/dev/null 2>&1; then
    agent_user=pi
  else
    agent_user="$(id -un)"
  fi
fi
if ! id "$agent_user" >/dev/null 2>&1; then
  agent_user=root
fi

cat > "$frameos_release_dir/frameos.service" <<EOF
[Unit]
Description=FrameOS Service
After=network.target

[Service]
User=$agent_user
WorkingDirectory=$FRAMEOS_DIR/current
ExecStart=$FRAMEOS_DIR/current/frameos
Restart=always

[Install]
WantedBy=multi-user.target
EOF

cat > "$agent_release_dir/frameos_agent.service" <<EOF
[Unit]
Description=FrameOS Agent (auto-reconnect, hardened)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$agent_user
WorkingDirectory=$FRAMEOS_AGENT_DIR/current
ExecStart=$FRAMEOS_AGENT_DIR/current/frameos_agent
Restart=always
RestartSec=5
LimitNOFILE=65536
PrivateTmp=yes
ProtectSystem=full
ReadWritePaths=/etc/systemd/system /etc/cron.d /boot

[Install]
WantedBy=multi-user.target
EOF

rm -rf "$FRAMEOS_DIR/current" "$FRAMEOS_AGENT_DIR/current"
ln -s "$frameos_release_dir" "$FRAMEOS_DIR/current"
ln -s "$agent_release_dir" "$FRAMEOS_AGENT_DIR/current"
chown -R "$agent_user" "$FRAMEOS_DIR" "$FRAMEOS_ASSETS_PATH"

set +e
cd "$frameos_release_dir" && ./frameos setup
setup_status=$?
set -e

if [ "$setup_status" -ne 0 ] && [ "$setup_status" -ne 2 ]; then
  die "FrameOS setup failed with exit code $setup_status."
fi

install -d -m 0755 /etc/systemd/system
install -m 0644 "$frameos_release_dir/frameos.service" /etc/systemd/system/frameos.service
if [ "$FRAMEOS_BACKEND_ENABLED" = "true" ]; then
  install -m 0644 "$agent_release_dir/frameos_agent.service" /etc/systemd/system/frameos_agent.service
else
  systemctl disable --now frameos_agent.service >/dev/null 2>&1 || true
fi
systemctl daemon-reload
systemctl enable frameos.service >/dev/null
if [ "$FRAMEOS_BACKEND_ENABLED" = "true" ]; then
  systemctl enable frameos_agent.service >/dev/null
fi

if [ "$setup_status" -eq 2 ]; then
  say ""
  say "FrameOS is installed, but hardware setup requested a reboot before the service starts."
  say "Reboot this device, then open the local admin panel at http://<frame-ip>:$FRAMEOS_FRAME_PORT/"
else
  if [ "$FRAMEOS_BACKEND_ENABLED" = "true" ]; then
    systemctl restart frameos_agent.service
  fi
  systemctl restart frameos.service
  say ""
  say "FrameOS is installed and started."
  say "Open the local admin panel at http://<frame-ip>:$FRAMEOS_FRAME_PORT/"
fi

say ""
say "Summary:"
say "  Release: $FRAMEOS_RELEASE_VERSION ($target)"
say "  Config: $frameos_release_dir/frame.json"
say "  Current release: $FRAMEOS_DIR/current"
say "  Device: $FRAMEOS_DEVICE ($FRAMEOS_WIDTH x $FRAMEOS_HEIGHT, rotate $FRAMEOS_ROTATE)"
say "  Admin user: $FRAMEOS_ADMIN_USER"
if [ -n "$GENERATED_ADMIN_PASSWORD" ]; then
  say "  Generated admin password: $GENERATED_ADMIN_PASSWORD"
fi
if [ "$FRAMEOS_BACKEND_ENABLED" = "true" ]; then
  say "  Backend: $FRAMEOS_SERVER_HOST:$FRAMEOS_SERVER_PORT"
else
  say "  Backend: not configured; FrameOS will run standalone."
fi
say ""
say "You should see FrameOS render soon. If the display stays blank or distorted, run this setup again and try a different device driver."
say "Logs:"
say "  journalctl -u frameos -f"
if [ "$FRAMEOS_BACKEND_ENABLED" = "true" ]; then
  say "  journalctl -u frameos_agent -f"
fi
