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
from typing import Dict, Iterable, List, Optional

import boto3
from botocore.exceptions import ClientError


REPO_ROOT = Path(__file__).resolve().parents[2]
BUILD_DIR = REPO_ROOT / "build" / "prebuilt-deps"

DEFAULT_BUCKET = os.environ.get("R2_BUCKET", "frameos-archive")
DEFAULT_PREFIX = os.environ.get("R2_PREFIX", "prebuilt-deps")

# Keep the target matrix in sync with tools/prebuilt-deps/build.sh
RELEASES = ["bookworm", "trixie"]
ARCHES = ["armhf", "arm64"]


@dataclass
class ManifestEntry:
    target: str
    slug: str
    versions: Dict[str, str]
    object_key: str
    metadata_key: str
    updated_at: str

    @classmethod
    def from_dict(cls, data: Dict[str, str]) -> "ManifestEntry":
        return cls(
            target=data["target"],
            slug=data["slug"],
            versions=data["versions"],
            object_key=data["object_key"],
            metadata_key=data["metadata_key"],
            updated_at=data.get("updated_at", ""),
        )

    def to_dict(self) -> Dict[str, str]:
        return {
            "target": self.target,
            "slug": self.slug,
            "versions": self.versions,
            "object_key": self.object_key,
            "metadata_key": self.metadata_key,
            "updated_at": self.updated_at,
        }


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
            "Examples: pios-bookworm-armhf pios-bookworm-arm64"
        ),
    )

    sub = parser.add_subparsers(dest="command", required=True)
    up = sub.add_parser("upload", help="Upload local builds to R2")
    up.add_argument("--force", action="store_true", help="Re-upload even if remote exists")

    down = sub.add_parser("download", help="Download archives from R2")
    down.add_argument(
        "--force",
        action="store_true",
        help="Always download/extract even if the local slug matches",
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
    targets: List[str] = []
    for release in RELEASES:
        for arch in ARCHES:
            targets.append(f"pios-{release}-{arch}")
    return targets


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


def slug_from_metadata(metadata: Dict[str, str]) -> str:
    return (
        f"{metadata['target']}/"
        f"nim-{metadata['nim_version']}_"
        f"quickjs-{metadata['quickjs_version']}_"
        f"lgpio-{metadata['lgpio_version']}"
    )


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


def make_tarball(target_dir: Path, slug: str) -> Path:
    temp_fd, temp_path = tempfile.mkstemp(prefix=slug.replace("/", "_") + "_", suffix=".tar.gz")
    os.close(temp_fd)
    with tarfile.open(temp_path, "w:gz") as tar:
        tar.add(target_dir, arcname=target_dir.name)
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

    slug = slug_from_metadata(metadata)
    object_key = f"{prefix}/{slug}/prebuilt.tar.gz"
    metadata_key = f"{prefix}/{slug}/metadata.json"

    if not force:
        try:
            client.head_object(Bucket=bucket, Key=object_key)
            print(f"Remote already has {object_key}, skipping upload")
            return
        except ClientError as exc:
            if exc.response["Error"].get("Code") not in {"404", "NoSuchKey"}:
                raise

    tarball = make_tarball(target_dir, slug)
    try:
        client.upload_file(
            Filename=str(tarball),
            Bucket=bucket,
            Key=object_key,
            ExtraArgs={"ContentType": "application/gzip"},
        )
        client.upload_file(
            Filename=str(target_dir / "metadata.json"),
            Bucket=bucket,
            Key=metadata_key,
            ExtraArgs={"ContentType": "application/json"},
        )
        entry = ManifestEntry(
            target=metadata["target"],
            slug=slug,
            versions={
                "nim": metadata["nim_version"],
                "quickjs": metadata["quickjs_version"],
                "lgpio": metadata["lgpio_version"],
            },
            object_key=object_key,
            metadata_key=metadata_key,
            updated_at=datetime.now(timezone.utc).isoformat(),
        )
        manifest.setdefault(entry.target, [])
        manifest[entry.target] = [
            *[e for e in manifest[entry.target] if e.slug != entry.slug],
            entry,
        ]
        print(f"Uploaded {target_dir.name} -> s3://{bucket}/{object_key}")
    finally:
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


def download_entry(
    client,
    bucket: str,
    entry: ManifestEntry,
    force: bool = False,
):
    target_dir = BUILD_DIR / entry.target
    local_meta = read_local_metadata(target_dir)
    if local_meta and slug_from_metadata(local_meta) == entry.slug and not force:
        print(f"{entry.target} already matches {entry.slug}, skipping download")
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
            print(f"{target}: {entry.slug} ({versions}) -> {entry.object_key}")


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
