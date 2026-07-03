from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

from app.models.assets import ASSETS_WRITABLE_MARKER, make_asset_folders, sync_assets


def make_frame(**overrides):
    defaults = {
        "id": 1,
        "project_id": 1,
        "assets_path": "/srv/assets",
        "upload_fonts": "all",
    }
    defaults.update(overrides)
    return SimpleNamespace(**defaults)


@pytest.mark.asyncio
@patch("app.models.assets.run_command", new_callable=AsyncMock)
async def test_make_asset_folders_returns_true_when_writable(mock_run, db, redis):
    mock_run.return_value = (0, ASSETS_WRITABLE_MARKER, "")
    assert await make_asset_folders(db, redis, make_frame(), "/srv/assets") is True


@pytest.mark.asyncio
@patch("app.models.assets.run_command", new_callable=AsyncMock)
async def test_make_asset_folders_returns_false_when_not_writable(mock_run, db, redis):
    mock_run.return_value = (0, "Warning: /srv/assets is not writable", "")
    assert await make_asset_folders(db, redis, make_frame(), "/srv/assets") is False


@pytest.mark.asyncio
@patch("app.models.assets.run_command", new_callable=AsyncMock)
async def test_make_asset_folders_command_is_best_effort(mock_run, db, redis):
    mock_run.return_value = (0, ASSETS_WRITABLE_MARKER, "")
    await make_asset_folders(db, redis, make_frame(), "/srv/assets")

    cmd = mock_run.call_args.args[3]
    # Remounts a read-only assets partition (vfat flips to ro after power loss)
    assert 'sudo mount -o remount,rw "$mp"' in cmd
    # Never chowns filesystems without POSIX ownership
    assert "vfat|exfat|msdos)" in cmd
    # Permission fixes must not abort the deploy on failure
    assert 'sudo chown -R "$(whoami)" "$fix" || echo' in cmd
    assert 'sudo chmod -R u+rwX,go+rX "$fix" || echo' in cmd
    # Fonts subfolder is the target when fonts are uploaded
    assert "t=/srv/assets/fonts" in cmd
    assert ASSETS_WRITABLE_MARKER in cmd


@pytest.mark.asyncio
@patch("app.models.assets.run_command", new_callable=AsyncMock)
async def test_make_asset_folders_without_fonts_targets_assets_root(mock_run, db, redis):
    mock_run.return_value = (0, ASSETS_WRITABLE_MARKER, "")
    await make_asset_folders(db, redis, make_frame(upload_fonts="none"), "/srv/assets")

    cmd = mock_run.call_args.args[3]
    assert "t=/srv/assets;" in cmd
    assert "t=/srv/assets/fonts" not in cmd


@pytest.mark.asyncio
@patch("app.models.assets.run_command", new_callable=AsyncMock)
async def test_make_asset_folders_quotes_assets_path(mock_run, db, redis):
    mock_run.return_value = (0, ASSETS_WRITABLE_MARKER, "")
    await make_asset_folders(db, redis, make_frame(), "/srv/my assets")

    cmd = mock_run.call_args.args[3]
    assert "p='/srv/my assets'" in cmd


@pytest.mark.asyncio
@patch("app.models.assets.upload_font_assets", new_callable=AsyncMock)
@patch("app.models.assets.make_asset_folders", new_callable=AsyncMock)
async def test_sync_assets_uploads_fonts_when_writable(mock_folders, mock_fonts, db, redis):
    mock_folders.return_value = True
    frame = make_frame()
    await sync_assets(db, redis, frame)
    mock_fonts.assert_awaited_once_with(db, redis, frame, "/srv/assets")


@pytest.mark.asyncio
@patch("app.models.assets.log", new_callable=AsyncMock)
@patch("app.models.assets.upload_font_assets", new_callable=AsyncMock)
@patch("app.models.assets.make_asset_folders", new_callable=AsyncMock)
async def test_sync_assets_skips_fonts_when_not_writable(mock_folders, mock_fonts, mock_log, db, redis):
    mock_folders.return_value = False
    await sync_assets(db, redis, make_frame())
    mock_fonts.assert_not_awaited()
    warning = mock_log.call_args.args[4]
    assert "not writable" in warning
    assert "skipping font sync" in warning


@pytest.mark.asyncio
@patch("app.models.assets.upload_font_assets", new_callable=AsyncMock)
@patch("app.models.assets.make_asset_folders", new_callable=AsyncMock)
async def test_sync_assets_skips_fonts_when_disabled(mock_folders, mock_fonts, db, redis):
    mock_folders.return_value = True
    await sync_assets(db, redis, make_frame(upload_fonts="none"))
    mock_fonts.assert_not_awaited()
