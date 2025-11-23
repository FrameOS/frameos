import pytest

from app.config import config


@pytest.mark.asyncio
async def test_get_system_info(async_client, tmp_path, monkeypatch):
    cross_cache = tmp_path / "cross"
    docker_root = tmp_path / "docker"
    db_file = tmp_path / "db.sqlite"

    cross_cache.mkdir()
    docker_root.mkdir()

    (cross_cache / "cache.bin").write_bytes(b"x" * 1024)
    (docker_root / "layer.bin").write_bytes(b"y" * 2048)
    db_file.write_bytes(b"db")

    monkeypatch.setenv("FRAMEOS_CROSS_CACHE", str(cross_cache))
    monkeypatch.setenv("DOCKER_DATA_ROOT", str(docker_root))

    original_db_url = config.DATABASE_URL
    config.DATABASE_URL = f"sqlite:///{db_file}"

    try:
        response = await async_client.get("/api/system/info")
        assert response.status_code == 200
        data = response.json()

        cache_sizes = {cache["path"]: cache for cache in data["caches"]}
        assert cache_sizes[str(cross_cache)]["sizeBytes"] == 1024
        assert cache_sizes[str(docker_root)]["sizeBytes"] == 2048

        assert data["database"]["path"] == str(db_file)
        assert data["database"]["sizeBytes"] == 2
        assert data["disk"]["totalBytes"] >= data["disk"]["freeBytes"]
    finally:
        config.DATABASE_URL = original_db_url


@pytest.mark.asyncio
async def test_get_system_metrics(async_client):
    response = await async_client.get("/api/system/metrics")
    assert response.status_code == 200
    data = response.json()
    assert "memory" in data
    assert "load" in data
    assert "disk" in data
