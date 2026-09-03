#!/usr/bin/env python3
"""Mirror a vendored source tarball into the archive bucket.

Frames that have to build QuickJS themselves, the Docker image and the
prebuilt-deps builder all fetch `source/vendor/<name>` from
archive.frameos.net rather than from the upstream site, so a release only
has one URL to pin. Uploads once; refuses to overwrite unless --force.

    python tools/prebuilt-deps/r2_put_source.py quickjs-2026-06-04-quickts.1.tar.xz

Credentials come from the same .env / R2_* variables as r2_sync.py.
"""

from __future__ import annotations

import argparse
import hashlib
import sys
from pathlib import Path

from botocore.exceptions import ClientError

sys.path.insert(0, str(Path(__file__).resolve().parent))
from r2_sync import DEFAULT_BUCKET, s3_client  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("tarball", type=Path)
    parser.add_argument("--bucket", default=DEFAULT_BUCKET)
    parser.add_argument("--prefix", default="source/vendor")
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()

    key = f"{args.prefix}/{args.tarball.name}"
    client = s3_client()
    if not args.force:
        try:
            client.head_object(Bucket=args.bucket, Key=key)
            print(f"s3://{args.bucket}/{key} already exists (use --force to replace)")
            return 1
        except ClientError as exc:
            if exc.response["Error"].get("Code") not in {"404", "NoSuchKey"}:
                raise

    digest = hashlib.sha256(args.tarball.read_bytes()).hexdigest()
    client.upload_file(
        Filename=str(args.tarball),
        Bucket=args.bucket,
        Key=key,
        ExtraArgs={"ContentType": "application/x-xz"},
    )
    print(f"Uploaded {args.tarball} -> s3://{args.bucket}/{key}")
    print(f"sha256 {digest}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
