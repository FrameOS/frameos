"""
Build SD-card images for supported platforms.

Historically this only handled NixOS images compiled from our flake.  The Luckfox
Pico devices ship their own Buildroot-based distribution which we now support by
cloning their vendor repository and running its build script.  The public API
continues to expose a single "build_sd_card_image" task which dispatches to the
appropriate backend implementation based on the frame's mode/platform.
"""
from __future__ import annotations

import asyncio
import json
import re
import shlex
import shutil
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from arq import ArqRedis as Redis
from sqlalchemy.orm import Session

from app.models.assets import copy_custom_fonts_to_local_source_folder
from app.models.frame import Frame, get_frame_json
from app.models.log import new_log as log
from app.models.settings import get_settings_dict
from app.tasks._frame_deployer import FrameDeployer
from app.utils.local_exec import exec_local_command
from app.utils.nix_utils import nix_cmd
from .utils import find_nim_v2

LUCKFOX_REPO_URL = "https://github.com/LuckfoxTECH/luckfox-pico.git"
LUCKFOX_COMMIT = "994243753789e1b40ef91122e8b3688aae8f01b8"
LUCKFOX_SUPPORTED_PLATFORMS = {
    "luckfox-pico-plus": "luckfox_pico_plus",
    "luckfox-pico-max": "luckfox_pico_max",
}


def _sanitize_filename(value: str) -> str:
    sanitized = re.sub(r"[^A-Za-z0-9._-]+", "_", value).strip("._-")
    return sanitized or "frame"

async def build_sd_card_image(id: int, redis: Redis):
    await redis.enqueue_job("build_sd_card_image", id=id)


async def build_sd_card_image_task(ctx: dict[str, Any], id: int) -> Path:
    db: Session = ctx["db"]
    redis: Redis = ctx["redis"]

    frame: Frame | None = db.get(Frame, id)
    if frame is None:
        raise RuntimeError("Frame not found")

    if frame.mode == "buildroot" and (frame.buildroot or {}).get("platform") in LUCKFOX_SUPPORTED_PLATFORMS:
        return await _build_luckfox_sd_card_image(db, redis, frame)

    if frame.mode not in (None, "nixos"):
        raise RuntimeError("SD-card image builds are only supported for NixOS or Luckfox Pico frames")

    return await _build_nixos_sd_card_image(db, redis, frame)


async def _build_nixos_sd_card_image(db: Session, redis: Redis, frame: Frame) -> Path:
    start_time = datetime.now()

    if not frame.scenes:
        await log(db, redis, frame.id, "stderr", "No scenes installed – aborting image build")
        raise RuntimeError("No scenes installed")

    nim_path = find_nim_v2()
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        build_id = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
        flake_dir = tmp_path / Path("flake")
        shutil.copytree(Path(__file__).resolve().parents[3] / "frameos", flake_dir, dirs_exist_ok=True)

        await log(
            db,
            redis,
            frame.id,
            "build",
            f"Building SD-card image for frame \"{frame.name}\" with build ID {build_id}. This may take 2-10 minutes. "
            "The download will begin then. Please don't run a second time while already building.",
        )

        deployer = FrameDeployer(db, redis, frame, nim_path, str(tmp))
        await deployer.make_local_modifications(str(flake_dir))
        await copy_custom_fonts_to_local_source_folder(db, str(flake_dir))

        (flake_dir / "frame.json").write_text(json.dumps(get_frame_json(db, frame), indent=4) + "\n")

        settings = get_settings_dict(db)
        cmd, masked_cmd, cleanup = nix_cmd(
            "nix --extra-experimental-features 'nix-command flakes' "
            f"build \"$(realpath {flake_dir})\"#packages.aarch64-linux.sdImage "
            "--system aarch64-linux --print-out-paths",
            settings,
        )
        try:
            await log(db, redis, frame.id, "build", f"$ {masked_cmd}")
            proc = await asyncio.create_subprocess_shell(
                cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
            )
        finally:
            cleanup()

        if proc.stdout is None:
            raise RuntimeError("Failed to start nix build process")

        last_line = ""
        async for raw in proc.stdout:
            line = raw.decode().rstrip("\n")
            last_line = line
            await log(db, redis, frame.id, "build", line)

        ret = await proc.wait()
        if ret != 0:
            await log(db, redis, frame.id, "stderr", "nix build failed while producing sdImage")
            raise RuntimeError("sdImage build failed")

        image_path = last_line.strip()
        if not image_path.startswith("/nix/store/") and not image_path.endswith(".img.zst"):
            await log(db, redis, frame.id, "stderr", f"Unexpected output from nix build: {image_path}")
            raise RuntimeError("Unexpected output from nix build")

    try:
        sd_dir = Path(image_path) / Path("sd-image")
        candidates = list(sd_dir.glob("*.img*"))

        if len(candidates) != 1:
            await log(
                db,
                redis,
                frame.id,
                "stderr",
                f"Expected exactly one image in {sd_dir}, found {len(candidates)} ({', '.join(p.name for p in candidates)})",
            )
            raise RuntimeError("Unable to identify unique SD-card image")

        size = candidates[0].stat().st_size
        await log(
            db,
            redis,
            frame.id,
            "stdinfo",
            f"🎉 SD-card image ready in {datetime.now() - start_time}: {candidates[0].name} ({size / (1024 * 1024):.2f} MiB)",
        )
    except Exception as exc:
        await log(db, redis, frame.id, "stderr", f"SD-card image ready, but we can't find it: {exc}")
        raise

    return candidates[0]


async def _build_luckfox_sd_card_image(db: Session, redis: Redis, frame: Frame) -> Path:
    platform = (frame.buildroot or {}).get("platform")
    board = LUCKFOX_SUPPORTED_PLATFORMS.get(platform or "")
    if not board:
        raise RuntimeError("Unsupported Luckfox platform")

    await log(
        db,
        redis,
        frame.id,
        "build",
        f"Building Luckfox Pico image for platform {platform} (commit {LUCKFOX_COMMIT[:12]})",
    )

    build_started = datetime.now()
    build_started_ts = time.time()

    dest_path: Path | None = None

    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        repo_path = tmp_path / "luckfox-pico"

        clone_cmd = f"git clone --filter=blob:none {shlex.quote(LUCKFOX_REPO_URL)} {shlex.quote(str(repo_path))}"
        status, _, _ = await exec_local_command(db, redis, frame, clone_cmd, log_command=clone_cmd)
        if status != 0:
            raise RuntimeError("Failed to clone Luckfox repository")

        checkout_cmd = f"cd {shlex.quote(str(repo_path))} && git checkout {shlex.quote(LUCKFOX_COMMIT)}"
        status, _, _ = await exec_local_command(db, redis, frame, checkout_cmd, log_command=checkout_cmd)
        if status != 0:
            raise RuntimeError("Failed to checkout Luckfox commit")

        submodule_cmd = f"cd {shlex.quote(str(repo_path))} && git submodule update --init --recursive"
        status, _, _ = await exec_local_command(db, redis, frame, submodule_cmd, log_command=submodule_cmd)
        if status != 0:
            raise RuntimeError("Failed to update Luckfox submodules")

        build_commands = [
            f"./build.sh {board}",
            f"./build.sh {board} build",
        ]

        build_succeeded = False
        for command in build_commands:
            full_cmd = f"cd {shlex.quote(str(repo_path))} && {command}"
            status, _, _ = await exec_local_command(db, redis, frame, full_cmd, log_command=command)
            if status == 0:
                build_succeeded = True
                break
        if not build_succeeded:
            raise RuntimeError("Luckfox build.sh failed")

        pack_commands = [
            f"./build.sh {board} pack",
            f"./build.sh {board} image",
        ]
        for command in pack_commands:
            full_cmd = f"cd {shlex.quote(str(repo_path))} && {command}"
            status, _, _ = await exec_local_command(db, redis, frame, full_cmd, log_command=command)
            if status == 0:
                break

        candidates: list[Path] = []
        search_roots = [
            repo_path / "buildroot" / "output",
            repo_path / "output",
        ]
        for root in search_roots:
            if root.exists():
                candidates.extend(p for p in root.rglob("*") if p.is_file())

        if not candidates:
            candidates = [p for p in repo_path.rglob("*") if p.is_file()]

        board_hint = board.replace("_", "").lower()
        name_hint = (platform or "").replace("-", "").lower()

        def _is_candidate(path: Path) -> bool:
            if path.stat().st_mtime < build_started_ts:
                return False
            filename = path.name.lower()
            if not any(
                filename.endswith(ext)
                for ext in (".img", ".img.gz", ".img.xz", ".img.zst", ".img.zip", ".zip")
            ):
                return False
            compact = re.sub(r"[^a-z0-9]", "", filename)
            if board_hint in compact or name_hint in compact:
                return True
            return False

        filtered = [p for p in candidates if _is_candidate(p)]
        if not filtered:
            filtered = [
                p
                for p in candidates
                if p.stat().st_mtime >= build_started_ts
                and any(
                    p.name.lower().endswith(ext)
                    for ext in (".img", ".img.gz", ".img.xz", ".img.zst", ".img.zip", ".zip")
                )
            ]

        if not filtered:
            raise RuntimeError("Unable to locate Luckfox build artefact")

        filtered.sort(key=lambda p: p.stat().st_mtime, reverse=True)
        source_path = filtered[0]

        cache_root = Path.home() / ".cache" / "frameos" / "luckfox"
        cache_root.mkdir(parents=True, exist_ok=True)

        safe_name = _sanitize_filename(frame.name or f"frame{frame.id}")
        suffix = "".join(source_path.suffixes) or source_path.suffix or ".img"
        dest_name = f"{safe_name}-{platform}{suffix}"
        dest_path = cache_root / dest_name
        if dest_path.exists():
            dest_path.unlink()
        shutil.copy2(source_path, dest_path)

    if dest_path is None:
        raise RuntimeError("Failed to prepare Luckfox artefact")

    size = dest_path.stat().st_size
    await log(
        db,
        redis,
        frame.id,
        "stdinfo",
        f"🎉 Luckfox image ready in {datetime.now() - build_started}: {dest_path.name} ({size / (1024 * 1024):.2f} MiB)",
    )

    return dest_path
