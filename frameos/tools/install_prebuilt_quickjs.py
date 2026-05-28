#!/usr/bin/env python3
"""Install a prebuilt QuickJS component for local FrameOS builds."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import shutil
import sys
import tarfile
import tempfile
import urllib.parse
import urllib.request
from pathlib import Path

QUICKJS_VERSION = os.environ.get("QUICKJS_VERSION", "2025-04-26")
ARCHIVE_BASE_URL = os.environ.get("FRAMEOS_ARCHIVE_BASE_URL", "https://archive.frameos.net/")
MANIFEST_PATH = "prebuilt-deps/manifest.json"
TIMEOUT = float(os.environ.get("FRAMEOS_PREBUILT_TIMEOUT", "20"))
USE_REMOTE_MANIFEST = os.environ.get("FRAMEOS_PREBUILT_USE_REMOTE", "").lower() in {
    "1",
    "true",
    "yes",
}

FRAMEOS_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = FRAMEOS_DIR.parent
LOCAL_MANIFEST_FILE = REPO_ROOT / "tools" / "prebuilt-deps" / "manifest.json"
HTTP_HEADERS = {"User-Agent": "FrameOS prebuilt-deps/1.0"}

DEBIAN_VERSION_IDS = {
    "10": "buster",
    "11": "bullseye",
    "12": "bookworm",
    "13": "trixie",
}


def normalize_base(url: str) -> str:
    return url if url.endswith("/") else f"{url}/"


def parse_os_release(path: Path = Path("/etc/os-release")) -> dict[str, str]:
    if not path.exists():
        return {}
    values: dict[str, str] = {}
    for raw_line in path.read_text().splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key] = value.strip().strip('"')
    return values


def detect_linux_release(
    os_release_path: Path = Path("/etc/os-release"),
    rpi_issue_path: Path = Path("/etc/rpi-issue"),
) -> tuple[str, str] | None:
    values = parse_os_release(os_release_path)
    distro = (values.get("ID") or "").lower()
    if not distro:
        return None

    if distro == "raspbian" or rpi_issue_path.exists():
        distro = "raspios"

    if distro in {"debian", "raspios"}:
        version = (
            values.get("VERSION_CODENAME")
            or values.get("DEBIAN_CODENAME")
            or DEBIAN_VERSION_IDS.get(values.get("VERSION_ID", ""))
            or ""
        )
        return distro, version

    if distro == "ubuntu":
        version = values.get("VERSION_ID") or values.get("VERSION_CODENAME") or ""
        return distro, version

    return distro, values.get("VERSION_ID") or values.get("VERSION_CODENAME") or ""


def normalize_ubuntu_release(version: str) -> str | None:
    release = (version or "").lower().strip().replace("lts", "").strip()
    if release.startswith("22.04") or release.startswith("jammy"):
        return "22.04"
    if release.startswith("24.04") or release.startswith("noble"):
        return "24.04"
    if release.startswith("26.04") or release.startswith("resolute"):
        return "26.04"
    return None


def normalize_arch(arch: str) -> str | None:
    return {
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


def resolve_prebuilt_target(distro: str, version: str, arch: str) -> str | None:
    distro_key = {
        "raspios": "debian",
        "pios": "debian",
        "debian": "debian",
        "ubuntu": "ubuntu",
    }.get((distro or "").lower())
    if not distro_key:
        return None

    release_key: str | None = None
    release = (version or "").lower()
    if distro_key == "debian" and release in {"buster", "bullseye", "bookworm", "trixie"}:
        release_key = release
    elif distro_key == "ubuntu":
        release_key = normalize_ubuntu_release(version)
    if not release_key:
        return None

    arch_key = normalize_arch(arch)
    if not arch_key:
        return None

    return f"{distro_key}-{release_key}-{arch_key}"


def detect_prebuilt_target() -> str | None:
    if platform.system().lower() != "linux":
        return None
    release = detect_linux_release()
    if not release:
        return None
    distro, version = release
    return resolve_prebuilt_target(distro, version, platform.machine())


def manifest_file_override() -> Path | None:
    override = os.environ.get("FRAMEOS_PREBUILT_MANIFEST_FILE")
    if override:
        candidate = Path(override)
        if candidate.is_file():
            return candidate
    if not USE_REMOTE_MANIFEST and LOCAL_MANIFEST_FILE.is_file():
        return LOCAL_MANIFEST_FILE
    return None


def entries_from_payload(payload: dict, base_url: str) -> dict[str, dict]:
    entries: dict[str, dict] = {}
    base = normalize_base(base_url)
    for entry in payload.get("entries", []):
        target = entry.get("target")
        if not target:
            continue
        component_urls = {}
        for component, key in (entry.get("component_keys") or {}).items():
            if key:
                component_urls[component] = urllib.parse.urljoin(base, key)
        entries[target] = {
            "target": target,
            "versions": entry.get("versions") or {},
            "component_urls": component_urls,
            "component_md5s": entry.get("component_md5sums") or {},
        }
    return entries


def load_manifest(
    *,
    base_url: str,
    manifest_file: Path | None = None,
    timeout: float = TIMEOUT,
) -> dict[str, dict]:
    source_file = manifest_file or manifest_file_override()
    if source_file:
        payload = json.loads(source_file.read_text())
        return entries_from_payload(payload, base_url)

    manifest_url = urllib.parse.urljoin(normalize_base(base_url), MANIFEST_PATH)
    request = urllib.request.Request(manifest_url, headers=HTTP_HEADERS)
    with urllib.request.urlopen(request, timeout=timeout) as response:
        payload = json.loads(response.read().decode("utf-8"))
    return entries_from_payload(payload, base_url)


def file_md5sum(path: Path) -> str:
    hasher = hashlib.md5()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            hasher.update(chunk)
    return hasher.hexdigest()


def download_file(url: str, dest: Path, *, expected_md5: str | None, timeout: float) -> None:
    request = urllib.request.Request(url, headers=HTTP_HEADERS)
    with urllib.request.urlopen(request, timeout=timeout) as response, dest.open("wb") as output:
        while True:
            chunk = response.read(1024 * 1024)
            if not chunk:
                break
            output.write(chunk)

    if expected_md5 and "-" not in expected_md5:
        actual_md5 = file_md5sum(dest)
        if actual_md5 != expected_md5:
            raise RuntimeError(f"MD5 mismatch for {url}: expected {expected_md5}, got {actual_md5}")


def safe_extract(tar: tarfile.TarFile, path: Path) -> None:
    root = str(path.resolve())
    for member in tar.getmembers():
        member_path = str((path / member.name).resolve())
        if os.path.commonpath([root, member_path]) != root:
            raise RuntimeError("Tar file attempted to escape target directory")
    try:
        tar.extractall(path=path, filter="data")
    except TypeError:
        tar.extractall(path=path)


def normalize_component_dir(dest_dir: Path) -> None:
    entries = [path for path in dest_dir.iterdir() if path.name != ".build-info"]
    subdirs = [path for path in entries if path.is_dir()]
    files = [path for path in entries if path.is_file()]
    if files or len(subdirs) != 1:
        return
    inner = subdirs[0]
    for child in inner.iterdir():
        shutil.move(str(child), dest_dir / child.name)
    shutil.rmtree(inner)


def first_file_match(root: Path, pattern: str) -> Path | None:
    matches = sorted(root.rglob(pattern))
    return matches[0] if matches else None


def quickjs_include_dir(root: Path) -> Path | None:
    direct = root / "include" / "quickjs"
    if direct.exists():
        return direct
    candidates = sorted(
        path
        for path in root.rglob("quickjs")
        if path.is_dir() and (path / "quickjs.h").exists()
    )
    return candidates[0] if candidates else None


def install_quickjs_component(
    extracted_dir: Path,
    dest: Path,
    *,
    version: str,
    source_url: str,
    force: bool = False,
) -> None:
    normalize_component_dir(extracted_dir)
    header = first_file_match(extracted_dir, "quickjs.h")
    libc_header = first_file_match(extracted_dir, "quickjs-libc.h")
    libquickjs = first_file_match(extracted_dir, "libquickjs.a")
    if not header or not libc_header or not libquickjs:
        raise RuntimeError("downloaded QuickJS component is missing headers or libquickjs.a")

    if dest.exists():
        if not force:
            raise FileExistsError(f"{dest} already exists")
        shutil.rmtree(dest)

    tmp_dest = dest.parent / f".{dest.name}.prebuilt-{os.getpid()}"
    if tmp_dest.exists():
        shutil.rmtree(tmp_dest)

    try:
        tmp_dest.mkdir(parents=True)
        include_target = tmp_dest / "include" / "quickjs"
        include_target.mkdir(parents=True)

        include_src = quickjs_include_dir(extracted_dir)
        if include_src:
            shutil.copytree(include_src, include_target, dirs_exist_ok=True)
            for include_header in sorted(include_src.glob("*.h")):
                shutil.copy2(include_header, tmp_dest / include_header.name)

        for required_header in (header, libc_header):
            shutil.copy2(required_header, tmp_dest / required_header.name)
            shutil.copy2(required_header, include_target / required_header.name)

        shutil.copy2(libquickjs, tmp_dest / "libquickjs.a")
        lib_target = tmp_dest / "lib"
        lib_target.mkdir()
        shutil.copy2(libquickjs, lib_target / "libquickjs.a")
        (tmp_dest / "VERSION").write_text(f"{version}\n")
        (tmp_dest / ".build-info").write_text(
            f"quickjs|{version}|{source_url}\n"
        )

        shutil.move(str(tmp_dest), dest)
    finally:
        shutil.rmtree(tmp_dest, ignore_errors=True)


def install_prebuilt_quickjs(
    *,
    dest: Path,
    target: str | None = None,
    base_url: str = ARCHIVE_BASE_URL,
    manifest_file: Path | None = None,
    version: str = QUICKJS_VERSION,
    timeout: float = TIMEOUT,
    force: bool = False,
) -> bool:
    if dest.exists() and not force:
        print(f"QuickJS directory already exists at {dest}, skipping prebuilt install.")
        return True

    resolved_target = target or detect_prebuilt_target()
    if not resolved_target:
        print("No matching prebuilt QuickJS target for this platform.")
        return False

    manifest = load_manifest(base_url=base_url, manifest_file=manifest_file, timeout=timeout)
    entry = manifest.get(resolved_target)
    if not entry:
        print(f"No prebuilt QuickJS entry published for {resolved_target}.")
        return False

    component_version = (entry["versions"].get("quickjs") or "").strip()
    if component_version != version:
        print(
            f"Prebuilt QuickJS version mismatch for {resolved_target}: "
            f"need {version}, manifest has {component_version or 'none'}."
        )
        return False

    url = entry["component_urls"].get("quickjs")
    if not url:
        print(f"No prebuilt QuickJS archive URL published for {resolved_target}.")
        return False

    with tempfile.TemporaryDirectory(prefix="frameos-quickjs-") as tmp:
        tmp_root = Path(tmp)
        archive_path = tmp_root / "quickjs.tar.gz"
        extract_dir = tmp_root / "extract"
        extract_dir.mkdir()

        print(f"Downloading prebuilt QuickJS {component_version} for {resolved_target}...")
        download_file(
            url,
            archive_path,
            expected_md5=entry["component_md5s"].get("quickjs"),
            timeout=timeout,
        )
        with tarfile.open(archive_path, "r:gz") as tar:
            safe_extract(tar, extract_dir)
        install_quickjs_component(
            extract_dir,
            dest,
            version=component_version,
            source_url=url,
            force=force,
        )

    print(f"Installed prebuilt QuickJS at {dest}.")
    return True


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dest", type=Path, default=FRAMEOS_DIR / "quickjs")
    parser.add_argument("--target", help="Override target, e.g. debian-bookworm-amd64")
    parser.add_argument("--base-url", default=ARCHIVE_BASE_URL)
    parser.add_argument("--manifest-file", type=Path)
    parser.add_argument("--version", default=QUICKJS_VERSION)
    parser.add_argument("--timeout", type=float, default=TIMEOUT)
    parser.add_argument("--force", action="store_true")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        installed = install_prebuilt_quickjs(
            dest=args.dest,
            target=args.target,
            base_url=args.base_url,
            manifest_file=args.manifest_file,
            version=args.version,
            timeout=args.timeout,
            force=args.force,
        )
    except Exception as exc:
        print(f"Prebuilt QuickJS install failed: {exc}", file=sys.stderr)
        return 2
    return 0 if installed else 2


if __name__ == "__main__":
    raise SystemExit(main())
