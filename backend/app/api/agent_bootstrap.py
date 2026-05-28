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
from app.database import get_db
from app.models.frame import Frame, get_frame_json, update_frame
from app.redis import get_redis
from app.schemas.frames import FrameAgentBootstrapResponse
from app.tasks.precompiled_frameos import RELEASE_BASE_URL, release_version
from app.utils.token import secure_token

from . import api_public, api_with_auth


def _not_found() -> None:
    raise HTTPException(status_code=HTTPStatus.NOT_FOUND, detail="Frame not found")


def _bad_request(message: str) -> None:
    raise HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail=message)


def _agent_bootstrap_token(frame: Frame) -> str:
    agent = frame.agent if isinstance(frame.agent, dict) else {}
    agent_secret = str(agent.get("agentSharedSecret") or "")
    server_api_key = str(frame.server_api_key or "")
    payload = f"{frame.id}:{server_api_key}:{agent_secret}"
    return hmac.new(
        str(config.SECRET_KEY).encode("utf-8"),
        payload.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()


def _agent_bootstrap_token_valid(frame: Frame, token: str) -> bool:
    return secrets.compare_digest(_agent_bootstrap_token(frame), token)


async def _ensure_agent_bootstrap_enabled(db: Session, redis: Redis, frame: Frame, *, select_agent: bool = True) -> None:
    changed = False
    agent = dict(frame.agent or {}) if isinstance(frame.agent, dict) else {}

    if not frame.server_api_key:
        frame.server_api_key = secure_token(32)
        changed = True

    if not agent.get("agentSharedSecret"):
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


def _agent_bootstrap_script_url(request: Request, frame: Frame) -> str:
    token = _agent_bootstrap_token(frame)
    base_url = _frame_server_base_url(frame) or _external_request_base_url(request)
    return f"{base_url}/api/agent-bootstrap/{frame.id}/{token}"


def _agent_bootstrap_config_json(db: Session, frame: Frame) -> str:
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


def _agent_bootstrap_script(db: Session, frame: Frame) -> str:
    version = release_version()
    if not version:
        raise HTTPException(
            status_code=HTTPStatus.INTERNAL_SERVER_ERROR,
            detail="FrameOS release version unavailable",
        )

    config_json = _agent_bootstrap_config_json(db, frame)
    return f"""#!/bin/sh
set -eu

FRAMEOS_RELEASE_VERSION={shlex.quote(version)}
FRAMEOS_RELEASE_BASE_URL={shlex.quote(RELEASE_BASE_URL)}
FRAMEOS_AGENT_DIR=/srv/frameos/agent

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

need_cmd tar
need_cmd find
need_cmd systemctl

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
release_dir="$FRAMEOS_AGENT_DIR/releases/release_bootstrap_$(date +%Y%m%d%H%M%S)"
trap 'rm -rf "$work_dir"' EXIT

echo "Downloading precompiled FrameOS agent for $target"
download_file "$archive_url" "$work_dir/frameos.tar.gz"
mkdir -p "$work_dir/extract" "$release_dir" "$FRAMEOS_AGENT_DIR/logs"
tar -xzf "$work_dir/frameos.tar.gz" -C "$work_dir/extract"

agent_binary="$(find "$work_dir/extract" -type f -name frameos_agent | head -n 1)"
if [ -z "$agent_binary" ]; then
  echo "The precompiled FrameOS release did not contain frameos_agent for $target" >&2
  exit 1
fi

install -m 0755 "$agent_binary" "$release_dir/frameos_agent"
cat > "$release_dir/frame.json" <<'FRAMEOS_AGENT_CONFIG_JSON'
{config_json}FRAMEOS_AGENT_CONFIG_JSON

cat > "$release_dir/frameos_agent.service" <<EOF
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

ln -sfn "$release_dir" "$FRAMEOS_AGENT_DIR/current"
cp "$release_dir/frameos_agent.service" /etc/systemd/system/frameos_agent.service
chmod 0644 /etc/systemd/system/frameos_agent.service
chown -R "$agent_user" "$FRAMEOS_AGENT_DIR"
systemctl daemon-reload
systemctl enable frameos_agent.service
systemctl restart frameos_agent.service

echo "FrameOS agent installed and started"
"""


@api_with_auth.post("/frames/{id:int}/agent_bootstrap", response_model=FrameAgentBootstrapResponse)
async def api_frame_agent_bootstrap_command(
    id: int,
    request: Request,
    select_agent: bool = True,
    db: Session = Depends(get_db),
    redis: Redis = Depends(get_redis),
):
    frame = db.get(Frame, id)
    if not frame:
        _not_found()
    if (frame.mode or "rpios") != "rpios":
        _bad_request("Agent bootstrap is only supported for Raspberry Pi OS frames")

    await _ensure_agent_bootstrap_enabled(db, redis, frame, select_agent=select_agent)
    script_url = _agent_bootstrap_script_url(request, frame)
    return {
        "script_url": script_url,
        "command": f"curl -fsSL {shlex.quote(script_url)} | sudo sh",
    }


@api_public.get("/agent-bootstrap/{frame_id:int}/{token}")
async def api_frame_agent_bootstrap_script(
    frame_id: int,
    token: str,
    db: Session = Depends(get_db),
):
    frame = db.get(Frame, frame_id)
    if not frame or not _agent_bootstrap_token_valid(frame, token):
        _not_found()
    if (frame.mode or "rpios") != "rpios":
        _bad_request("Agent bootstrap is only supported for Raspberry Pi OS frames")

    script = _agent_bootstrap_script(db, frame)
    return Response(script, media_type="text/x-shellscript")
