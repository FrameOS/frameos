
from datetime import datetime
import json
import math
from pathlib import Path
import random
import shlex
import string
import tempfile
from typing import Optional

from arq import ArqRedis as Redis
from sqlalchemy.orm import Session

from app.models.frame import Frame, get_frame_json
from app.models.log import new_log as log
from app.utils.local_exec import exec_local_command
from app.utils.remote_exec import upload_file, run_command

BYTES_PER_MB   = 1_048_576
DEFAULT_CHUNK  = 25 * BYTES_PER_MB

class FrameDeployer:
    ## This entire file is a big refactor in progress.
    def __init__(self, db: Session, redis: Redis, frame: Frame, nim_path: str, temp_dir: str):
        self.db = db
        self.redis = redis
        self.frame = frame
        self.nim_path = nim_path
        self.temp_dir = temp_dir
        self.build_id = ''.join(random.choice(string.ascii_lowercase) for _ in range(12))
        self.deploy_start: datetime = datetime.now()

    async def exec_command(
        self,
        command: str,
        output: Optional[list[str]] = None,
        log_output: bool = True,
        log_command: str | bool = True,
        raise_on_error: bool = True,
        timeout: int = 600 # 10 minutes default timeout
    ) -> int:
        status, stdout, stderr = await run_command(
            self.db, self.redis, self.frame, command, log_output=log_output, log_command=log_command, timeout=timeout
        )
        if output is not None:
            lines = (stdout + "\n" + stderr).splitlines()
            output.extend(lines)
        if status != 0 and raise_on_error:
            raise Exception(
                f"Command '{command}' failed with code {status}\nstderr: {stderr}\nstdout: {stdout}"
            )
        return status

    async def log(self, type: str, line: str, timestamp: Optional[datetime] = None):
        await log(self.db, self.redis, int(self.frame.id), type=type, line=line, timestamp=timestamp)

    async def _store_paths_missing(self, paths: list[str]) -> list[str]:
        """
        Return *only* those paths that are **missing** from /nix/store on the
        frame.  All paths are checked in a single SSH exec.
        """
        if not paths:
            return []

        # Quote every path once; the remote loop echoes the missing ones.
        joined = " ".join(shlex.quote(p) for p in paths)
        script = "for p; do [ -e \"$p\" ] || echo \"$p\"; done"
        out: list[str] = []
        await self.exec_command(
            f"bash -s -- {joined} <<'EOF'\n{script}\nEOF",
            output=out,
            raise_on_error=False,
            log_command=f"bash -s -- **SKIPPED** <<'EOF'\n{script}\nEOF",
            log_output=False,
        )
        # Every line produced by the loop is a missing store path.
        return [p.strip() for p in out if p.strip()]

    async def _upload_frame_json(self, path: str) -> None:
        """Upload the release-specific `frame.json`."""
        json_data = json.dumps(get_frame_json(self.db, self.frame), indent=4).encode() + b"\n"
        await upload_file(self.db, self.redis, self.frame, path, json_data)

    async def nix_upload_path_and_deps(
        self: "FrameDeployer",
        path: str,
        max_chunk_size: int = DEFAULT_CHUNK,
    ) -> int: # return number of uploaded items
        """
        Export the full runtime closure of *path* and import it on the target
        machine, but bundle the nar streams so that at most `max_chunk_size`
        bytes are transferred per upload (≈10 MiB by default).

        The implementation relies on
            • `nix path-info --json` to get the *narSize* of every path once,
            • `nix-store --export …` which can export many store paths in one
            go, producing a concatenated nar stream,
            • `nix-store --import` on the device to unpack an entire chunk.
        """
        await self.log("stdout", f"- Collecting runtime closure for {path}")

        # 1. Get complete closure
        status, paths_out, err = await exec_local_command(
            self.db, self.redis, self.frame, f"nix-store -qR {path}", log_output=False
        )
        if status:
            raise RuntimeError(f"Failed to collect closure: {err}")

        runtime_paths = (paths_out or "").strip().splitlines()
        await self.log("stdout", f"  → {len(runtime_paths)} store paths")

        # 2. Filter out paths that are already present on the device
        missing = await self._store_paths_missing(runtime_paths)
        if not missing:
            await self.log("stdout", "  → No missing store paths, skipping upload")
            return 0
        await self.log(
            "stdout",
            f"  → {len(missing)} paths need upload; bundling in ≤{max_chunk_size // BYTES_PER_MB} MiB chunks"
        )

        # 3. Query nar sizes once for all paths
        cmd = ["nix", "path-info", "--json", *missing]
        status, size_json, err = await exec_local_command(
            self.db, self.redis, self.frame, " ".join(cmd), log_output=False
        )
        if status:
            raise RuntimeError(f"nix path-info failed: {err}")

        size_info: dict[str, int] = {}
        info = json.loads(size_json or "{}")

        if isinstance(info, dict):
            # `info` maps path → metadata
            for p, meta in info.items():
                # prefer `narSize` (current), fall back to legacy `nar`
                size_info[p] = int(meta.get("narSize") or meta.get("nar") or 0)
        else:  # older nix (<2.4) returned a list
            for meta in info:                          # type: ignore[arg-type]
                size_info[meta["path"]] = int(meta.get("narSize") or meta.get("nar") or 0)

        # 4. Greedily pack paths up to ~max_chunk_size each
        chunks: list[list[str]] = []
        current: list[str] = []
        current_size = 0
        for p in missing:
            nar_size = size_info.get(p, 0)
            # start new chunk if adding would overflow (but always put at least one)
            if current and current_size + nar_size > max_chunk_size:
                chunks.append(current)
                current, current_size = [], 0
            current.append(p)
            current_size += nar_size
        if current:
            chunks.append(current)

        await self.log("stdout", f"  → Uploading in {len(chunks)} chunk(s)")

        remote_tmp = f"/tmp/frameos_import_{self.build_id}"
        await self.exec_command(f"mkdir -p {remote_tmp}")

        try:
            for i, chunk in enumerate(chunks, 1):
                with tempfile.TemporaryDirectory() as tmpdir:
                    nar_local = Path(tmpdir) / f"chunk_{i}.nar"
                    export_cmd = f"nix-store --export {' '.join(shlex.quote(p) for p in chunk)} > {nar_local}"
                    status, _, err = await exec_local_command(
                        self.db, self.redis, self.frame, export_cmd
                    )
                    if status:
                        raise RuntimeError(f"Export failed for chunk {i}: {err}")

                    # 5. Ship and import the chunk
                    remote_nar = f"{remote_tmp}/chunk_{i}.nar"
                    with open(nar_local, "rb") as fh:
                        await upload_file(
                            self.db, self.redis, self.frame, remote_nar, fh.read()
                        )

                    await self.exec_command(
                        f"sudo nix-store --import < {remote_nar} && rm {remote_nar}"
                    )
                    await self.log(
                        "stdout",
                        f"🍀 imported chunk {i}/{len(chunks)} 🍀 "
                        f"({len(chunk)} paths, {math.ceil(nar_local.stat().st_size/BYTES_PER_MB)} MiB)"
                    )
        finally:
            await self.exec_command(f"rmdir {remote_tmp}")

        return len(missing)

    async def get_distro(self) -> str:
        distro_out: list[str] = []
        await self.exec_command(
            "bash -c '"
            "if [ -e /etc/nixos/version ]; then echo nixos ; "
            "elif [ -f /etc/rpi-issue ] || grep -q \"^ID=raspbian\" /etc/os-release ; then echo raspios ; "
            "else . /etc/os-release ; echo ${ID:-unknown} ; "
            "fi'",
            distro_out
        )
        distro = distro_out[0].strip().lower()
        return distro if distro else "unknown"

    async def get_total_memory_mb(self) -> int:
        mem_output: list[str] = []
        await self.exec_command(
            "grep MemTotal /proc/meminfo | awk '{print $2}'",
            mem_output,
        )
        kib = int(mem_output[0].strip()) if mem_output else 0   # kB from the kernel
        total_memory = kib // 1024                             # MiB
        return total_memory

    async def get_cpu_architecture(self) -> str:
        uname_output: list[str] = []
        await self.exec_command("uname -m", uname_output)
        arch = "".join(uname_output).strip()
        return arch

    async def arch_to_nim_cpu(self, arch: str) -> str:
        if arch in ("aarch64", "arm64"):
            return "arm64"
        elif arch in ("armv6l", "armv7l"):
            return "arm"
        elif arch == "i386":
            return "i386"
        else:
            return "amd64"

    async def restart_service(self, service_name: str) -> None:
        await self.exec_command(f"sudo systemctl enable {service_name}.service")
        await self.exec_command(f"sudo systemctl restart {service_name}.service")
        await self.exec_command(f"sudo systemctl status {service_name}.service")

    async def stop_service(self, service_name: str) -> None:
        await self.exec_command(f"sudo systemctl stop {service_name}.service || true")

    async def disable_service(self, service_name: str) -> None:
        await self.exec_command(f"sudo systemctl disable {service_name}.service", raise_on_error=False)
