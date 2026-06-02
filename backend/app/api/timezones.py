import gzip
import hashlib
from dataclasses import dataclass
from pathlib import Path

from fastapi import HTTPException
from fastapi.responses import Response

from . import api_public


REPO_ROOT = Path(__file__).resolve().parents[3]
TZDATA_PATH = REPO_ROOT / "frameos" / "assets" / "compiled" / "tz" / "tzdata.json"


@dataclass
class TimezonePayload:
    mtime_ns: int
    size: int
    sha256: str
    gzip_data: bytes


_payload_cache: TimezonePayload | None = None


def _load_timezone_payload() -> TimezonePayload:
    global _payload_cache

    try:
        stat = TZDATA_PATH.stat()
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Timezone data not found")

    if _payload_cache is not None and _payload_cache.mtime_ns == stat.st_mtime_ns:
        return _payload_cache

    data = TZDATA_PATH.read_bytes()
    _payload_cache = TimezonePayload(
        mtime_ns=stat.st_mtime_ns,
        size=len(data),
        sha256=hashlib.sha256(data).hexdigest(),
        gzip_data=gzip.compress(data, mtime=0),
    )
    return _payload_cache


@api_public.get("/timezones/manifest")
async def timezone_manifest():
    payload = _load_timezone_payload()
    return {
        "version": payload.sha256[:16],
        "sha256": payload.sha256,
        "size": payload.size,
        "compressedSize": len(payload.gzip_data),
        "url": "/api/timezones/tzdata.json.gz",
    }


@api_public.get("/timezones/tzdata.json.gz")
async def timezone_data_gzip():
    payload = _load_timezone_payload()
    return Response(
        content=payload.gzip_data,
        media_type="application/gzip",
        headers={
            "Cache-Control": "max-age=3600",
            "Content-Disposition": 'attachment; filename="tzdata.json.gz"',
        },
    )
