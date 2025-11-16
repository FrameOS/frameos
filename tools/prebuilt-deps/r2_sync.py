#!/usr/bin/env python3
"""Cloudflare R2 sync helper for prebuilt dependencies.

The script uploads/downlods the tarball archives produced by
``tools/prebuilt-deps/build.sh`` and can orchestrate a full sync cycle
that downloads whatever exists in the ``frameos-archive`` bucket,
rebuilds the missing targets and publishes them back to R2.

It intentionally mirrors the defaults from ``build.sh`` so the two stay
in lock-step.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

import boto3
from botocore.exceptions import ClientError


REPO_ROOT = Path(__file__).resolve().parents[2]
BUILD_DIR = REPO_ROOT / "build" / "prebuilt-deps"


def load_env_file() -> Optional[Path]:
    """Populate os.environ with values from a .env file if present."""

    def apply_env(path: Path) -> bool:
        if not path or not path.is_file():
            return False
        for raw_line in path.read_text().splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#"):
                continue
            if "=" not in line:
                continue
            key, value = line.split("=", 1)
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            if key and key not in os.environ:
                os.environ[key] = value
        return True

    candidates: Sequence[Path] = []
    env_override = os.environ.get("R2_ENV_FILE")
    if env_override:
        candidates = [Path(env_override).expanduser()]
    else:
        script_dir = Path(__file__).resolve().parent
        candidates = [
            Path.cwd() / ".env",
            script_dir / ".env",
            REPO_ROOT / ".env",
        ]

    for candidate in candidates:
        if apply_env(candidate):
            return candidate
    return None


load_env_file()

DEFAULT_BUCKET = os.environ.get("R2_BUCKET", "frameos-archive")
DEFAULT_PREFIX = os.environ.get("R2_PREFIX", "prebuilt-deps")

# Keep the target matrix in sync with tools/prebuilt-deps/build.sh
DEFAULT_TARGETS = [
    "debian-bookworm-armhf",
    "debian-bookworm-arm64",
    "debian-trixie-armhf",
    "debian-trixie-arm64",
    "ubuntu-22.04-armhf",
    "ubuntu-22.04-arm64",
    "ubuntu-22.04-amd64",
    "ubuntu-24.04-armhf",
    "ubuntu-24.04-arm64",
    "ubuntu-24.04-amd64",
]
COMPONENTS = ["quickjs", "lgpio"]
TARGET_PLATFORMS = {
    "armhf": "linux/arm/v7",
    "arm64": "linux/arm64",
    "amd64": "linux/amd64",
}


@dataclass
class ManifestEntry:
    target: str
    versions: Dict[str, str]
    object_key: Optional[str]
    metadata_key: Optional[str] = None
    updated_at: str = ""
    component_keys: Optional[Dict[str, str]] = None

    @classmethod
    def from_dict(cls, data: Dict[str, str]) -> "ManifestEntry":
        return cls(
            target=data["target"],
            versions=data.get("versions", {}),
            object_key=data.get("object_key"),
            metadata_key=data.get("metadata_key"),
            updated_at=data.get("updated_at", ""),
            component_keys=data.get("component_keys"),
        )

    def to_dict(self) -> Dict[str, str]:
        data = {
            "target": self.target,
            "versions": self.versions,
            "object_key": self.object_key,
            "updated_at": self.updated_at,
            "component_keys": self.component_keys,
        }
        if self.metadata_key:
            data["metadata_key"] = self.metadata_key
        return data


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bucket", default=DEFAULT_BUCKET, help="R2 bucket name")
    parser.add_argument(
        "--prefix", default=DEFAULT_PREFIX, help="Key prefix inside the bucket"
    )
    parser.add_argument(
        "--manifest-key",
        default=None,
        help="Manifest object key relative to the bucket",
    )
    parser.add_argument(
        "--build-script",
        default=str(REPO_ROOT / "tools" / "prebuilt-deps" / "build.sh"),
        help="Path to the build.sh helper",
    )
    parser.add_argument(
        "--targets",
        nargs="*",
        help=(
            "Targets to operate on (defaults to the same matrix as build.sh). "
            "Examples: debian-bookworm-armhf debian-bookworm-arm64"
        ),
    )

    sub = parser.add_subparsers(dest="command", required=True)
    up = sub.add_parser("upload", help="Upload local builds to R2")
    up.add_argument("--force", action="store_true", help="Re-upload even if remote exists")

    down = sub.add_parser("download", help="Download archives from R2")
    down.add_argument(
        "--force",
        action="store_true",
        help="Always download/extract even if the local metadata matches",
    )

    sub.add_parser("list", help="List entries stored in the manifest")

    sync = sub.add_parser(
        "sync",
        help=(
            "Download everything from R2, rebuild the missing targets and upload the new archives"
        ),
    )
    sync.add_argument(
        "--skip-build",
        action="store_true",
        help="Only download existing archives, never invoke build.sh",
    )

    args = parser.parse_args()
    if not args.manifest_key:
        args.manifest_key = f"{args.prefix}/manifest.json"
    return args


def desired_targets(custom: Optional[Iterable[str]]) -> List[str]:
    if custom:
        return list(custom)
    return list(DEFAULT_TARGETS)


def target_distro_release_arch(target: str) -> Tuple[str, str, str]:
    parts = target.split("-")
    if len(parts) < 3:
        return "", "", ""
    distro = parts[0]
    arch = parts[-1]
    release = "-".join(parts[1:-1])
    return distro, release, arch


def s3_client():
    access_key = os.environ.get("R2_ACCESS_KEY_ID")
    secret_key = os.environ.get("R2_SECRET_ACCESS_KEY")
    if not access_key or not secret_key:
        print("R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY must be set", file=sys.stderr)
        sys.exit(1)

    endpoint = os.environ.get("R2_ENDPOINT")
    if not endpoint:
        account_id = os.environ.get("R2_ACCOUNT_ID")
        if not account_id:
            print("Set R2_ENDPOINT or R2_ACCOUNT_ID to point at your R2 account", file=sys.stderr)
            sys.exit(1)
        endpoint = f"https://{account_id}.r2.cloudflarestorage.com"

    session = boto3.session.Session()
    return session.client(
        "s3",
        endpoint_url=endpoint,
        aws_access_key_id=access_key,
        aws_secret_access_key=secret_key,
        region_name=os.environ.get("R2_REGION", "auto"),
    )


def package_identifier(metadata: Dict[str, str]) -> str:
    return (
        f"{metadata['target']}/"
        f"nim-{metadata['nim_version']}_"
        f"quickjs-{metadata['quickjs_version']}_"
        f"lgpio-{metadata['lgpio_version']}"
    )


def versions_from_metadata(metadata: Dict[str, str]) -> Dict[str, str]:
    return {
        "nim": metadata.get("nim_version", ""),
        "quickjs": metadata.get("quickjs_version", ""),
        "lgpio": metadata.get("lgpio_version", ""),
    }


def metadata_matches_entry(metadata: Dict[str, str], entry: ManifestEntry) -> bool:
    if metadata.get("target") != entry.target:
        return False
    for key, version in entry.versions.items():
        if metadata.get(f"{key}_version") != version:
            return False
    return True


def component_version(metadata: Dict[str, str], component: str) -> Optional[str]:
    return metadata.get(f"{component}_version")


def component_dir(target_dir: Path, component: str, version: str) -> Path:
    return target_dir / f"{component}-{version}"


def component_object_key(prefix: str, target: str, component: str, version: str) -> str:
    return f"{prefix}/{target}/{component}-{version}.tar.gz"


def write_local_metadata(entry: ManifestEntry, target_dir: Path) -> None:
    distro, release, arch = target_distro_release_arch(entry.target)
    platform = TARGET_PLATFORMS.get(arch, "")
    payload = {
        "target": entry.target,
        "distribution": distro,
        "release": release,
        "arch": arch,
        "platform": platform,
        "nim_version": entry.versions.get("nim", ""),
        "quickjs_version": entry.versions.get("quickjs", ""),
        "lgpio_version": entry.versions.get("lgpio", ""),
    }
    target_dir.mkdir(parents=True, exist_ok=True)
    target_file = target_dir / "metadata.json"
    target_file.write_text(json.dumps(payload, indent=2) + "\n")


def load_manifest(client, bucket: str, manifest_key: str) -> Dict[str, List[ManifestEntry]]:
    try:
        response = client.get_object(Bucket=bucket, Key=manifest_key)
    except ClientError as exc:
        if exc.response["Error"].get("Code") in {"NoSuchKey", "404"}:
            return {}
        raise
    payload = json.loads(response["Body"].read().decode("utf-8"))
    entries = {}
    for data in payload.get("entries", []):
        entry = ManifestEntry.from_dict(data)
        entries.setdefault(entry.target, []).append(entry)
    return entries


def save_manifest(client, bucket: str, manifest_key: str, entries: Dict[str, List[ManifestEntry]]):
    flat: List[Dict[str, str]] = []
    for entry_list in entries.values():
        for entry in entry_list:
            flat.append(entry.to_dict())
    body = json.dumps({"entries": flat}, indent=2).encode("utf-8")
    client.put_object(Bucket=bucket, Key=manifest_key, Body=body, ContentType="application/json")


def latest_entries(entries: Dict[str, List[ManifestEntry]]) -> Dict[str, ManifestEntry]:
    latest: Dict[str, ManifestEntry] = {}
    for target, options in entries.items():
        latest[target] = max(options, key=lambda e: e.updated_at)
    return latest


def iter_local_targets() -> List[Path]:
    if not BUILD_DIR.exists():
        return []
    return [
        path
        for path in BUILD_DIR.iterdir()
        if path.is_dir() and (path / "metadata.json").exists()
    ]


def read_local_metadata(target_dir: Path) -> Optional[Dict[str, str]]:
    metadata_file = target_dir / "metadata.json"
    if not metadata_file.exists():
        return None
    return json.loads(metadata_file.read_text())


def make_tarball(source_dir: Path, identifier: str, component: str) -> Path:
    temp_fd, temp_path = tempfile.mkstemp(
        prefix=f"{identifier.replace('/', '_')}_{component}_",
        suffix=".tar.gz",
    )
    os.close(temp_fd)
    with tarfile.open(temp_path, "w:gz") as tar:
        tar.add(source_dir, arcname=source_dir.name)
    return Path(temp_path)


def upload_target(
    client,
    bucket: str,
    prefix: str,
    manifest: Dict[str, List[ManifestEntry]],
    target_dir: Path,
    force: bool = False,
):
    metadata = read_local_metadata(target_dir)
    if not metadata:
        print(f"Skipping {target_dir.name}: metadata.json missing", file=sys.stderr)
        return

    identifier = package_identifier(metadata)
    component_keys: Dict[str, str] = {}
    components_to_upload = []
    for component in COMPONENTS:
        version = component_version(metadata, component)
        if not version:
            print(
                f"Skipping {target_dir.name}: {component}_version missing in metadata",
                file=sys.stderr,
            )
            return
        comp_dir = component_dir(target_dir, component, version)
        if not comp_dir.exists():
            print(
                f"Skipping {target_dir.name}: directory {comp_dir.name} not found",
                file=sys.stderr,
            )
            return
        build_info_file = comp_dir / ".build-info"
        if not build_info_file.is_file():
            print(
                f"Skipping {target_dir.name}: {comp_dir.name} missing .build-info",
                file=sys.stderr,
            )
            return
        object_key = component_object_key(prefix, metadata["target"], component, version)
        component_keys[component] = object_key
        needs_upload = True
        if not force:
            try:
                client.head_object(Bucket=bucket, Key=object_key)
                needs_upload = False
            except ClientError as exc:
                if exc.response["Error"].get("Code") not in {"404", "NoSuchKey"}:
                    raise
        if needs_upload:
            components_to_upload.append((component, comp_dir, object_key))

    if not components_to_upload and not force:
        print(
            f"Remote already has all components for {target_dir.name}, skipping upload",
        )
        return

    tarballs: List[Path] = []
    try:
        for component, comp_dir, object_key in components_to_upload or []:
            tarball = make_tarball(comp_dir, identifier, component)
            tarballs.append(tarball)
            client.upload_file(
                Filename=str(tarball),
                Bucket=bucket,
                Key=object_key,
                ExtraArgs={"ContentType": "application/gzip"},
            )
            print(f"Uploaded {comp_dir.name} -> s3://{bucket}/{object_key}")

        entry = ManifestEntry(
            target=metadata["target"],
            versions=versions_from_metadata(metadata),
            object_key=None,
            updated_at=datetime.now(timezone.utc).isoformat(),
            component_keys=component_keys,
        )
        manifest[entry.target] = [entry]
    finally:
        for tarball in tarballs:
            tarball.unlink(missing_ok=True)


def safe_extract(tar: tarfile.TarFile, path: Path) -> None:
    def is_within_directory(directory: Path, target: Path) -> bool:
        try:
            target.relative_to(directory)
            return True
        except ValueError:
            return False

    for member in tar.getmembers():
        member_path = path / member.name
        if not is_within_directory(path, member_path.resolve()):
            raise RuntimeError("Tar file attempted to escape target directory")
    tar.extractall(path=path)


def download_component_tarball(
    client,
    bucket: str,
    key: str,
    target_dir: Path,
):
    tmp_fd, tmp_path = tempfile.mkstemp(suffix=".tar.gz")
    os.close(tmp_fd)
    try:
        client.download_file(bucket, key, tmp_path)
        with tarfile.open(tmp_path, "r:gz") as tar:
            safe_extract(tar, target_dir)
    finally:
        Path(tmp_path).unlink(missing_ok=True)


def download_entry(
    client,
    bucket: str,
    entry: ManifestEntry,
    force: bool = False,
):
    target_dir = BUILD_DIR / entry.target
    local_meta = read_local_metadata(target_dir)
    if local_meta and metadata_matches_entry(local_meta, entry) and not force:
        version_summary = ", ".join(f"{k}={v}" for k, v in entry.versions.items())
        print(f"{entry.target} already matches ({version_summary}), skipping download")
        return

    if entry.component_keys:
        if target_dir.exists():
            shutil.rmtree(target_dir)
        target_dir.mkdir(parents=True, exist_ok=True)
        for component, key in sorted(entry.component_keys.items()):
            download_component_tarball(client, bucket, key, target_dir)
        write_local_metadata(entry, target_dir)
        print(f"Downloaded {entry.target} components -> {target_dir}")
        return

    tmp_fd, tmp_path = tempfile.mkstemp(suffix=".tar.gz")
    os.close(tmp_fd)
    try:
        client.download_file(bucket, entry.object_key, tmp_path)
        if target_dir.exists():
            shutil.rmtree(target_dir)
        BUILD_DIR.mkdir(parents=True, exist_ok=True)
        with tarfile.open(tmp_path, "r:gz") as tar:
            safe_extract(tar, BUILD_DIR)
        write_local_metadata(entry, target_dir)
        print(f"Downloaded {entry.target} -> {target_dir}")
    finally:
        Path(tmp_path).unlink(missing_ok=True)


def list_entries(entries: Dict[str, List[ManifestEntry]]):
    if not entries:
        print("Manifest is empty")
        return
    for target in sorted(entries):
        for entry in sorted(entries[target], key=lambda e: e.updated_at, reverse=True):
            versions = ", ".join(f"{k}={v}" for k, v in entry.versions.items())
            if entry.component_keys:
                destinations = ", ".join(
                    f"{component}={key}"
                    for component, key in sorted(entry.component_keys.items())
                )
            else:
                destinations = entry.object_key or ""
            print(f"{target}: ({versions}) -> {destinations}")


def ensure_build(targets: List[str], build_script: str):
    if not targets:
        return
    cmd = [build_script, *targets]
    print("Running", " ".join(cmd))
    subprocess.run(cmd, cwd=REPO_ROOT, check=True)


def command_upload(args):
    client = s3_client()
    manifest = load_manifest(client, args.bucket, args.manifest_key)
    targets = desired_targets(args.targets)
    for target_dir in iter_local_targets():
        if target_dir.name not in targets:
            continue
        upload_target(client, args.bucket, args.prefix, manifest, target_dir, force=args.force)
    save_manifest(client, args.bucket, args.manifest_key, manifest)


def command_download(args):
    client = s3_client()
    manifest = load_manifest(client, args.bucket, args.manifest_key)
    latest = latest_entries(manifest)
    targets = desired_targets(args.targets)
    for target in targets:
        entry = latest.get(target)
        if not entry:
            print(f"No manifest entry for {target}")
            continue
        download_entry(client, args.bucket, entry, force=args.force)


def command_list(args):
    client = s3_client()
    manifest = load_manifest(client, args.bucket, args.manifest_key)
    list_entries(manifest)


def command_sync(args):
    targets = desired_targets(args.targets)
    client = s3_client()
    manifest = load_manifest(client, args.bucket, args.manifest_key)
    latest = latest_entries(manifest)

    for target in targets:
        entry = latest.get(target)
        if entry:
            download_entry(client, args.bucket, entry)
        else:
            print(f"No remote archive for {target}")

    missing = [t for t in targets if not (BUILD_DIR / t / "metadata.json").exists()]
    if missing and args.skip_build:
        print("Some targets are still missing locally but --skip-build was passed:", missing)
        return

    ensure_build(missing, args.build_script)

    manifest = load_manifest(client, args.bucket, args.manifest_key)
    to_upload = set(missing)
    for target_dir in iter_local_targets() or []:
        if target_dir.name in to_upload:
            upload_target(client, args.bucket, args.prefix, manifest, target_dir, force=False)
    if to_upload:
        save_manifest(client, args.bucket, args.manifest_key, manifest)


def main() -> int:
    args = parse_args()
    if args.command == "upload":
        command_upload(args)
    elif args.command == "download":
        command_download(args)
    elif args.command == "list":
        command_list(args)
    elif args.command == "sync":
        command_sync(args)
    else:
        raise SystemExit(f"Unknown command {args.command}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
