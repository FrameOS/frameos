"""Helpers for discovering prebuilt dependency archives."""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import shlex
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urljoin

import httpx

ARCHIVE_BASE_URL = os.environ.get("FRAMEOS_ARCHIVE_BASE_URL", "https://archive.frameos.net/")
MANIFEST_PATH = "prebuilt-deps/manifest.json"
MANIFEST_TIMEOUT = float(os.environ.get("FRAMEOS_PREBUILT_TIMEOUT", "20"))
REPO_ROOT = Path(__file__).resolve().parents[3]
LOCAL_MANIFEST_FILE = REPO_ROOT / "tools" / "prebuilt-deps" / "manifest.json"
USE_REMOTE_MANIFEST = os.environ.get("FRAMEOS_PREBUILT_USE_REMOTE", "").lower() in {"1", "true", "yes"}

_MANIFEST_CACHE: dict[str, "PrebuiltEntry"] | None = None
_MANIFEST_LOCK = asyncio.Lock()


def _normalize_base(url: str) -> str:
    return url if url.endswith("/") else f"{url}/"


@dataclass(slots=True)
class PrebuiltEntry:
    target: str
    versions: dict[str, str]
    component_urls: dict[str, str]
    component_md5s: dict[str, str]
    component_sha256s: dict[str, str] = field(default_factory=dict)

    def url_for(self, component: str) -> str | None:
        return self.component_urls.get(component)

    def version_for(self, component: str, default: str | None = None) -> str | None:
        return self.versions.get(component) or default

    def md5_for(self, component: str) -> str | None:
        return self.component_md5s.get(component)

    def sha256_for(self, component: str) -> str | None:
        return self.component_sha256s.get(component)

    def checksum_marker(self, component: str) -> str:
        """The checksum an archive is verified against, for cache markers."""
        return (self.sha256_for(component) or self.md5_for(component) or "").strip().lower()

    def has_verifiable_checksum(self, component: str) -> bool:
        return self.verify_command(component, "/dev/null") is not None

    def verify_file(self, component: str, path: Path) -> None:
        """Raise unless the file at `path` is the published archive; the same
        rules as verify_command, for archives downloaded by the backend."""
        sha256 = (self.sha256_for(component) or "").strip().lower()
        md5 = (self.md5_for(component) or "").strip().lower()
        if sha256:
            algorithm, expected = "SHA-256", sha256
            hasher = hashlib.sha256()
        elif md5 and "-" not in md5:
            algorithm, expected = "MD5", md5
            hasher = hashlib.md5()
        else:
            raise RuntimeError(f"no verifiable checksum published for prebuilt {component}")
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                hasher.update(chunk)
        actual = hasher.hexdigest()
        if actual != expected:
            raise RuntimeError(f"{algorithm} mismatch for prebuilt {component}: expected {expected}, got {actual}")

    def verify_command(self, component: str, path: str) -> str | None:
        """Shell command that exits non-zero unless the file at `path` is the
        published archive, or None when the manifest has no usable checksum.

        SHA-256 is the checksum of record; component_md5sums holds R2 ETags,
        which are only real MD5s for single-part uploads (a multipart ETag
        looks like "<hex>-<parts>" and matches no file)."""
        sha256 = (self.sha256_for(component) or "").strip().lower()
        if sha256:
            return f"echo {shlex.quote(sha256 + '  ' + path)} | sha256sum -c -"
        md5 = (self.md5_for(component) or "").strip().lower()
        if md5 and "-" not in md5:
            return f"echo {shlex.quote(md5 + '  ' + path)} | md5sum -c -"
        return None


def _manifest_file_override() -> Path | None:
    override = os.environ.get("FRAMEOS_PREBUILT_MANIFEST_FILE")
    if override:
        candidate = Path(override)
        if candidate.is_file():
            return candidate
    if not USE_REMOTE_MANIFEST and LOCAL_MANIFEST_FILE.is_file():
        return LOCAL_MANIFEST_FILE
    return None


def _entries_from_payload(payload: dict, base: str) -> dict[str, PrebuiltEntry]:
    entries: dict[str, PrebuiltEntry] = {}
    for entry in payload.get("entries", []):
        target = entry.get("target")
        if not target:
            continue
        component_urls = {}
        for component, key in (entry.get("component_keys") or {}).items():
            if not key:
                continue
            component_urls[component] = urljoin(base, key)
        entries[target] = PrebuiltEntry(
            target=target,
            versions=entry.get("versions") or {},
            component_urls=component_urls,
            component_md5s=entry.get("component_md5sums") or {},
            component_sha256s=entry.get("component_sha256sums") or {},
        )
    return entries


async def fetch_prebuilt_manifest(base_url: str | None = None) -> dict[str, PrebuiltEntry]:
    base = _normalize_base(base_url or ARCHIVE_BASE_URL)
    async with _MANIFEST_LOCK:
        global _MANIFEST_CACHE
        if _MANIFEST_CACHE is not None:
            return _MANIFEST_CACHE

        manifest_file = _manifest_file_override()
        if manifest_file:
            payload = json.loads(manifest_file.read_text())
            entries = _entries_from_payload(payload, base)
            _MANIFEST_CACHE = entries
            return entries

        manifest_url = urljoin(base, MANIFEST_PATH)
        async with httpx.AsyncClient(timeout=MANIFEST_TIMEOUT) as client:
            response = await client.get(manifest_url)
            response.raise_for_status()
            payload = response.json()

        entries = _entries_from_payload(payload, base)
        _MANIFEST_CACHE = entries
        return entries


def _normalize_ubuntu_release(version: str) -> str | None:
    release = (version or "").lower().strip()
    release = release.replace("lts", "").strip()
    if release.startswith("22.04") or release.startswith("jammy"):
        return "22.04"
    if release.startswith("24.04") or release.startswith("noble"):
        return "24.04"
    if release.startswith("26.04") or release.startswith("resolute"):
        return "26.04"
    return None


def _normalize_buildroot_release(version: str) -> str | None:
    # Buildroot release images are composed from the Debian Bookworm ARM64
    # precompiled FrameOS artifact. The detected Buildroot version is the OS
    # buildroot version, not a binary artifact target version.
    return "bookworm" if (version or "").strip() else None


def resolve_prebuilt_target(distro: str, version: str, arch: str) -> str | None:
    distro_input = (distro or "").lower()
    distro_key = {
        "raspios": "debian",
        "pios": "debian",
        "debian": "debian",
        "ubuntu": "ubuntu",
        "buildroot": "buildroot",
    }.get(distro_input)
    if not distro_key:
        return None

    release_key: str | None = None
    release = (version or "").lower()
    if distro_key == "debian":
        allowed = {"buster", "bullseye", "bookworm", "trixie"}
        if release in allowed:
            release_key = release
    elif distro_key == "ubuntu":
        release_key = _normalize_ubuntu_release(version)
    elif distro_key == "buildroot":
        distro_key = "debian"
        release_key = _normalize_buildroot_release(version)
    if not release_key:
        return None

    arch_key = {
        "aarch64": "arm64",
        "arm64": "arm64",
        "armv8": "arm64",
        "armv8l": "armhf",
        "armv7l": "armhf",
        # ARMv6 (Pi Zero W / 1) must never fall back to armhf: those artifacts
        # are built for ARMv7 and SIGILL on ARM1176.
        "armv6l": "armv6",
        "armv6": "armv6",
        "armhf": "armhf",
        "x86_64": "amd64",
        "amd64": "amd64",
    }.get((arch or "").lower())
    if not arch_key:
        return None

    return f"{distro_key}-{release_key}-{arch_key}"


__all__ = [
    "PrebuiltEntry",
    "fetch_prebuilt_manifest",
    "resolve_prebuilt_target",
]
