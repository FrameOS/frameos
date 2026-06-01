#!/usr/bin/env python3
"""Build and publish cached Buildroot base SD images for FrameOS."""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import boto3
from botocore.exceptions import ClientError

REPO_ROOT = Path(__file__).resolve().parents[2]
BACKEND_ROOT = REPO_ROOT / "backend"
sys.path.insert(0, str(BACKEND_ROOT))

from app.tasks.buildroot_image import (  # noqa: E402
    BUILDROOT_ASSETS_PARTITION_SIZE,
    BUILDROOT_DEFCONFIG,
    BUILDROOT_DOCKER_APT_DEPS_LINE,
    BUILDROOT_DOCKER_IMAGE,
    BUILDROOT_DOCKER_NOFILE_LIMIT,
    BUILDROOT_FRAMEOS_PARTITION_SIZE,
    BUILDROOT_VERSION,
    BuildrootImageBuilder,
    SUPPORTED_BUILDROOT_PLATFORM,
    _mbr_partitions,
    copy_lgpio_runtime_libraries,
)
from app.tasks.setup_json_reset import (  # noqa: E402
    SETUP_JSON_RESET_SCRIPT_PATH,
    SETUP_JSON_RESET_SERVICE_NAME,
    render_setup_json_reset_script,
    render_setup_json_reset_service,
)

BUILD_DIR = REPO_ROOT / "build" / "buildroot-images"
LOCAL_MANIFEST_PATH = REPO_ROOT / "tools" / "buildroot-images" / "manifest.json"
DEFAULT_BUCKET = os.environ.get("R2_BUCKET", "frameos-archive")
DEFAULT_PREFIX = os.environ.get("R2_PREFIX", "buildroot-images")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--platform", default=SUPPORTED_BUILDROOT_PLATFORM)
    parser.add_argument("--bucket", default=DEFAULT_BUCKET)
    parser.add_argument("--prefix", default=DEFAULT_PREFIX)
    parser.add_argument("--manifest-key", default=None)
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("build", help="Build the reusable base image locally")
    upload = sub.add_parser("upload", help="Upload a locally built base image to R2")
    upload.add_argument("-y", "--yes", action="store_true")
    upload.add_argument("--force", action="store_true")
    sub.add_parser("list", help="List manifest entries in R2")
    download = sub.add_parser("download", help="Download the manifest to the repo")
    download.add_argument("--force", action="store_true")
    args = parser.parse_args()
    if args.manifest_key is None:
        args.manifest_key = f"{args.prefix}/manifest.json"
    return args


def load_env_file() -> None:
    for path in (Path.cwd() / ".env", REPO_ROOT / ".env", Path(__file__).resolve().parent / ".env"):
        if not path.is_file():
            continue
        for raw_line in path.read_text(encoding="utf-8").splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))
        return


def s3_client():
    access_key = os.environ.get("R2_ACCESS_KEY_ID")
    secret_key = os.environ.get("R2_SECRET_ACCESS_KEY")
    if not access_key or not secret_key:
        raise SystemExit("R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY must be set")
    endpoint = os.environ.get("R2_ENDPOINT")
    if not endpoint:
        account_id = os.environ.get("R2_ACCOUNT_ID")
        if not account_id:
            raise SystemExit("Set R2_ENDPOINT or R2_ACCOUNT_ID")
        endpoint = f"https://{account_id}.r2.cloudflarestorage.com"
    return boto3.session.Session().client(
        "s3",
        endpoint_url=endpoint,
        aws_access_key_id=access_key,
        aws_secret_access_key=secret_key,
        region_name=os.environ.get("R2_REGION", "auto"),
    )


def frameos_version() -> str:
    payload = json.loads((REPO_ROOT / "versions.json").read_text(encoding="utf-8"))
    return published_frameos_version(str(payload.get("frameos") or ""))


def raw_frameos_version() -> str:
    payload = json.loads((REPO_ROOT / "versions.json").read_text(encoding="utf-8"))
    return str(payload.get("frameos") or "")


def published_frameos_version(version: str) -> str:
    return version.split("+", 1)[0]


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def build_inputs_digest(paths: list[Path]) -> str:
    digest = hashlib.sha256()
    for base_path in paths:
        if base_path.is_dir():
            entries = sorted(base_path.rglob("*"), key=lambda item: item.relative_to(base_path).as_posix())
        else:
            entries = [base_path]
        for path in entries:
            relpath = path.relative_to(base_path).as_posix() if base_path.is_dir() else path.name
            digest.update(relpath.encode("utf-8") + b"\0")
            if path.is_symlink():
                digest.update(b"symlink\0")
                digest.update(os.readlink(path).encode("utf-8") + b"\0")
            elif path.is_file():
                digest.update(b"file\0")
                digest.update(oct(path.stat().st_mode & 0o777).encode("ascii") + b"\0")
                digest.update(path.read_bytes())
            elif path.is_dir():
                digest.update(b"dir\0")
    return digest.hexdigest()


def safe_segment(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]+", "_", value)


def local_dir(platform: str) -> Path:
    return BUILD_DIR / platform / frameos_version()


def legacy_local_dir(platform: str) -> Path:
    return BUILD_DIR / platform / raw_frameos_version()


def write_base_bootstrap_overlay(overlay: Path) -> None:
    systemd = overlay / "etc" / "systemd" / "system"
    wants = systemd / "multi-user.target.wants"
    wants.mkdir(parents=True, exist_ok=True)
    script_path = overlay / SETUP_JSON_RESET_SCRIPT_PATH.lstrip("/")
    script_path.parent.mkdir(parents=True, exist_ok=True)
    script_path.write_text(render_setup_json_reset_script("/boot/frameos-setup.json"), encoding="utf-8")
    os.chmod(script_path, 0o755)
    (systemd / SETUP_JSON_RESET_SERVICE_NAME).write_text(
        render_setup_json_reset_service(
            "/boot/frameos-setup.json",
            script_path=SETUP_JSON_RESET_SCRIPT_PATH,
        ),
        encoding="utf-8",
    )
    for service in (SETUP_JSON_RESET_SERVICE_NAME,):
        link = wants / service
        if link.exists() or link.is_symlink():
            link.unlink()
        link.symlink_to(f"../{service}")
    for service in ("NetworkManager.service", "dropbear.service"):
        link = wants / service
        if link.exists() or link.is_symlink():
            link.unlink()
        link.symlink_to(f"/usr/lib/systemd/system/{service}")
    (overlay / "etc" / "NetworkManager" / "conf.d").mkdir(parents=True, exist_ok=True)
    (overlay / "etc" / "NetworkManager" / "conf.d" / "frameos.conf").write_text(
        "[main]\nplugins=keyfile\n\n[device]\nwifi.scan-rand-mac-address=no\n",
        encoding="utf-8",
    )
    (overlay / "etc" / "default").mkdir(parents=True, exist_ok=True)
    (overlay / "etc" / "default" / "dropbear").write_text('DROPBEAR_ARGS="-s -g"\n', encoding="utf-8")
    (overlay / "etc" / "fstab").write_text(
        "LABEL=BOOT /boot vfat defaults,noatime,umask=000 0 0\n"
        "LABEL=FRAMEOS /srv/frameos ext4 defaults,noatime 0 2\n"
        "LABEL=ASSETS /srv/assets vfat defaults,noatime,umask=000 0 0\n",
        encoding="utf-8",
    )
    (overlay / "etc" / "profile.d").mkdir(parents=True, exist_ok=True)
    (overlay / "etc" / "profile.d" / "frameos.sh").write_text(
        "export FRAMEOS_HOME=/srv/frameos/current\n",
        encoding="utf-8",
    )
    (overlay / "srv" / "frameos").mkdir(parents=True, exist_ok=True)
    (overlay / "srv" / "assets").mkdir(parents=True, exist_ok=True)
    copy_lgpio_runtime_libraries(overlay)


def build(args: argparse.Namespace) -> None:
    out_dir = local_dir(args.platform)
    out_dir.mkdir(parents=True, exist_ok=True)
    image_path = out_dir / "base.img"
    image_path.unlink(missing_ok=True)
    with tempfile.TemporaryDirectory(prefix="frameos-buildroot-base-") as tmp:
        tmp_path = Path(tmp)
        overlay = tmp_path / "overlay"
        write_base_bootstrap_overlay(overlay)
        BuildrootImageBuilder._write_buildroot_config(tmp_path / "frameos-buildroot.config")
        BuildrootImageBuilder._write_kernel_config_fragment(tmp_path / "linux-fragment.config")
        BuildrootImageBuilder._write_post_build_script(tmp_path / "post-build.sh")
        BuildrootImageBuilder._write_partition_post_build_script(tmp_path / "partition-post-build.sh")
        BuildrootImageBuilder._write_post_image_script(tmp_path / "post-image.sh")
        BuildrootImageBuilder._write_boot_logo(tmp_path / "frameos-boot-logo.png")
        BuildrootImageBuilder._write_build_script(tmp_path / "buildroot-build.sh", "base.img")
        container_name = f"frameos-buildroot-base-{uuid.uuid4().hex[:12]}"
        container_id = subprocess.check_output(
            [
                "docker",
                "create",
                "--name",
                container_name,
                "--ulimit",
                f"nofile={BUILDROOT_DOCKER_NOFILE_LIMIT}:{BUILDROOT_DOCKER_NOFILE_LIMIT}",
                "-e",
                "FORCE_UNSAFE_CONFIGURE=1",
                BUILDROOT_DOCKER_IMAGE,
                "bash",
                "/work/buildroot-build.sh",
            ],
            text=True,
        ).strip()
        try:
            subprocess.run(["docker", "cp", f"{tmp_path}/.", f"{container_id}:/work"], check=True)
            subprocess.run(["docker", "start", "--attach", container_id], check=True)
            subprocess.run(["docker", "cp", f"{container_id}:/artifacts/base.img", str(image_path)], check=True)
        finally:
            subprocess.run(["docker", "rm", "--force", container_id], check=False)
    metadata = {
        "platform": args.platform,
        "frameos_version": frameos_version(),
        "buildroot_version": BUILDROOT_VERSION,
        "defconfig": BUILDROOT_DEFCONFIG,
        "docker_image": BUILDROOT_DOCKER_IMAGE,
        "buildroot_apt_deps": BUILDROOT_DOCKER_APT_DEPS_LINE,
        "frameos_partition_size": BUILDROOT_FRAMEOS_PARTITION_SIZE,
        "assets_partition_size": BUILDROOT_ASSETS_PARTITION_SIZE,
        "sha256": sha256(image_path),
        "size": image_path.stat().st_size,
        "partitions": _mbr_partitions(image_path),
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    (out_dir / "metadata.json").write_text(json.dumps(metadata, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(f"Built {image_path}")


def load_manifest(client, bucket: str, key: str) -> dict[str, Any]:
    try:
        response = client.get_object(Bucket=bucket, Key=key)
    except ClientError as exc:
        if exc.response["Error"].get("Code") in {"NoSuchKey", "404"}:
            return {"entries": []}
        raise
    return json.loads(response["Body"].read().decode("utf-8"))


def save_manifest(client, bucket: str, key: str, manifest: dict[str, Any]) -> None:
    body = json.dumps(manifest, indent=2, sort_keys=True).encode("utf-8")
    client.put_object(Bucket=bucket, Key=key, Body=body, ContentType="application/json")
    LOCAL_MANIFEST_PATH.parent.mkdir(parents=True, exist_ok=True)
    LOCAL_MANIFEST_PATH.write_bytes(body)


def upload(args: argparse.Namespace) -> None:
    out_dir = local_dir(args.platform)
    if not (out_dir / "base.img").is_file() and legacy_local_dir(args.platform).is_dir():
        out_dir = legacy_local_dir(args.platform)
    image_path = out_dir / "base.img"
    metadata_path = out_dir / "metadata.json"
    if not image_path.is_file() or not metadata_path.is_file():
        raise SystemExit(f"Run build first; missing {image_path} or metadata.json")
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    metadata["frameos_version"] = published_frameos_version(str(metadata.get("frameos_version") or frameos_version()))
    archive_name = f"{args.platform}-{safe_segment(metadata['frameos_version'])}-{metadata['sha256'][:16]}.img.gz"
    object_key = f"{args.prefix}/{args.platform}/{metadata['frameos_version']}/{archive_name}"
    if not args.yes:
        raise SystemExit(f"Re-run with --yes to upload {object_key}")
    client = s3_client()
    entry = {**metadata, "object_key": object_key, "updated_at": datetime.now(timezone.utc).isoformat()}
    remote_exists = False
    if not args.force:
        try:
            client.head_object(Bucket=args.bucket, Key=object_key)
            remote_exists = True
        except ClientError as exc:
            if exc.response["Error"].get("Code") not in {"404", "NoSuchKey"}:
                raise
    if remote_exists:
        print(f"Remote already has s3://{args.bucket}/{object_key}")
    else:
        archive_path = out_dir / archive_name
        with image_path.open("rb") as source, archive_path.open("wb") as raw:
            with gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0) as output:
                shutil.copyfileobj(source, output)
        client.upload_file(str(archive_path), args.bucket, object_key, ExtraArgs={"ContentType": "application/gzip"})
        print(f"Uploaded s3://{args.bucket}/{object_key}")
    save_manifest(client, args.bucket, args.manifest_key, {"entries": [entry]})


def list_remote(args: argparse.Namespace) -> None:
    manifest = load_manifest(s3_client(), args.bucket, args.manifest_key)
    for entry in sorted(manifest.get("entries", []), key=lambda item: (item.get("platform", ""), item.get("updated_at", ""))):
        print(f"{entry.get('platform')} {entry.get('frameos_version')} {entry.get('object_key')}")


def download_manifest(args: argparse.Namespace) -> None:
    manifest = load_manifest(s3_client(), args.bucket, args.manifest_key)
    if LOCAL_MANIFEST_PATH.exists() and not args.force:
        raise SystemExit(f"{LOCAL_MANIFEST_PATH} exists; use --force to overwrite")
    LOCAL_MANIFEST_PATH.parent.mkdir(parents=True, exist_ok=True)
    LOCAL_MANIFEST_PATH.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(f"Wrote {LOCAL_MANIFEST_PATH}")


def main() -> None:
    load_env_file()
    args = parse_args()
    if args.command == "build":
        build(args)
    elif args.command == "upload":
        upload(args)
    elif args.command == "list":
        list_remote(args)
    elif args.command == "download":
        download_manifest(args)


if __name__ == "__main__":
    main()
