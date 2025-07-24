"""
Build a NixOS SD-card image for a frame, pre-populated with an initial release.
Most code paths are shared with deploy_frame.py.
"""
from __future__ import annotations
import shutil
import tempfile
import json
import asyncio
from pathlib import Path
from datetime import datetime, timezone
from typing import Any

from arq import ArqRedis as Redis
from sqlalchemy.orm import Session

from app.models.frame import Frame, get_frame_json
from app.models.log   import new_log as log
from app.tasks.deploy_frame import FrameDeployer, make_local_modifications
from .utils import find_nim_v2
from app.models.settings import get_settings_dict
from app.utils.nix_utils import nix_cmd

async def build_sd_card_image(id: int, redis: Redis):
    await redis.enqueue_job("build_sd_card_image", id=id)

async def build_sd_card_image_task(
    ctx: dict[str, Any], id: int
) -> Path:

    db:     Session = ctx["db"]
    redis:  Redis   = ctx["redis"]

    frame: Frame | None = db.get(Frame, id)
    if frame is None:
        raise RuntimeError("Frame not found")

    # ──────────────────────────────────────────────────────────────
    # 0.  Preconditions
    # ──────────────────────────────────────────────────────────────
    if not frame.scenes:
        await log(db, redis, id, "stderr", "No scenes installed – aborting image build")
        raise RuntimeError("No scenes installed")

    # ──────────────────────────────────────────────────────────────
    # 1.  Prepare local copy with driver-specific sources
    # ──────────────────────────────────────────────────────────────
    nim_path = find_nim_v2()
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        build_id  = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
        flake_dir = tmp_path / Path("flake")
        shutil.copytree(Path(__file__).resolve().parents[3] / "frameos",
                        flake_dir, dirs_exist_ok=True)

        await log(db, redis, id, "build",
                  f"Building SD-card image for frame \"{frame.name}\" with build ID {build_id}. "
                  "This may take around 5 minutes. The download will begin then. Please don't run a second time while already building.")

        # patch sources exactly like deploy_frame (re-use helpers)
        await make_local_modifications(
            FrameDeployer(db, redis, frame, nim_path, str(tmp)),
            str(flake_dir)
        )

        # write frame.json so the binary is reproducible
        (flake_dir / "frame.json").write_text(
            json.dumps(get_frame_json(db, frame), indent=4) + "\n"
        )

        # ──────────────────────────────────────────────────────────
        # 2.  nix build → sdImage
        # ──────────────────────────────────────────────────────────
        settings = get_settings_dict(db)
        cmd, masked_cmd, cleanup = nix_cmd(
            "nix --extra-experimental-features 'nix-command flakes' "
            f"build \"$(realpath {flake_dir})\"#packages.aarch64-linux.sdImage "
            "--system aarch64-linux --show-trace --print-out-paths",
            settings
        )
        try:
            await log(db, redis, id, "build", f"$ {masked_cmd}")
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
            await log(db, redis, id, "build", line)   # live-push to UI

        ret = await proc.wait()
        if ret != 0:
            await log(db, redis, id, "stderr",
                      "nix build failed while producing sdImage")
            raise RuntimeError("sdImage build failed")

        image_path = last_line.strip()
        if not image_path.startswith("/nix/store/") and not image_path.endswith(".img.zst"):
            await log(db, redis, id, "stderr",
                      f"Unexpected output from nix build: {image_path}")
            raise RuntimeError("Unexpected output from nix build")

    try:
        sd_dir = Path(image_path) / Path("sd-image")
        candidates = list(sd_dir.glob("*.img*"))  # matches .img and .img.zst

        if len(candidates) != 1:
            await log(
                db,
                redis,
                id,
                "stderr",
                f"Expected exactly one image in {sd_dir}, found {len(candidates)} "
                f"({', '.join(p.name for p in candidates)})",
            )
            raise RuntimeError("Unable to identify unique SD-card image")

        size = candidates[0].stat().st_size
        await log(db, redis, id, "stdinfo", "🎉 SD-card image ready: " + candidates[0].name + f" ({size / (1024 * 1024):.2f} MiB)")
    except Exception as e:
        await log(db, redis, id, "stderr", f"SD-card image ready, but we can't find it: {e}")
        raise


    return candidates[0]
