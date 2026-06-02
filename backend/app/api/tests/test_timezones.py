import gzip
import hashlib

import pytest

from app.api.timezones import TZDATA_PATH


@pytest.mark.asyncio
async def test_timezone_manifest_reports_current_tzdata(no_auth_client):
    data = TZDATA_PATH.read_bytes()

    response = await no_auth_client.get("/api/timezones/manifest")

    assert response.status_code == 200
    payload = response.json()
    assert payload["sha256"] == hashlib.sha256(data).hexdigest()
    assert payload["size"] == len(data)
    assert payload["compressedSize"] > 0
    assert payload["url"] == "/api/timezones/tzdata.json.gz"


@pytest.mark.asyncio
async def test_timezone_data_gzip_returns_current_tzdata(no_auth_client):
    response = await no_auth_client.get("/api/timezones/tzdata.json.gz")

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("application/gzip")
    assert gzip.decompress(response.content) == TZDATA_PATH.read_bytes()
