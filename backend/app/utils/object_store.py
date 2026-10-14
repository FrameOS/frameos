"""Where the photo library's bytes live (docs/photos.md "Storage").

Two drivers behind one five-verb interface, chosen from the environment:

  * **disk** (the default): a directory, `<photos dir>/objects/<key>`.
  * **s3**: any S3-compatible bucket (Cloudflare R2, AWS S3, MinIO, ...),
    picked when FRAMEOS_PHOTOS_S3_ENDPOINT, FRAMEOS_PHOTOS_S3_BUCKET,
    FRAMEOS_PHOTOS_S3_ACCESS_KEY_ID and FRAMEOS_PHOTOS_S3_SECRET_ACCESS_KEY
    are all set. FRAMEOS_PHOTOS_S3_REGION (default "auto", what R2 takes;
    AWS needs the bucket's region) and FRAMEOS_PHOTOS_S3_PREFIX (a folder in
    the bucket) are optional. Some of the four set and not all is a
    misconfiguration the library reports instead of quietly using the disk.

Keys are the caller's (app/utils/photos.py: `photos/<sha256>` and
`photos/thumbs/<sha256>`), checked here before they touch a path or a URL.
The S3 driver signs requests itself (AWS Signature Version 4 over httpx) so
the backend needs no AWS SDK. Everything here blocks; callers run it in a
worker thread.
"""
from __future__ import annotations

import datetime
import hashlib
import hmac
import os
import re
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Optional, Protocol
from urllib.parse import quote, urlsplit

import httpx

__all__ = [
    "ObjectStore",
    "DiskObjectStore",
    "S3ObjectStore",
    "StoreError",
    "is_valid_object_key",
    "s3_settings_from_env",
    "S3Settings",
]

_KEY_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._/-]{0,511}")
S3_TIMEOUT_SECONDS = 60.0


def is_valid_object_key(key: str) -> bool:
    if not _KEY_RE.fullmatch(key or ""):
        return False
    return all(segment not in ("", ".", "..") for segment in key.split("/"))


def _assert_key(key: str) -> None:
    if not is_valid_object_key(key):
        raise ValueError(f"Invalid object key: {key!r}")


class StoreError(Exception):
    """The store could not do what was asked (not: the object is absent)."""


class ObjectStore(Protocol):
    driver: str
    location: str

    def put(self, key: str, data: bytes, content_type: str) -> None: ...

    def get(self, key: str) -> Optional[bytes]: ...

    def exists(self, key: str) -> bool: ...

    def delete(self, key: str) -> None: ...

    def local_path(self, key: str) -> Optional[Path]:
        """The file behind `key` when the store is a directory, so a route
        can stream it; None for a remote store."""
        ...

    def check(self) -> Optional[str]:
        """None when the store can be used, else why not."""
        ...


# ---------------------------------------------------------------------------
# A directory
# ---------------------------------------------------------------------------


class DiskObjectStore:
    driver = "disk"

    def __init__(self, root: Path) -> None:
        self.root = Path(root)
        self.location = str(self.root)

    def _path(self, key: str) -> Path:
        _assert_key(key)
        return self.root / key

    def put(self, key: str, data: bytes, content_type: str) -> None:
        target = self._path(key)
        target.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp_name = tempfile.mkstemp(dir=target.parent, prefix=".put-")
        try:
            with os.fdopen(fd, "wb") as handle:
                handle.write(data)
            os.replace(tmp_name, target)
        except OSError:
            try:
                os.unlink(tmp_name)
            except OSError:
                pass
            raise

    def get(self, key: str) -> Optional[bytes]:
        try:
            return self._path(key).read_bytes()
        except FileNotFoundError:
            return None

    def exists(self, key: str) -> bool:
        return self._path(key).is_file()

    def delete(self, key: str) -> None:
        try:
            os.unlink(self._path(key))
        except FileNotFoundError:
            pass

    def local_path(self, key: str) -> Optional[Path]:
        target = self._path(key)
        return target if target.is_file() else None

    def check(self) -> Optional[str]:
        try:
            self.root.mkdir(parents=True, exist_ok=True)
            fd, probe = tempfile.mkstemp(dir=self.root, prefix=".frameos-probe-")
            try:
                os.write(fd, b"ok")
            finally:
                os.close(fd)
                os.unlink(probe)
        except OSError as error:
            return error.strerror or str(error)
        return None


# ---------------------------------------------------------------------------
# An S3-compatible bucket
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class S3Settings:
    endpoint: str
    bucket: str
    access_key_id: str
    secret_access_key: str
    region: str = "auto"
    prefix: str = ""


_S3_ENV = {
    "endpoint": "FRAMEOS_PHOTOS_S3_ENDPOINT",
    "bucket": "FRAMEOS_PHOTOS_S3_BUCKET",
    "access_key_id": "FRAMEOS_PHOTOS_S3_ACCESS_KEY_ID",
    "secret_access_key": "FRAMEOS_PHOTOS_S3_SECRET_ACCESS_KEY",
}


def s3_settings_from_env() -> tuple[Optional[S3Settings], Optional[str]]:
    """(settings, None) when the bucket is configured, (None, None) when it
    is not, (None, problem) when it is half configured."""
    values = {name: (os.environ.get(var) or "").strip() for name, var in _S3_ENV.items()}
    present = [name for name, value in values.items() if value]
    if not present:
        return None, None
    missing = [_S3_ENV[name] for name, value in values.items() if not value]
    if missing:
        return None, f"Photo storage is half configured: set {', '.join(missing)} as well, or unset the FRAMEOS_PHOTOS_S3_* variables to store photos on disk."
    endpoint = values["endpoint"].rstrip("/")
    if not endpoint.startswith(("http://", "https://")):
        endpoint = "https://" + endpoint
    parts = urlsplit(endpoint)
    if not parts.netloc or parts.path not in ("", "/"):
        return None, "FRAMEOS_PHOTOS_S3_ENDPOINT must be the service address (https://<account>.r2.cloudflarestorage.com, https://s3.<region>.amazonaws.com), not a bucket URL."
    bucket = values["bucket"]
    if not re.fullmatch(r"[a-z0-9][a-z0-9.-]{1,62}", bucket):
        return None, "FRAMEOS_PHOTOS_S3_BUCKET must be a bucket name (lowercase letters, digits, dots and dashes)."
    prefix = (os.environ.get("FRAMEOS_PHOTOS_S3_PREFIX") or "").strip().strip("/")
    if prefix and not is_valid_object_key(prefix):
        return None, "FRAMEOS_PHOTOS_S3_PREFIX must be a folder name (letters, digits, dots, dashes, slashes)."
    region = (os.environ.get("FRAMEOS_PHOTOS_S3_REGION") or "").strip() or "auto"
    return (
        S3Settings(
            endpoint=f"{parts.scheme}://{parts.netloc}",
            bucket=bucket,
            access_key_id=values["access_key_id"],
            secret_access_key=values["secret_access_key"],
            region=region,
            prefix=prefix,
        ),
        None,
    )


def _sign(key: bytes, message: str) -> bytes:
    return hmac.new(key, message.encode("utf-8"), hashlib.sha256).digest()


class S3ObjectStore:
    """Path-style requests (`<endpoint>/<bucket>/<key>`) signed with SigV4.
    Path style works on every S3-compatible service; virtual-hosted style
    does not on all of them."""

    driver = "s3"

    def __init__(self, settings: S3Settings, client: Optional[httpx.Client] = None) -> None:
        self.settings = settings
        self._client = client
        host = urlsplit(settings.endpoint).netloc
        folder = f"/{settings.prefix}" if settings.prefix else ""
        self.location = f"s3://{settings.bucket}{folder} at {host}"

    @property
    def client(self) -> httpx.Client:
        if self._client is None:
            self._client = httpx.Client(timeout=S3_TIMEOUT_SECONDS)
        return self._client

    def _object_path(self, key: str) -> str:
        _assert_key(key)
        full = f"{self.settings.prefix}/{key}" if self.settings.prefix else key
        # Each segment is URI-encoded on its own: that is what the signature
        # covers (the canonical URI), and what the service decodes.
        return "/" + self.settings.bucket + "/" + "/".join(quote(segment, safe="") for segment in full.split("/"))

    def _request(self, method: str, key: str, body: bytes = b"", content_type: Optional[str] = None) -> httpx.Response:
        path = self._object_path(key)
        host = urlsplit(self.settings.endpoint).netloc
        now = datetime.datetime.now(datetime.timezone.utc)
        amz_date = now.strftime("%Y%m%dT%H%M%SZ")
        date = now.strftime("%Y%m%d")
        payload_hash = hashlib.sha256(body).hexdigest()
        headers = {
            "host": host,
            "x-amz-content-sha256": payload_hash,
            "x-amz-date": amz_date,
        }
        if content_type:
            headers["content-type"] = content_type
        signed_names = sorted(headers)
        canonical_headers = "".join(f"{name}:{headers[name].strip()}\n" for name in signed_names)
        signed_headers = ";".join(signed_names)
        canonical_request = "\n".join([method, path, "", canonical_headers, signed_headers, payload_hash])
        scope = f"{date}/{self.settings.region}/s3/aws4_request"
        string_to_sign = "\n".join([
            "AWS4-HMAC-SHA256",
            amz_date,
            scope,
            hashlib.sha256(canonical_request.encode("utf-8")).hexdigest(),
        ])
        signing_key = _sign(
            _sign(_sign(_sign(("AWS4" + self.settings.secret_access_key).encode("utf-8"), date), self.settings.region), "s3"),
            "aws4_request",
        )
        signature = hmac.new(signing_key, string_to_sign.encode("utf-8"), hashlib.sha256).hexdigest()
        headers["authorization"] = (
            f"AWS4-HMAC-SHA256 Credential={self.settings.access_key_id}/{scope}, "
            f"SignedHeaders={signed_headers}, Signature={signature}"
        )
        del headers["host"]
        try:
            return self.client.request(method, self.settings.endpoint + path, content=body, headers=headers)
        except httpx.HTTPError as error:
            raise StoreError(f"{host}: {error.__class__.__name__}: {error}") from error

    @staticmethod
    def _fail(what: str, response: httpx.Response) -> StoreError:
        detail = response.text.strip()
        if len(detail) > 300:
            detail = detail[:300] + "..."
        return StoreError(f"{what}: HTTP {response.status_code} {detail}".rstrip())

    def put(self, key: str, data: bytes, content_type: str) -> None:
        response = self._request("PUT", key, data, content_type)
        if response.status_code >= 300:
            raise self._fail(f"Could not store {key}", response)

    def get(self, key: str) -> Optional[bytes]:
        response = self._request("GET", key)
        if response.status_code == 404:
            return None
        if response.status_code >= 300:
            raise self._fail(f"Could not read {key}", response)
        return response.content

    def exists(self, key: str) -> bool:
        response = self._request("HEAD", key)
        if response.status_code == 404:
            return False
        if response.status_code >= 300:
            raise self._fail(f"Could not check {key}", response)
        return True

    def delete(self, key: str) -> None:
        response = self._request("DELETE", key)
        if response.status_code not in (200, 202, 204, 404):
            raise self._fail(f"Could not delete {key}", response)

    def local_path(self, key: str) -> Optional[Path]:
        return None

    def check(self) -> Optional[str]:
        """A HEAD on a key that is not there: 404 proves the bucket answers
        with these credentials, anything else says what is wrong."""
        try:
            response = self._request("HEAD", "photos/.frameos-probe")
        except StoreError as error:
            return str(error)
        if response.status_code in (200, 404):
            return None
        if response.status_code in (401, 403):
            return f"The bucket refused the credentials (HTTP {response.status_code}). Check the FRAMEOS_PHOTOS_S3_* keys and the bucket's permissions."
        return f"The bucket answered HTTP {response.status_code}."
