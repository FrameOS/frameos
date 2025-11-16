"""Helpers for discovering prebuilt dependency archives."""

from __future__ import annotations

import asyncio
import json
import os
from dataclasses import dataclass
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

    def url_for(self, component: str) -> str | None:
        return self.component_urls.get(component)

    def version_for(self, component: str, default: str | None = None) -> str | None:
        return self.versions.get(component) or default

    def md5_for(self, component: str) -> str | None:
        return self.component_md5s.get(component)


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
    return None


def resolve_prebuilt_target(distro: str, version: str, arch: str) -> str | None:
    distro_input = (distro or "").lower()
    distro_key = {
        "raspios": "debian",
        "pios": "debian",
        "debian": "debian",
        "ubuntu": "ubuntu",
    }.get(distro_input)
    if not distro_key:
        return None

    release_key: str | None = None
    release = (version or "").lower()
    if distro_key == "debian":
        allowed = {"buster", "bookworm", "trixie"}
        if release in allowed:
            release_key = release
    elif distro_key == "ubuntu":
        release_key = _normalize_ubuntu_release(version)
    if not release_key:
        return None

    arch_key = {
        "aarch64": "arm64",
        "arm64": "arm64",
        "armv8": "arm64",
        "armv8l": "armhf",
        "armv7l": "armhf",
        "armv6l": "armhf",
        "armhf": "armhf",
        "x86_64": "amd64",
        "amd64": "amd64",
    }.get((arch or "").lower())
    if not arch_key:
        return None

    if distro_key == "debian" and arch_key == "amd64":
        return None

    return f"{distro_key}-{release_key}-{arch_key}"


__all__ = [
    "PrebuiltEntry",
    "fetch_prebuilt_manifest",
    "resolve_prebuilt_target",
]
