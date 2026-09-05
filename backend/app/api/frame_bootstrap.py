from __future__ import annotations

import hashlib
import hmac
import json
import secrets
import shlex
from http import HTTPStatus
from urllib.parse import urlparse

from arq import ArqRedis as Redis
from fastapi import Depends, HTTPException, Query, Request
from fastapi.responses import Response
from sqlalchemy.orm import Session

from app.config import config, normalize_ingress_path
from app.api.project_scope import project_get_or_404
from app.database import get_db
from app.models.frame import Frame, get_frame_json, get_interpreted_scenes_json, update_frame
from app.redis import get_redis
from app.schemas.frames import FrameBootstrapResponse
from app.tasks.deploy_remote import legacy_remote_cleanup_script
from app.utils.release_signing import release_signing_public_key_spki_base64
from app.tasks.precompiled_frameos import RELEASE_BASE_URL, frame_compiled_scene_count, release_version
from app.utils.release_targets import release_distro_summary, release_versions
from app.utils.token import secure_token

from . import api_project, api_public


def _not_found() -> None:
    raise HTTPException(status_code=HTTPStatus.NOT_FOUND, detail="Frame not found")


def _bad_request(message: str) -> None:
    raise HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail=message)


def _frame_bootstrap_token(frame: Frame) -> str:
    agent = frame.agent if isinstance(frame.agent, dict) else {}
    remote_secret = str(agent.get("agentSharedSecret") or "")
    server_api_key = str(frame.server_api_key or "")
    payload = f"{frame.id}:{server_api_key}:{remote_secret}"
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
    select_remote: bool = True,
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

    if select_remote and agent.get("deployWithAgent") is not True:
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
    frame_remote = frame.agent if isinstance(frame.agent, dict) else {}
    payload["agent"] = {
        **agent,
        "agentEnabled": True,
        "agentRunCommands": True,
        "agentSharedSecret": str(frame_remote.get("agentSharedSecret") or ""),
    }
    return json.dumps(payload, indent=2) + "\n"


def _frame_bootstrap_scenes_json(frame: Frame) -> str:
    scenes = get_interpreted_scenes_json(frame) if frame.scenes else []
    return json.dumps(scenes, indent=2) + "\n"


def _frame_bootstrap_all_scenes_json(frame: Frame) -> str:
    return json.dumps(list(frame.scenes or []), indent=2) + "\n"


# The shell half of release verification, embedded verbatim into the bootstrap
# script (and exercised on its own by test_frame_bootstrap_verify.py with a key
# minted for the test). Reads FRAMEOS_RELEASE_SIGNING_KEY_SPKI and work_dir
# from the script's environment.
VERIFY_RELEASE_SIGNATURE_SH = r"""# The release archive is signed (minisign, prehashed Ed25519 over the
# BLAKE2b-512 of the file) with the FrameOS release key baked into every
# device runtime; this is the same check frameos performs on its own OTA
# (frameos/src/frameos/upgrade.nim verifyReleaseArchiveSignature), done with
# openssl because nothing FrameOS-built is trusted before it passes. A
# transport-level compromise (a plain-http backend, a hostile mirror behind
# FRAMEOS_RELEASE_BASE_URL) can then at most refuse the install, never run
# other bytes as root.
verify_release_signature() {
  archive="$1"
  minisig="$2"
  sig_dir="$work_dir/sig"
  mkdir -p "$sig_dir"
  # First non-comment line: base64(ED || keyid8 || sig64).
  # `|| true`: under `set -e` a pipeline that finds nothing would end the
  # script before the message below names the problem.
  sig_line="$(grep -v '^untrusted comment:' "$minisig" | grep -v '^trusted comment:' | grep -m1 . || true)"
  if [ -z "$sig_line" ]; then
    echo "Release signature file is empty or malformed: $minisig" >&2
    exit 1
  fi
  if ! printf '%s' "$sig_line" | base64 -d > "$sig_dir/blob" 2>/dev/null; then
    echo "Release signature is not valid base64" >&2
    exit 1
  fi
  if [ "$(wc -c < "$sig_dir/blob" | tr -d ' ')" -ne 74 ]; then
    echo "Release signature blob has the wrong length (expected 74 bytes)" >&2
    exit 1
  fi
  if [ "$(head -c 2 "$sig_dir/blob")" != "ED" ]; then
    echo "Release signature is not the prehashed Ed25519 form FrameOS uses" >&2
    exit 1
  fi
  tail -c 64 "$sig_dir/blob" > "$sig_dir/sig.bin"
  openssl dgst -blake2b512 -binary "$archive" > "$sig_dir/digest.bin"
  printf '%s\n%s\n%s\n' "-----BEGIN PUBLIC KEY-----" "$FRAMEOS_RELEASE_SIGNING_KEY_SPKI" "-----END PUBLIC KEY-----" > "$sig_dir/release.pub.pem"
  if ! openssl pkeyutl -verify -pubin -inkey "$sig_dir/release.pub.pem" -rawin -in "$sig_dir/digest.bin" -sigfile "$sig_dir/sig.bin" >/dev/null 2>&1; then
    echo "Release signature does not verify against the FrameOS signing key — refusing to install $archive" >&2
    exit 1
  fi
  echo "Release signature verified"
}
"""


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
    frameos_service_after = "After=network.target"
    frameos_service_conflicts = ""
    frameos_service_tty = ""
    if frame.device == "framebuffer":
        frameos_service_after = "After=network.target getty@tty1.service"
        frameos_service_conflicts = "Conflicts=getty@tty1.service"
        frameos_service_tty = (
            "TTYPath=/dev/tty1\n"
            "StandardInput=tty-force\n"
            "TTYReset=yes\n"
            "ExecStopPost=-+/bin/systemd-run --quiet --collect --on-active=10 "
            "/bin/sh -lc '/bin/systemctl show -p ActiveState --value frameos.service 2>/dev/null | "
            "/bin/grep -xq -e active -e activating -e reloading && exit 0; "
            "/bin/systemctl reset-failed getty@tty1.service; "
            "/bin/systemctl start getty@tty1.service'"
        )
    return f"""#!/bin/sh
set -eu

FRAMEOS_RELEASE_VERSION={shlex.quote(version)}
FRAMEOS_RELEASE_BASE_URL={shlex.quote(RELEASE_BASE_URL)}
FRAMEOS_RELEASE_SIGNING_KEY_SPKI={release_signing_public_key_spki_base64()}
FRAMEOS_DIR=/srv/frameos
FRAMEOS_REMOTE_DIR=/srv/frameos/remote
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

{VERIFY_RELEASE_SIGNATURE_SH}
detect_arch() {{
  case "$(uname -m)" in
    aarch64|arm64|armv8) echo arm64 ;;
    armv8l|armv7l|armhf) echo armhf ;;
    # ARMv6 (Pi Zero W / Pi 1) must never fall back to armhf: those release
    # artifacts are built for ARMv7 and SIGILL on the ARM1176. Mirrors the
    # mapping in app/tasks/prebuilt_deps.py:resolve_prebuilt_target.
    armv6l|armv6) echo armv6 ;;
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

  # Only releases with a tarball on the GitHub release pass (the matrix in
  # app/utils/release_targets.py). An older distro cannot borrow a newer
  # build: bookworm's binary needs glibc 2.34+ and bullseye ships 2.31.
  case "$release" in
    {"|".join(release_versions())}) ;;
    *)
      echo "Unsupported OS release: ${{release:-unknown}}. FrameOS releases are built for {release_distro_summary()}; upgrade the OS to install this way." >&2
      exit 1
      ;;
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
need_cmd awk

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this bootstrap script as root, for example: curl -fsSL <url> | sudo sh" >&2
  exit 1
fi

remote_user="${{SUDO_USER:-}}"
if [ -z "$remote_user" ] || [ "$remote_user" = "root" ]; then
  if id pi >/dev/null 2>&1; then
    remote_user=pi
  else
    remote_user="$(id -un)"
  fi
fi
if ! id "$remote_user" >/dev/null 2>&1; then
  remote_user=root
fi

target="$(detect_target)"
base_url="${{FRAMEOS_RELEASE_BASE_URL%/}}"
archive_url="$base_url/v$FRAMEOS_RELEASE_VERSION/frameos-$FRAMEOS_RELEASE_VERSION-$target.tar.gz"
work_dir="$(mktemp -d)"
release_name="release_bootstrap_$(date +%Y%m%d%H%M%S)"
frameos_release_dir="$FRAMEOS_DIR/releases/$release_name"
remote_release_dir="$FRAMEOS_REMOTE_DIR/releases/$release_name"
trap 'rm -rf "$work_dir"' EXIT

# openssl verifies the release signature below; it is on every Debian and
# Ubuntu image FrameOS supports, but a stripped-down one may have dropped it.
install_optional_packages openssl
need_cmd openssl
need_cmd base64

echo "Downloading precompiled FrameOS release for $target"
download_file "$archive_url" "$work_dir/frameos.tar.gz"
download_file "$archive_url.minisig" "$work_dir/frameos.tar.gz.minisig"
verify_release_signature "$work_dir/frameos.tar.gz" "$work_dir/frameos.tar.gz.minisig"
mkdir -p "$work_dir/extract" "$frameos_release_dir" "$remote_release_dir" "$FRAMEOS_REMOTE_DIR/logs" "$FRAMEOS_DIR/logs" "$FRAMEOS_DIR/state"
tar -xzf "$work_dir/frameos.tar.gz" -C "$work_dir/extract"

frameos_binary="$(find "$work_dir/extract" -type f -name frameos | head -n 1)"
remote_binary="$(find "$work_dir/extract" -type f -name frameos_remote | head -n 1)"
if [ -z "$remote_binary" ]; then
  remote_binary="$(find "$work_dir/extract" -type f -name frameos_agent | head -n 1)"
fi
if [ -z "$frameos_binary" ]; then
  echo "The precompiled FrameOS release did not contain frameos for $target" >&2
  exit 1
fi
if [ -z "$remote_binary" ]; then
  echo "The precompiled FrameOS release did not contain frameos_remote for $target" >&2
  exit 1
fi

artifact_root="${{frameos_binary%/*}}"

install_packages hostapd
install_optional_packages caddy
systemctl disable --now caddy.service >/dev/null 2>&1 || true

install -m 0755 "$frameos_binary" "$frameos_release_dir/frameos"
install -m 0755 "$remote_binary" "$remote_release_dir/frameos_remote"

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
cp "$frameos_release_dir/frame.json" "$remote_release_dir/frame.json"

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
{frameos_service_after}
{frameos_service_conflicts}

[Service]
User=$remote_user
WorkingDirectory=$FRAMEOS_DIR/current
ExecStart=$FRAMEOS_DIR/current/frameos
Restart=always
RestartSec=5
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
ExecStopPost=-+/bin/sh -lc 'mkdir -p /srv/frameos/runtime; umask 022; printf "serviceResult=%%s\\nexitCode=%%s\\nexitStatus=%%s\\n" "$SERVICE_RESULT" "$EXIT_CODE" "$EXIT_STATUS" > /srv/frameos/runtime/frameos-last-exit'
{frameos_service_tty}

[Install]
WantedBy=multi-user.target
EOF

cat > "$remote_release_dir/frameos-remote.service" <<EOF
[Unit]
Description=FrameOS Remote (auto-reconnect, hardened)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$remote_user
WorkingDirectory=$FRAMEOS_REMOTE_DIR/current
ExecStart=$FRAMEOS_REMOTE_DIR/current/frameos_remote
Restart=always
RestartSec=5
LimitNOFILE=65536
PrivateTmp=yes
ProtectSystem=full
ReadWritePaths=/etc/systemd/system /etc/cron.d /boot

[Install]
WantedBy=multi-user.target
EOF

rm -rf "$FRAMEOS_DIR/current" "$FRAMEOS_REMOTE_DIR/current"
ln -s "$frameos_release_dir" "$FRAMEOS_DIR/current"
ln -s "$remote_release_dir" "$FRAMEOS_REMOTE_DIR/current"
chown -R "$remote_user" "$FRAMEOS_DIR"

if [ "$FRAMEOS_COMPILED_SCENE_COUNT" -gt 0 ]; then
  echo "This script installed the precompiled FrameOS runtime. $FRAMEOS_COMPILED_SCENE_COUNT legacy compiled scene(s) will not run on it until a full deploy (source build) after FrameOS Remote connects — or convert them to JavaScript (docs/nim-to-js-conversion.md) and skip the build."
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
install -m 0644 "$remote_release_dir/frameos-remote.service" /etc/systemd/system/frameos-remote.service
systemctl daemon-reload
systemctl enable frameos.service frameos-remote.service
legacy_disable_script={shlex.quote(legacy_remote_cleanup_script(delay_seconds=1))}
if command -v systemd-run >/dev/null 2>&1; then
  systemd-run --quiet --unit=frameos-remote-disable-legacy-service --collect /bin/sh -lc "$legacy_disable_script" >/dev/null 2>&1 || true
else
  nohup sh -c "$legacy_disable_script" >/dev/null 2>&1 &
fi
if [ "$setup_status" -eq 2 ]; then
  systemctl restart frameos-remote.service
  echo "FrameOS and FrameOS Remote are installed. Reboot this device to finish hardware setup."
  exit 0
fi

systemctl restart frameos-remote.service
systemctl restart frameos.service

echo "FrameOS and FrameOS Remote are installed and started"
"""


@api_project.post("/frames/{id:int}/frame_bootstrap", response_model=FrameBootstrapResponse)
async def api_frame_bootstrap_command(
    id: int,
    request: Request,
    select_remote: bool | None = None,
    select_agent: bool | None = Query(default=None, include_in_schema=False),
    regenerate: bool = False,
    db: Session = Depends(get_db),
    redis: Redis = Depends(get_redis),
):
    frame = project_get_or_404(db, Frame, id, detail="Frame not found")
    if (frame.mode or "rpios") != "rpios":
        _bad_request("FrameOS bootstrap is only supported for Raspberry Pi OS frames")

    selected_remote = select_remote if select_remote is not None else (select_agent if select_agent is not None else True)
    await _ensure_frame_bootstrap_enabled(db, redis, frame, select_remote=selected_remote, regenerate=regenerate)
    script_url = _frame_bootstrap_script_url(request, frame)
    # The script embeds this frame's API key and the remote's shared secret;
    # over plain http they cross the LAN in clear, once, when the command is
    # run. The release archive itself is signature-checked on the device
    # regardless of transport, so the exposure is the secrets, not the code.
    plain_http = script_url.startswith("http://")
    return {
        "script_url": script_url,
        "command": f"curl -fsSL {shlex.quote(script_url)} | sudo sh",
        "plain_http": plain_http,
        "warning": (
            "This backend is reached over plain HTTP, so the install script — which carries this frame's API key "
            "and its FrameOS Remote secret — travels unencrypted across your network when the command runs. Fine "
            "on a trusted home LAN; put the backend behind HTTPS before using it elsewhere."
            if plain_http
            else None
        ),
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
