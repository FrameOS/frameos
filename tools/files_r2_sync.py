#!/usr/bin/env python3
"""Mirror the repository's files/ directory to Cloudflare R2."""

from __future__ import annotations

import argparse
import mimetypes
import os
import sys
from pathlib import Path, PurePosixPath
from typing import Dict, Iterable, Iterator, Optional

try:
    import boto3
except ImportError:  # pragma: no cover - dependency is optional until runtime
    boto3 = None


REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_FILES_DIR = REPO_ROOT / "files"


def load_env_file() -> Optional[Path]:
    """Populate os.environ with values from a .env file if present."""

    def apply_env(path: Path) -> bool:
        if not path.is_file():
            return False
        for raw_line in path.read_text().splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#"):
                continue
            if line.startswith("export "):
                line = line[len("export ") :].strip()
            if "=" not in line:
                continue
            key, value = line.split("=", 1)
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            if key and key not in os.environ:
                os.environ[key] = value
        return True

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


def env_value(*names: str, default: Optional[str] = None) -> Optional[str]:
    for name in names:
        value = os.environ.get(name)
        if value:
            return value
    return default


def require_env(*names: str) -> str:
    value = env_value(*names)
    if value:
        return value
    joined = " or ".join(names)
    raise SystemExit(f"{joined} must be set (directly or via .env)")


def normalized_prefix(raw_prefix: Optional[str]) -> str:
    return (raw_prefix or "").strip().strip("/")


def object_key(prefix: str, relative_path: Path) -> str:
    parts = [part for part in [prefix, relative_path.as_posix()] if part]
    return "/".join(parts)


def relative_key(prefix: str, key: str) -> str:
    clean_prefix = normalized_prefix(prefix)
    if clean_prefix:
        prefix_with_slash = f"{clean_prefix}/"
        if not key.startswith(prefix_with_slash):
            raise RuntimeError(f"Remote key {key} does not match prefix {clean_prefix}")
        return key[len(prefix_with_slash) :]
    return key


def safe_local_path(base_dir: Path, relative_key_value: str) -> Path:
    pure_path = PurePosixPath(relative_key_value)
    if pure_path.is_absolute():
        raise RuntimeError(f"Refusing to use absolute R2 key: {relative_key_value}")
    if any(part in {"", ".", ".."} for part in pure_path.parts):
        raise RuntimeError(f"Refusing unsafe R2 key: {relative_key_value}")
    return base_dir.joinpath(*pure_path.parts)


def s3_client():
    if boto3 is None:
        raise SystemExit("boto3 must be installed to use the R2 files sync helper")

    access_key = require_env("R2_ACCESS_KEY_ID")
    secret_key = require_env("R2_SECRET_ACCESS_KEY")
    endpoint = env_value("R2_ENDPOINT")
    if not endpoint:
        account_id = require_env("R2_ACCOUNT_ID")
        endpoint = f"https://{account_id}.r2.cloudflarestorage.com"

    session = boto3.session.Session()
    return session.client(
        "s3",
        endpoint_url=endpoint,
        aws_access_key_id=access_key,
        aws_secret_access_key=secret_key,
        region_name=env_value("R2_REGION", default="auto"),
    )


def iter_local_files(files_dir: Path) -> Iterator[Path]:
    for path in sorted(files_dir.rglob("*")):
        if path.is_file():
            yield path


def collect_local_files(files_dir: Path) -> Dict[str, Path]:
    files: Dict[str, Path] = {}
    for path in iter_local_files(files_dir):
        relative_path = path.relative_to(files_dir)
        files[relative_path.as_posix()] = path
    return files


def iter_remote_objects(client, bucket: str, prefix: str) -> Iterator[dict]:
    paginator = client.get_paginator("list_objects_v2")
    params = {"Bucket": bucket}
    clean_prefix = normalized_prefix(prefix)
    if clean_prefix:
        params["Prefix"] = f"{clean_prefix}/"
    for page in paginator.paginate(**params):
        for obj in page.get("Contents", []):
            yield obj


def collect_remote_objects(client, bucket: str, prefix: str) -> Dict[str, dict]:
    objects: Dict[str, dict] = {}
    for obj in iter_remote_objects(client, bucket, prefix):
        rel_key = relative_key(prefix, obj["Key"])
        if not rel_key:
            continue
        objects[rel_key] = obj
    return objects


def content_type_for(path: Path) -> Dict[str, str]:
    content_type, content_encoding = mimetypes.guess_type(path.name)
    extra_args: Dict[str, str] = {}
    if content_type:
        extra_args["ContentType"] = content_type
    if content_encoding:
        extra_args["ContentEncoding"] = content_encoding
    return extra_args


def delete_remote_keys(client, bucket: str, keys: Iterable[str], dry_run: bool = False) -> int:
    deleted = 0
    batch = []
    for key in keys:
        batch.append({"Key": key})
        if len(batch) == 1000:
            deleted += delete_remote_batch(client, bucket, batch, dry_run=dry_run)
            batch = []
    if batch:
        deleted += delete_remote_batch(client, bucket, batch, dry_run=dry_run)
    return deleted


def delete_remote_batch(client, bucket: str, batch: list[dict], dry_run: bool = False) -> int:
    if dry_run:
        for entry in batch:
            print(f"Would delete s3://{bucket}/{entry['Key']}")
        return len(batch)
    client.delete_objects(Bucket=bucket, Delete={"Objects": batch, "Quiet": True})
    for entry in batch:
        print(f"Deleted s3://{bucket}/{entry['Key']}")
    return len(batch)


def upload_directory(
    client,
    bucket: str,
    prefix: str,
    files_dir: Path,
    delete: bool = False,
    dry_run: bool = False,
) -> int:
    if not files_dir.exists():
        raise SystemExit(f"Local files directory does not exist: {files_dir}")
    if not files_dir.is_dir():
        raise SystemExit(f"Local files path is not a directory: {files_dir}")

    local_files = collect_local_files(files_dir)
    remote_files = collect_remote_objects(client, bucket, prefix) if delete else {}

    uploaded = 0
    for rel_path, path in local_files.items():
        key = object_key(prefix, Path(rel_path))
        if dry_run:
            print(f"Would upload {path} -> s3://{bucket}/{key}")
            uploaded += 1
            continue
        extra_args = content_type_for(path)
        if extra_args:
            client.upload_file(str(path), bucket, key, ExtraArgs=extra_args)
        else:
            client.upload_file(str(path), bucket, key)
        print(f"Uploaded {path} -> s3://{bucket}/{key}")
        uploaded += 1

    deleted = 0
    if delete:
        remote_only = [
            object_key(prefix, Path(rel_path))
            for rel_path in sorted(set(remote_files) - set(local_files))
        ]
        deleted = delete_remote_keys(client, bucket, remote_only, dry_run=dry_run)

    print(f"Uploaded {uploaded} file(s) from {files_dir}")
    if delete:
        print(f"Deleted {deleted} remote file(s) not present locally")
    return 0


def delete_local_files(files_dir: Path, keep_rel_paths: set[str], dry_run: bool = False) -> int:
    deleted = 0
    for rel_path, path in collect_local_files(files_dir).items():
        if rel_path in keep_rel_paths:
            continue
        if dry_run:
            print(f"Would delete {path}")
            deleted += 1
            continue
        path.unlink()
        print(f"Deleted {path}")
        deleted += 1

    if dry_run:
        return deleted

    for directory in sorted(files_dir.rglob("*"), reverse=True):
        if directory.is_dir():
            try:
                directory.rmdir()
            except OSError:
                continue
    return deleted


def download_directory(
    client,
    bucket: str,
    prefix: str,
    files_dir: Path,
    delete: bool = False,
    dry_run: bool = False,
) -> int:
    remote_objects = collect_remote_objects(client, bucket, prefix)
    if not remote_objects:
        print(f"No remote files found in s3://{bucket}/{normalized_prefix(prefix) or '.'}")
        return 0

    files_dir.mkdir(parents=True, exist_ok=True)
    downloaded = 0
    for rel_key in sorted(remote_objects):
        target_path = safe_local_path(files_dir, rel_key)
        if dry_run:
            print(f"Would download s3://{bucket}/{object_key(prefix, Path(rel_key))} -> {target_path}")
            downloaded += 1
            continue
        target_path.parent.mkdir(parents=True, exist_ok=True)
        client.download_file(bucket, object_key(prefix, Path(rel_key)), str(target_path))
        print(f"Downloaded s3://{bucket}/{object_key(prefix, Path(rel_key))} -> {target_path}")
        downloaded += 1

    deleted = 0
    if delete and files_dir.exists():
        deleted = delete_local_files(files_dir, set(remote_objects), dry_run=dry_run)

    print(f"Downloaded {downloaded} file(s) into {files_dir}")
    if delete:
        print(f"Deleted {deleted} local file(s) not present remotely")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--bucket",
        default=env_value("R2_BUCKET"),
        help="R2 bucket name (defaults to R2_BUCKET from the environment or .env)",
    )
    parser.add_argument(
        "--prefix",
        default=env_value("R2_FILES_PREFIX", default=""),
        help="Key prefix inside the bucket (defaults to R2_FILES_PREFIX, or no prefix)",
    )
    parser.add_argument(
        "--files-dir",
        default=str(DEFAULT_FILES_DIR),
        help="Local directory to upload/download (defaults to repo_root/files)",
    )
    parser.add_argument(
        "--delete",
        action="store_true",
        help="Mirror deletions as well as copies",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print actions without changing local or remote files",
    )

    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("upload", help="Upload the local files/ directory to R2")
    subparsers.add_parser("download", help="Download the remote files/ directory from R2")
    return parser


def main(argv: Optional[list[str]] = None) -> int:
    raw_args = list(argv) if argv is not None else sys.argv[1:]
    if not any(arg in {"upload", "download"} for arg in raw_args):
        default_command = env_value("FILES_R2_DEFAULT_COMMAND")
        if default_command in {"upload", "download"}:
            raw_args.append(default_command)

    parser = build_parser()
    args = parser.parse_args(raw_args)

    bucket = args.bucket or require_env("R2_BUCKET")
    prefix = normalized_prefix(args.prefix)
    files_dir = Path(args.files_dir).expanduser().resolve()

    client = s3_client()
    if args.command == "upload":
        return upload_directory(
            client,
            bucket=bucket,
            prefix=prefix,
            files_dir=files_dir,
            delete=args.delete,
            dry_run=args.dry_run,
        )
    if args.command == "download":
        return download_directory(
            client,
            bucket=bucket,
            prefix=prefix,
            files_dir=files_dir,
            delete=args.delete,
            dry_run=args.dry_run,
        )
    raise SystemExit(f"Unknown command: {args.command}")


if __name__ == "__main__":
    raise SystemExit(main())
