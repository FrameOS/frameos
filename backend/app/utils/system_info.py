from __future__ import annotations

import os
import platform
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

from sqlalchemy.engine import make_url

from app.config import config
from app.utils.cross_compile import CACHE_ENV as CROSS_CACHE_ENV, DEFAULT_CACHE as DEFAULT_CROSS_CACHE

BACKEND_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = Path(__file__).resolve().parents[2]


@dataclass(frozen=True)
class DiskUsage:
    total_bytes: int
    used_bytes: int
    free_bytes: int


@dataclass(frozen=True)
class MemoryInfo:
    total_bytes: int | None
    available_bytes: int | None


@dataclass(frozen=True)
class LoadAverage:
    one: float | None
    five: float | None
    fifteen: float | None


@dataclass(frozen=True)
class CacheUsage:
    name: str
    path: Path
    size_bytes: int
    exists: bool


@dataclass(frozen=True)
class DatabaseUsage:
    path: Path | None
    size_bytes: int | None
    exists: bool


def _safe_stat(path: Path) -> int:
    try:
        return path.stat().st_size
    except OSError:
        return 0


def directory_size(path: Path) -> int:
    if not path.exists():
        return 0

    total = 0
    for entry in path.rglob("*"):
        if entry.is_file():
            total += _safe_stat(entry)
    return total


def get_disk_usage(path: str | Path = "/") -> DiskUsage:
    usage = shutil.disk_usage(path)
    return DiskUsage(total_bytes=usage.total, used_bytes=usage.used, free_bytes=usage.free)


def get_memory_info() -> MemoryInfo:
    meminfo = Path("/proc/meminfo")
    if meminfo.exists():
        total = available = None
        for line in meminfo.read_text().splitlines():
            if line.startswith("MemTotal:"):
                total = int(line.split()[1]) * 1024
            elif line.startswith("MemAvailable:"):
                available = int(line.split()[1]) * 1024
            elif line.startswith("MemFree:") and available is None:
                available = int(line.split()[1]) * 1024
        return MemoryInfo(total_bytes=total, available_bytes=available)

    if platform.system() == "Darwin":
        try:
            total_bytes = int(subprocess.check_output(["sysctl", "-n", "hw.memsize"]).strip())
        except Exception:
            total_bytes = None

        available_bytes = None
        try:
            vm_stat = subprocess.check_output(["vm_stat"]).decode()
            pagesize_line = vm_stat.splitlines()[0]
            page_size = int(pagesize_line.split("of")[-1].split("bytes")[0].strip())
            free_pages = inactive_pages = speculative_pages = 0
            for line in vm_stat.splitlines():
                if line.startswith("Pages free"):
                    free_pages = int(line.split(":")[-1].strip().rstrip("."))
                elif line.startswith("Pages inactive"):
                    inactive_pages = int(line.split(":")[-1].strip().rstrip("."))
                elif line.startswith("Pages speculative"):
                    speculative_pages = int(line.split(":")[-1].strip().rstrip("."))
            available_bytes = (free_pages + inactive_pages + speculative_pages) * page_size
        except Exception:
            pass

        return MemoryInfo(total_bytes=total_bytes, available_bytes=available_bytes)

    return MemoryInfo(total_bytes=None, available_bytes=None)


def get_load_average() -> LoadAverage:
    try:
        one, five, fifteen = os.getloadavg()
        return LoadAverage(one=one, five=five, fifteen=fifteen)
    except OSError:
        return LoadAverage(one=None, five=None, fifteen=None)


def _sqlite_path(database_url: str) -> Path | None:
    url = make_url(database_url)
    if url.drivername != "sqlite":
        return None

    db_path = Path(url.database or "")
    if not db_path.is_absolute():
        db_path = (REPO_ROOT / db_path).resolve()
    return db_path


def get_database_usage() -> DatabaseUsage:
    db_path = _sqlite_path(config.DATABASE_URL)
    if db_path is None:
        return DatabaseUsage(path=None, size_bytes=None, exists=False)

    exists = db_path.exists()
    size = _safe_stat(db_path) if exists else 0
    return DatabaseUsage(path=db_path, size_bytes=size, exists=exists)


def _cache_paths() -> Iterable[tuple[str, Path]]:
    cross_cache = Path(os.environ.get(CROSS_CACHE_ENV, DEFAULT_CROSS_CACHE)).expanduser()
    docker_root = Path(os.environ.get("DOCKER_DATA_ROOT", "/var/lib/docker")).expanduser()
    frameos_cache = (Path.home() / ".cache" / "frameos").expanduser()
    nix_store = Path("/nix/store")

    return (
        ("Cross-compilation", cross_cache),
        ("Docker", docker_root),
        ("FrameOS cache", frameos_cache),
        ("Nix store", nix_store),
    )


def get_cache_usage() -> list[CacheUsage]:
    caches: list[CacheUsage] = []
    seen: set[Path] = set()
    for name, path in _cache_paths():
        if path in seen:
            continue
        seen.add(path)

        exists = path.exists()
        if not exists:
            continue

        size_bytes = directory_size(path)
        caches.append(CacheUsage(name=name, path=path, size_bytes=size_bytes, exists=exists))
    return caches


def get_system_info() -> tuple[DiskUsage, list[CacheUsage], DatabaseUsage, MemoryInfo, LoadAverage]:
    disk = get_disk_usage()
    caches = get_cache_usage()
    database = get_database_usage()
    memory = get_memory_info()
    load = get_load_average()
    return disk, caches, database, memory, load


def get_system_metrics() -> tuple[DiskUsage, MemoryInfo, LoadAverage]:
    disk = get_disk_usage()
    memory = get_memory_info()
    load = get_load_average()
    return disk, memory, load
