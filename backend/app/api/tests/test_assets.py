import pytest

from app.models.assets import Assets


@pytest.mark.asyncio
async def test_create_asset_stores_the_file(async_client, db):
    response = await async_client.post(
        "/api/assets", data={"path": "fonts/x.ttf"}, files={"file": ("x.ttf", b"font-bytes", "font/ttf")}
    )

    assert response.status_code == 201, response.text
    assert response.json()["size"] == len(b"font-bytes")
    assert db.query(Assets).filter_by(path="fonts/x.ttf").one().data == b"font-bytes"


@pytest.mark.asyncio
async def test_asset_uploads_over_the_cap_are_rejected(async_client, db, monkeypatch):
    from app.api import assets as assets_module

    monkeypatch.setattr(assets_module, "MAX_ASSET_UPLOAD_BYTES", 16)
    response = await async_client.post(
        "/api/assets", data={"path": "big.bin"}, files={"file": ("big.bin", b"x" * 17, "application/octet-stream")}
    )
    assert response.status_code == 413
    assert db.query(Assets).filter_by(path="big.bin").first() is None

    response = await async_client.post(
        "/api/assets", data={"path": "small.bin"}, files={"file": ("small.bin", b"x" * 8, "application/octet-stream")}
    )
    assert response.status_code == 201, response.text
    asset_id = response.json()["id"]

    response = await async_client.put(
        f"/api/assets/{asset_id}", files={"file": ("big.bin", b"y" * 17, "application/octet-stream")}
    )
    assert response.status_code == 413
    db.expire_all()
    assert db.query(Assets).filter_by(path="small.bin").one().data == b"x" * 8
