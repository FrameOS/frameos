from __future__ import annotations

import hashlib
import hmac
import json
import secrets
import shlex
from http import HTTPStatus
from urllib.parse import urlparse

from arq import ArqRedis as Redis
from fastapi import Depends, HTTPException, Request
from fastapi.responses import Response
from sqlalchemy.orm import Session

from app.config import config, normalize_ingress_path
from app.api.project_scope import project_get_or_404
from app.database import get_db
from app.models.frame import Frame, get_frame_json, get_interpreted_scenes_json, update_frame
from app.redis import get_redis
from app.schemas.frames import FrameBootstrapResponse
from app.tasks.precompiled_frameos import RELEASE_BASE_URL, frame_compiled_scene_count, release_version
from app.utils.token import secure_token

from . import api_project, api_public


def _not_found() -> None:
    raise HTTPException(status_code=HTTPStatus.NOT_FOUND, detail="Frame not found")


def _bad_request(message: str) -> None:
    raise HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail=message)


def _frame_bootstrap_token(frame: Frame) -> str:
    agent = frame.agent if isinstance(frame.agent, dict) else {}
    agent_secret = str(agent.get("agentSharedSecret") or "")
    server_api_key = str(frame.server_api_key or "")
    payload = f"{frame.id}:{server_api_key}:{agent_secret}"
    return hmac.new(
        str(config.SECRET_KEY).encode("utf-8"),
        payload.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()


def _frame_bootstrap_token_valid(frame: Frame, token: str) -> bool:
    return secrets.compare_digest(_frame_bootstrap_token(frame), token)


async def _ensure_frame_bootstrap_enabled(
    db: Session,
    redis: Redis,
    frame: Frame,
    *,
    select_agent: bool = True,
    regenerate: bool = False,
) -> None:
    changed = False
    agent = dict(frame.agent or {}) if isinstance(frame.agent, dict) else {}

    if not frame.server_api_key:
        frame.server_api_key = secure_token(32)
        changed = True

    if regenerate or not agent.get("agentSharedSecret"):
        agent["agentSharedSecret"] = secure_token(32)
        changed = True

    for key in ("agentEnabled", "agentRunCommands"):
        if agent.get(key) is not True:
            agent[key] = True
            changed = True

    if select_agent and agent.get("deployWithAgent") is not True:
        agent["deployWithAgent"] = True
        changed = True

    if changed:
        frame.agent = agent
        await update_frame(db, redis, frame)


def _first_header_value(value: str | None) -> str | None:
    if not value:
        return None
    first = value.split(",", 1)[0].strip()
    return first or None


def _external_request_base_url(request: Request) -> str:
    scheme = _first_header_value(request.headers.get("x-forwarded-proto")) or request.url.scheme
    host = (
        _first_header_value(request.headers.get("x-forwarded-host"))
        or _first_header_value(request.headers.get("host"))
        or request.url.netloc
    )
    prefix = (
        normalize_ingress_path(request.headers.get("x-ingress-path"))
        or normalize_ingress_path(request.scope.get("root_path"))
        or normalize_ingress_path(config.ingress_path)
    )
    return f"{scheme}://{host}{prefix}"


def _frame_server_base_url(frame: Frame) -> str | None:
    server_host = str(frame.server_host or "").strip().rstrip("/")
    if not server_host:
        return None

    parsed = urlparse(server_host if "://" in server_host else f"//{server_host}")
    scheme = parsed.scheme or "http"
    host = parsed.netloc or parsed.path
    path = parsed.path if parsed.netloc else ""
    if not host:
        return None

    has_port = ":" in host.rsplit("@", 1)[-1]
    port = int(frame.server_port or 0)
    if port and not has_port and not (scheme == "http" and port == 80) and not (scheme == "https" and port == 443):
        host = f"{host}:{port}"

    return f"{scheme}://{host}{path.rstrip('/')}"


def _frame_bootstrap_script_url(request: Request, frame: Frame) -> str:
    token = _frame_bootstrap_token(frame)
    base_url = _frame_server_base_url(frame) or _external_request_base_url(request)
    return f"{base_url}/api/projects/{frame.project_id}/frame-bootstrap/{frame.id}/{token}"


def _frame_bootstrap_config_json(db: Session, frame: Frame) -> str:
    payload = get_frame_json(db, frame)
    agent = dict(payload.get("agent") or {})
    frame_agent = frame.agent if isinstance(frame.agent, dict) else {}
    payload["agent"] = {
        **agent,
        "agentEnabled": True,
        "agentRunCommands": True,
        "agentSharedSecret": str(frame_agent.get("agentSharedSecret") or ""),
    }
    return json.dumps(payload, indent=2) + "\n"


def _frame_bootstrap_scenes_json(frame: Frame) -> str:
    scenes = get_interpreted_scenes_json(frame) if frame.scenes else []
    return json.dumps(scenes, indent=2) + "\n"


def _frame_bootstrap_all_scenes_json(frame: Frame) -> str:
    return json.dumps(list(frame.scenes or []), indent=2) + "\n"


def _frame_bootstrap_script(db: Session, frame: Frame) -> str:
    version = release_version()
    if not version:
        raise HTTPException(
            status_code=HTTPStatus.INTERNAL_SERVER_ERROR,
            detail="FrameOS release version unavailable",
        )

    config_json = _frame_bootstrap_config_json(db, frame)
    scenes_json = _frame_bootstrap_scenes_json(frame)
    all_scenes_json = _frame_bootstrap_all_scenes_json(frame)
    compiled_scene_count = frame_compiled_scene_count(frame)
    return f"""#!/bin/sh
set -eu

FRAMEOS_RELEASE_VERSION={shlex.quote(version)}
FRAMEOS_RELEASE_BASE_URL={shlex.quote(RELEASE_BASE_URL)}
FRAMEOS_DIR=/srv/frameos
FRAMEOS_AGENT_DIR=/srv/frameos/agent
FRAMEOS_COMPILED_SCENE_COUNT={compiled_scene_count}

need_cmd() {{
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}}

download_file() {{
  url="$1"
  destination="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$url" -o "$destination"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$destination" "$url"
  else
    echo "Missing required command: curl or wget" >&2
    exit 1
  fi
}}

detect_arch() {{
  case "$(uname -m)" in
    aarch64|arm64|armv8) echo arm64 ;;
    armv8l|armv7l|armv6l|armhf) echo armhf ;;
    x86_64|amd64) echo amd64 ;;
    *) echo "Unsupported CPU architecture: $(uname -m)" >&2; exit 1 ;;
  esac
}}

detect_target() {{
  if [ -r /etc/os-release ]; then
    . /etc/os-release
  else
    echo "Cannot read /etc/os-release" >&2
    exit 1
  fi

  distro="${{ID:-}}"
  release="${{VERSION_CODENAME:-}}"
  if [ -z "$release" ]; then
    release="${{UBUNTU_CODENAME:-}}"
  fi

  case "$distro" in
    raspbian|raspios) distro=debian ;;
    debian|ubuntu) ;;
    *)
      case "${{ID_LIKE:-}}" in
        *debian*) distro=debian ;;
        *) echo "Unsupported Linux distribution: ${{ID:-unknown}}" >&2; exit 1 ;;
      esac
      ;;
  esac

  if [ "$distro" = "ubuntu" ]; then
    case "${{VERSION_ID:-$release}}" in
      22.04*|jammy*) release=22.04 ;;
      24.04*|noble*) release=24.04 ;;
      26.04*|resolute*) release=26.04 ;;
    esac
  fi

  case "$release" in
    buster|bullseye|bookworm|trixie|22.04|24.04|26.04) ;;
    *) echo "Unsupported OS release: ${{release:-unknown}}" >&2; exit 1 ;;
  esac

  echo "$distro-$release-$(detect_arch)"
}}

install_packages() {{
  if ! command -v apt-get >/dev/null 2>&1; then
    echo "apt-get not found; skipping package install: $*" >&2
    return 0
  fi

  missing=""
  for package in "$@"; do
    if dpkg-query -W -f='${{Status}}' "$package" 2>/dev/null | grep -q '^install ok installed$'; then
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
}}

install_optional_packages() {{
  if ! command -v apt-get >/dev/null 2>&1; then
    return 0
  fi
  if ! install_packages "$@"; then
    echo "Optional package install failed: $*" >&2
  fi
}}

need_cmd tar
need_cmd find
need_cmd systemctl
need_cmd install
need_cmd gzip

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this bootstrap script as root, for example: curl -fsSL <url> | sudo sh" >&2
  exit 1
fi

agent_user="${{SUDO_USER:-}}"
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

target="$(detect_target)"
base_url="${{FRAMEOS_RELEASE_BASE_URL%/}}"
archive_url="$base_url/v$FRAMEOS_RELEASE_VERSION/frameos-$FRAMEOS_RELEASE_VERSION-$target.tar.gz"
work_dir="$(mktemp -d)"
release_name="release_bootstrap_$(date +%Y%m%d%H%M%S)"
frameos_release_dir="$FRAMEOS_DIR/releases/$release_name"
agent_release_dir="$FRAMEOS_AGENT_DIR/releases/$release_name"
trap 'rm -rf "$work_dir"' EXIT

echo "Downloading precompiled FrameOS release for $target"
download_file "$archive_url" "$work_dir/frameos.tar.gz"
mkdir -p "$work_dir/extract" "$frameos_release_dir" "$agent_release_dir" "$FRAMEOS_AGENT_DIR/logs" "$FRAMEOS_DIR/logs" "$FRAMEOS_DIR/state"
tar -xzf "$work_dir/frameos.tar.gz" -C "$work_dir/extract"

frameos_binary="$(find "$work_dir/extract" -type f -name frameos | head -n 1)"
agent_binary="$(find "$work_dir/extract" -type f -name frameos_agent | head -n 1)"
if [ -z "$frameos_binary" ]; then
  echo "The precompiled FrameOS release did not contain frameos for $target" >&2
  exit 1
fi
if [ -z "$agent_binary" ]; then
  echo "The precompiled FrameOS release did not contain frameos_agent for $target" >&2
  exit 1
fi

artifact_root="${{frameos_binary%/*}}"

install_packages hostapd imagemagick
install_optional_packages caddy
systemctl disable --now caddy.service >/dev/null 2>&1 || true

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

cat > "$frameos_release_dir/frame.json" <<'FRAMEOS_CONFIG_JSON'
{config_json}FRAMEOS_CONFIG_JSON
cp "$frameos_release_dir/frame.json" "$agent_release_dir/frame.json"

cat > "$work_dir/scenes.json" <<'FRAMEOS_SCENES_JSON'
{scenes_json}FRAMEOS_SCENES_JSON
gzip -c "$work_dir/scenes.json" > "$frameos_release_dir/scenes.json.gz"

cat > "$work_dir/all_scenes.json" <<'FRAMEOS_ALL_SCENES_JSON'
{all_scenes_json}FRAMEOS_ALL_SCENES_JSON
gzip -c "$work_dir/all_scenes.json" > "$frameos_release_dir/all_scenes.json.gz"

# Memory caps for frameos.service: everything except a small OS reserve, so a
# leak OOM-kills frameos instead of swap-thrashing the device. Computed from
# MemTotal because percentages cannot express a fixed reserve on 128MB..8GB.
mem_total_kb=$(awk '/^MemTotal:/ {{print $2}}' /proc/meminfo)
mem_reserve_kb=$((mem_total_kb / 8))
if [ "$mem_reserve_kb" -lt 40960 ]; then mem_reserve_kb=40960; fi
if [ "$mem_reserve_kb" -gt 262144 ]; then mem_reserve_kb=262144; fi
mem_max_kb=$((mem_total_kb - mem_reserve_kb))
if [ "$mem_max_kb" -lt 32768 ]; then mem_max_kb=32768; fi
mem_high_margin_kb=$((mem_max_kb / 16))
if [ "$mem_high_margin_kb" -lt 16384 ]; then mem_high_margin_kb=16384; fi
mem_high_kb=$((mem_max_kb - mem_high_margin_kb))

cat > "$frameos_release_dir/frameos.service" <<EOF
[Unit]
Description=FrameOS Service
After=network.target

[Service]
User=$agent_user
WorkingDirectory=$FRAMEOS_DIR/current
ExecStart=$FRAMEOS_DIR/current/frameos
Restart=always
Type=notify
TimeoutStartSec=300
# Restart if the runner loop stops sending WATCHDOG=1 heartbeats. 15 minutes
# tolerates the slowest legitimate renders (chromium retries, e-ink refresh).
WatchdogSec=900
# If FrameOS leaks memory, OOM-kill and restart it instead of letting the
# device swap itself into an unreachable state.
MemoryHigh=${{mem_high_kb}}K
MemoryMax=${{mem_max_kb}}K
MemorySwapMax=64M

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
chown -R "$agent_user" "$FRAMEOS_DIR"

if [ "$FRAMEOS_COMPILED_SCENE_COUNT" -gt 0 ]; then
  echo "This script installed the precompiled FrameOS runtime. $FRAMEOS_COMPILED_SCENE_COUNT compiled scene(s) still require a full deploy after the agent connects."
fi

set +e
cd "$frameos_release_dir" && ./frameos setup
setup_status=$?
set -e

if [ "$setup_status" -ne 0 ] && [ "$setup_status" -ne 2 ]; then
  echo "FrameOS setup failed with exit code $setup_status" >&2
  exit "$setup_status"
fi

install -d -m 0755 /etc/systemd/system
install -m 0644 "$frameos_release_dir/frameos.service" /etc/systemd/system/frameos.service
install -m 0644 "$agent_release_dir/frameos_agent.service" /etc/systemd/system/frameos_agent.service
systemctl daemon-reload
systemctl enable frameos.service frameos_agent.service
if [ "$setup_status" -eq 2 ]; then
  systemctl restart frameos_agent.service
  echo "FrameOS and the FrameOS agent are installed. Reboot this device to finish hardware setup."
  exit 0
fi

systemctl restart frameos_agent.service
systemctl restart frameos.service

echo "FrameOS and the FrameOS agent are installed and started"
"""


@api_project.post("/frames/{id:int}/frame_bootstrap", response_model=FrameBootstrapResponse)
async def api_frame_bootstrap_command(
    id: int,
    request: Request,
    select_agent: bool = True,
    regenerate: bool = False,
    db: Session = Depends(get_db),
    redis: Redis = Depends(get_redis),
):
    frame = project_get_or_404(db, Frame, id, detail="Frame not found")
    if (frame.mode or "rpios") != "rpios":
        _bad_request("FrameOS bootstrap is only supported for Raspberry Pi OS frames")

    await _ensure_frame_bootstrap_enabled(db, redis, frame, select_agent=select_agent, regenerate=regenerate)
    script_url = _frame_bootstrap_script_url(request, frame)
    return {
        "script_url": script_url,
        "command": f"curl -fsSL {shlex.quote(script_url)} | sudo sh",
    }


@api_public.get("/projects/{project_id}/frame-bootstrap/{frame_id:int}/{token}")
async def api_frame_bootstrap_script(
    project_id: int,
    frame_id: int,
    token: str,
    db: Session = Depends(get_db),
):
    frame = db.query(Frame).filter_by(project_id=project_id, id=frame_id).first()
    if not frame or not _frame_bootstrap_token_valid(frame, token):
        _not_found()
    if (frame.mode or "rpios") != "rpios":
        _bad_request("FrameOS bootstrap is only supported for Raspberry Pi OS frames")

    script = _frame_bootstrap_script(db, frame)
    return Response(script, media_type="text/x-shellscript")
