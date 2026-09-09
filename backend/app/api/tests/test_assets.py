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


@pytest.mark.asyncio
async def test_asset_listing_never_selects_the_blob_column(async_client, db):
    """The listing reports sizes; it used to load every asset's bytes to call
    len() on them. The size must come from the database."""
    from sqlalchemy import event

    from app.database import engine

    for index in range(3):
        response = await async_client.post(
            "/api/assets",
            data={"path": f"images/{index}.bin"},
            files={"file": (f"{index}.bin", b"x" * (index + 1) * 10, "application/octet-stream")},
        )
        assert response.status_code == 201, response.text

    statements: list[str] = []

    def record(conn, cursor, statement, parameters, context, executemany):
        if "assets" in statement.lower():
            statements.append(statement)

    event.listen(engine, "before_cursor_execute", record)
    try:
        response = await async_client.get("/api/assets")
    finally:
        event.remove(engine, "before_cursor_execute", record)

    assert response.status_code == 200
    listed = {asset["path"]: asset["size"] for asset in response.json()}
    assert listed == {"images/0.bin": 10, "images/1.bin": 20, "images/2.bin": 30}
    assert statements, "the listing should have queried the assets table"
    for statement in statements:
        select_clause = statement.split(" FROM ", 1)[0].lower()
        assert "assets.data" not in select_clause.replace("length(assets.data)", ""), statement
        assert "length(assets.data)" in select_clause, statement
