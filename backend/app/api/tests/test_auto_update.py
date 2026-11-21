"""Automatic updates on the backend (docs/auto-updates.md): the frame's
switch, the manifest's sources, the board's OTA manifest answered by the
update decision, and the hourly sweep."""

import hashlib
from datetime import datetime, timezone
from unittest.mock import AsyncMock, patch

import httpx
import pytest

from app.models.frame import Frame, get_frame_json
from app.tasks import auto_update
from app.utils import frame_updates, update_manifest

from .test_embedded_device import (
    MINISIG_TEXT,
    auth,
    device_frame,
    manual_check,
    mocked_httpx,
    patch_release,
    release_with,
)

FULL = [{"afterHours": 0, "percent": 100}]


@pytest.fixture(autouse=True)
def clean_redis(redis):
    """Manual flags and nudges are Redis keys; frame ids repeat per test."""
    return redis


def manifest_of(*releases: dict) -> dict:
    return {"version": 1, "paused": None, "defaultRollout": FULL, "releases": list(releases)}


def released(version: str, **extra) -> dict:
    return {"version": version, "at": "2026-01-01T00:00:00Z", "rollout": FULL, **extra}


def with_manifest(manifest):
    return patch("app.utils.update_manifest.get_update_manifest", new_callable=AsyncMock, return_value=manifest)


def tagged_release(version: str, platform: str = "esp32-s3-generic") -> dict:
    base = f"https://github.com/FrameOS/frameos/releases/download/v{version}/"
    names = [f"frameos-{version}-{platform}-app.bin", f"frameos-{version}-{platform}-app.bin.minisig"]
    return {
        "tag_name": f"v{version}",
        "assets": [
            {"name": names[0], "size": 650, "browser_download_url": base + names[0]},
            {"name": names[1], "size": 120, "browser_download_url": base + names[1]},
        ],
    }


async def board_on(async_client, db, version: str | None) -> Frame:
    frame = await device_frame(async_client, db)
    if version:
        frame.embedded = {**(frame.embedded or {}), "lastBoot": {"frameosVersion": version}}
        db.add(frame)
        db.commit()
    return frame


# --- the switch ----------------------------------------------------------


@pytest.mark.asyncio
async def test_on_by_default_in_the_row_and_frame_json_and_turned_off(async_client, db):
    response = await async_client.post('/api/frames/new', json={
        'name': 'Hall', 'frame_host': 'hall.local', 'server_host': 'localhost', 'device': 'web_only',
    })
    frame_id = response.json()['frame']['id']
    assert response.json()['frame']['auto_update'] is True
    frame = db.get(Frame, frame_id)
    assert get_frame_json(db, frame)['autoUpdate'] is True

    response = await async_client.post(f'/api/frames/{frame_id}', json={'auto_update': False})
    assert response.status_code == 200
    db.expire_all()
    frame = db.get(Frame, frame_id)
    assert frame.auto_update is False
    assert get_frame_json(db, frame)['autoUpdate'] is False

    response = await async_client.post(f'/api/frames/{frame_id}', json={'auto_update': None})
    assert response.status_code == 200
    db.expire_all()
    assert db.get(Frame, frame_id).auto_update is True


# --- where the manifest comes from ---------------------------------------


@pytest.mark.asyncio
async def test_manifest_github_first_then_the_cloud_mirror_and_the_last_good_copy(monkeypatch):
    asked: list[str] = []
    answers: dict[str, object] = {update_manifest.GITHUB_MANIFEST_URL: None,
                                  update_manifest.CLOUD_MANIFEST_URL: manifest_of(released("2026.9.2"))}

    async def fetch(url):
        asked.append(url)
        return answers[url]

    monkeypatch.setattr(update_manifest, "_fetch_manifest", fetch)
    monkeypatch.delenv(update_manifest.MANIFEST_URL_ENV, raising=False)
    update_manifest.clear_update_manifest_cache()
    manifest = await update_manifest.get_update_manifest()
    assert manifest["releases"][0]["version"] == "2026.9.2"
    assert asked == [update_manifest.GITHUB_MANIFEST_URL, update_manifest.CLOUD_MANIFEST_URL]

    # Cached: no second fetch.
    await update_manifest.get_update_manifest()
    assert len(asked) == 2

    # Both sources down after the cache runs out: the last good copy stays.
    answers[update_manifest.CLOUD_MANIFEST_URL] = None
    update_manifest._cache["at"] = 1.0
    assert (await update_manifest.get_update_manifest())["releases"][0]["version"] == "2026.9.2"


def test_manifest_url_override(monkeypatch):
    monkeypatch.setenv(update_manifest.MANIFEST_URL_ENV, "https://example.com/m.json")
    assert update_manifest.update_manifest_urls() == ["https://example.com/m.json", update_manifest.CLOUD_MANIFEST_URL]


def test_backend_frame_key_is_per_install(monkeypatch):
    monkeypatch.setattr(update_manifest.config, "SECRET_KEY", "secret")
    install = hashlib.sha256(b"secret").hexdigest()[:12]
    assert update_manifest.backend_frame_key(12) == f"backend:{install}:12"


# --- the board's OTA manifest, answered by the rule -----------------------


@pytest.mark.asyncio
async def test_an_automatic_check_gets_the_release_the_rule_answers(async_client, no_auth_client, db):
    frame = await board_on(async_client, db, "2026.9.1")
    listing, text = patch_release(release_with('esp32-s3-generic'))
    with listing, text, with_manifest(manifest_of(released("2026.9.1"), released("2026.9.2"))):
        response = await no_auth_client.get(
            f'/api/frames/{frame.id}/embedded/ota/manifest?platform=esp32-s3-generic', headers=auth(frame))
    assert response.status_code == 200, response.text
    body = response.json()
    assert body['version'] == '2026.9.2'
    assert body['minisig'] == MINISIG_TEXT
    assert body['downloadUrl'] == (
        f'/api/frames/{frame.id}/embedded/ota/download?platform=esp32-s3-generic&version=2026.9.2')
    assert body['update'] is True and body['reason'] == 'latest'


@pytest.mark.asyncio
async def test_a_held_latest_offers_the_newest_release_the_frame_may_have(async_client, no_auth_client, db):
    """The latest is still in a later rollout stage (or blocked): the board
    gets the release under it, fetched by its tag."""
    frame = await board_on(async_client, db, "2026.9.0")
    listing, text = patch_release(release_with('esp32-s3-generic'))
    tagged = patch('app.api.firmware_release._fetch_release_by_tag', new_callable=AsyncMock,
                   return_value=tagged_release("2026.9.1"))
    manifest = manifest_of(released("2026.9.1"), released("2026.9.2", blocked="bricks the panel"))
    with listing, text, tagged as by_tag, with_manifest(manifest):
        response = await no_auth_client.get(
            f'/api/frames/{frame.id}/embedded/ota/manifest?platform=esp32-s3-generic', headers=auth(frame))
    assert response.status_code == 200, response.text
    body = response.json()
    assert body['version'] == '2026.9.1'
    assert body['size'] == 650
    assert body['reason'] == 'held_back'
    assert body['held']['why'] == 'blocked'
    assert body['downloadUrl'].endswith('&version=2026.9.1')
    by_tag.assert_awaited_once_with('2026.9.1')


@pytest.mark.asyncio
async def test_nothing_to_install_is_the_boards_own_version(async_client, no_auth_client, db):
    frame = await board_on(async_client, db, "2026.9.2")
    with with_manifest(manifest_of(released("2026.9.2"))):
        response = await no_auth_client.get(
            f'/api/frames/{frame.id}/embedded/ota/manifest?platform=esp32-s3-generic', headers=auth(frame))
    assert response.status_code == 200
    body = response.json()
    # What fos_ota.c checks before it says up-to-date: string fields, size >= 1.
    assert body['version'] == '2026.9.2'
    assert body['minisig'] == '' and body['downloadUrl'] == '' and body['size'] == 1
    assert body['update'] is False and body['reason'] == 'up_to_date'


@pytest.mark.asyncio
async def test_the_boards_own_version_parameter_wins(async_client, no_auth_client, db):
    frame = await board_on(async_client, db, "2026.9.1")
    with with_manifest(manifest_of(released("2026.9.2"))):
        response = await no_auth_client.get(
            f'/api/frames/{frame.id}/embedded/ota/manifest?platform=esp32-s3-generic&version=2026.9.2',
            headers=auth(frame))
    assert response.json()['reason'] == 'up_to_date'


@pytest.mark.asyncio
async def test_switched_off_an_automatic_check_installs_nothing(async_client, no_auth_client, db):
    frame = await board_on(async_client, db, "2026.9.1")
    frame.auto_update = False
    db.commit()
    with with_manifest(manifest_of(released("2026.9.2"))):
        response = await no_auth_client.get(
            f'/api/frames/{frame.id}/embedded/ota/manifest?platform=esp32-s3-generic', headers=auth(frame))
    assert response.json()['version'] == '2026.9.1'
    assert response.json()['reason'] == 'disabled'

    # The owner's Update still works.
    listing, text = patch_release(release_with('esp32-s3-generic'))
    with listing, text, manual_check(), with_manifest(manifest_of(released("2026.9.2"))):
        response = await no_auth_client.get(
            f'/api/frames/{frame.id}/embedded/ota/manifest?platform=esp32-s3-generic', headers=auth(frame))
    assert response.json()['version'] == '2026.9.2'


@pytest.mark.asyncio
async def test_a_manual_check_skips_the_rollout(async_client, no_auth_client, db):
    frame = await board_on(async_client, db, "2026.9.1")
    future = {"version": "2026.9.2", "at": "2026-01-01T00:00:00Z", "rollout": [{"afterHours": 0, "percent": 0}]}
    manifest = manifest_of(released("2026.9.1"), future)
    with with_manifest(manifest):
        response = await no_auth_client.get(
            f'/api/frames/{frame.id}/embedded/ota/manifest?platform=esp32-s3-generic', headers=auth(frame))
    assert response.json()['reason'] == 'held'
    listing, text = patch_release(release_with('esp32-s3-generic'))
    with listing, text, manual_check(), with_manifest(manifest):
        response = await no_auth_client.get(
            f'/api/frames/{frame.id}/embedded/ota/manifest?platform=esp32-s3-generic', headers=auth(frame))
    assert response.json()['version'] == '2026.9.2'


@pytest.mark.asyncio
async def test_no_manifest_an_automatic_check_installs_nothing(async_client, no_auth_client, db):
    frame = await board_on(async_client, db, "2026.9.1")
    response = await no_auth_client.get(
        f'/api/frames/{frame.id}/embedded/ota/manifest?platform=esp32-s3-generic', headers=auth(frame))
    assert response.status_code == 200
    assert response.json()['reason'] == 'no_manifest'
    # Unknown version and nothing to install: the 404 the firmware reads as
    # "nothing published", never an "up to date" it could not be.
    frame = await board_on(async_client, db, None)
    response = await no_auth_client.get(
        f'/api/frames/{frame.id}/embedded/ota/manifest?platform=esp32-s3-generic', headers=auth(frame))
    assert response.status_code == 404


@pytest.mark.asyncio
async def test_the_download_serves_the_version_the_manifest_named(async_client, no_auth_client, db):
    frame = await board_on(async_client, db, "2026.9.0")
    requested: list[str] = []

    def handler(request):
        requested.append(str(request.url))
        return httpx.Response(200, content=b'\xe9' * 8, headers={'content-length': '8'})

    listing, text = patch_release(release_with('esp32-s3-generic'))
    tagged = patch('app.api.firmware_release._fetch_release_by_tag', new_callable=AsyncMock,
                   return_value=tagged_release("2026.9.1"))
    with listing, text, tagged, mocked_httpx(handler):
        response = await no_auth_client.get(
            f'/api/frames/{frame.id}/embedded/ota/download?platform=esp32-s3-generic&version=2026.9.1',
            headers=auth(frame))
        assert response.status_code == 200, response.text
        bad = await no_auth_client.get(
            f'/api/frames/{frame.id}/embedded/ota/download?platform=esp32-s3-generic&version=../x',
            headers=auth(frame))
    assert requested == ['https://github.com/FrameOS/frameos/releases/download/v2026.9.1/'
                         'frameos-2026.9.1-esp32-s3-generic-app.bin']
    assert bad.status_code == 400


@pytest.mark.asyncio
async def test_the_owners_update_button_marks_the_check_manual(async_client, db, redis):
    frame = await board_on(async_client, db, "2026.9.1")
    with patch('app.tasks.embedded_firmware.request_embedded_firmware_update', new_callable=AsyncMock,
               return_value={'applied': False, 'status': 'queued'}):
        response = await async_client.post(f'/api/frames/{frame.id}/embedded/firmware/ota')
    assert response.status_code == 200, response.text
    assert await redis.get(frame_updates.manual_ota_key(frame.id))
    db.expire_all()
    assert db.get(Frame, frame.id).deploy_progress['kind'] == 'firmware'


@pytest.mark.asyncio
async def test_device_upgrade_passes_a_version_through(async_client, db):
    response = await async_client.post('/api/frames/new', json={
        'name': 'Pi', 'frame_host': 'pi.local', 'server_host': 'localhost', 'device': 'web_only',
    })
    frame_id = response.json()['frame']['id']
    relay = AsyncMock(return_value={'status': 'starting'})
    with patch('app.api.frames._relay_device_admin', relay):
        response = await async_client.post(f'/api/frames/{frame_id}/device/upgrade', json={'version': '2026.11.14'})
        assert response.status_code == 200, response.text
        bad = await async_client.post(f'/api/frames/{frame_id}/device/upgrade', json={'version': 'latest'})
    assert relay.await_args.kwargs['body'] == {'dry_run': False, 'version': '2026.11.14'}
    assert bad.status_code == 400
    db.expire_all()
    record = db.get(Frame, frame_id).deploy_progress
    assert record['kind'] == 'upgrade'


# --- the sweep -----------------------------------------------------------

NIGHT = datetime(2026, 11, 21, 3, 0, tzinfo=timezone.utc)
NOON = datetime(2026, 11, 21, 12, 0, tzinfo=timezone.utc)


def linux_frame(db, *, version="2026.11.13", **extra) -> Frame:
    from app.models.organization import Project
    from app.models.user import User
    from app.tenancy import ensure_default_project_for_user

    project = db.query(Project).first()
    if project is None:
        user = User(email="sweep@example.com")
        user.set_password("testpassword")
        db.add(user)
        db.commit()
        project = ensure_default_project_for_user(db, user)
    fields = dict(name="Pi", mode="rpios", frame_host="pi.local", server_host="localhost", server_port=8989,
                  server_api_key=f"k{db.query(Frame).count()}", status="ready", scenes=[], device="web_only", auto_update=True,
                  project_id=project.id, last_successful_deploy={"frameos_version": version})
    fields.update(extra)
    frame = Frame(**fields)
    db.add(frame)
    db.commit()
    return frame


def test_the_window_is_local_time():
    frame = Frame(timezone="Europe/Brussels")
    assert auto_update.in_window(frame, datetime(2026, 11, 21, 2, 30, tzinfo=timezone.utc))  # 03:30 there
    assert not auto_update.in_window(frame, datetime(2026, 11, 21, 4, 30, tzinfo=timezone.utc))  # 05:30
    assert auto_update.in_window(Frame(timezone=None), NIGHT)
    assert auto_update.in_window(Frame(timezone="Not/AZone"), NIGHT)


@pytest.mark.asyncio
async def test_sweep_skips_what_it_must(db, redis):
    off = linux_frame(db, auto_update=False)
    assert (await auto_update.sweep_frame(db, redis, off, manifest_of(), NIGHT)).reason == "automatic updates are off"
    frame = linux_frame(db)
    assert "outside" in (await auto_update.sweep_frame(db, redis, frame, manifest_of(), NOON)).reason
    from app.utils.deploy_progress import start

    frame.deploy_progress = start("upgrade", deploy_id="x", now=NIGHT)
    db.commit()
    assert "in flight" in (await auto_update.sweep_frame(db, redis, frame, manifest_of(), NIGHT)).reason


@pytest.mark.asyncio
async def test_sweep_asks_a_new_runtime_to_upgrade_to_exactly_the_version(db, redis):
    frame = linux_frame(db, version="2026.11.14")
    manifest = manifest_of(released("2026.11.14"), released("2026.11.15"))
    upgrade = AsyncMock(return_value={"status": "starting"})
    with patch("app.tasks.auto_update.request_device_upgrade", upgrade), \
            patch("app.tasks.auto_update.current_frameos_version", return_value="2026.11.15"):
        action = await auto_update.sweep_frame(db, redis, frame, manifest, NIGHT)
        assert (action.action, action.version) == ("upgrade", "2026.11.15")
        assert upgrade.await_args.kwargs["version"] == "2026.11.15"
        # Remembered: not again within 20 hours.
        again = await auto_update.sweep_frame(db, redis, frame, manifest, NIGHT)
    assert again.reason == "nudged in the last 20 hours"


@pytest.mark.asyncio
async def test_sweep_never_goes_past_the_backends_own_version(db, redis):
    frame = linux_frame(db, version="2026.11.14")
    manifest = manifest_of(released("2026.11.14"), released("2026.11.15"))
    with patch("app.tasks.auto_update.current_frameos_version", return_value="2026.11.14"):
        action = await auto_update.sweep_frame(db, redis, frame, manifest, NIGHT)
    assert (action.action, action.reason) == ("skip", "up_to_date")


@pytest.mark.asyncio
async def test_sweep_deploys_an_old_runtime_it_can_reach_over_ssh(db, redis):
    frame = linux_frame(db, version="2026.11.12")
    manifest = manifest_of(released("2026.11.12"), released("2026.11.13"))
    deploy = AsyncMock()
    upgrade = AsyncMock()
    with patch("app.tasks.auto_update.request_device_upgrade", upgrade), \
            patch("app.tasks.auto_update.current_frameos_version", return_value="2026.11.13"):
        action = await auto_update.sweep_frame(db, redis, frame, manifest, NIGHT, enqueue_deploy=deploy)
    assert (action.action, action.version) == ("deploy", "2026.11.13")
    deploy.assert_awaited_once()
    upgrade.assert_not_awaited()


@pytest.mark.asyncio
async def test_sweep_upgrades_an_old_shell_less_runtime_only_to_the_latest(db, redis):
    frame = linux_frame(db, version="2026.11.12", mode="buildroot", buildroot={"adopted": True})
    upgrade = AsyncMock(return_value={"status": "starting"})
    with patch("app.tasks.auto_update.request_device_upgrade", upgrade), \
            patch("app.tasks.auto_update.current_frameos_version", return_value="2026.11.14"):
        # The latest is held: an unpinned upgrade would overshoot.
        held = manifest_of(released("2026.11.12"), released("2026.11.13"), released("2026.11.14", blocked="no"))
        action = await auto_update.sweep_frame(db, redis, frame, held, NIGHT)
        assert action.action == "skip" and "too old" in action.reason
        upgrade.assert_not_awaited()
        await redis.delete(frame_updates.auto_nudge_key(frame.id))
        action = await auto_update.sweep_frame(
            db, redis, frame, manifest_of(released("2026.11.12"), released("2026.11.14")), NIGHT)
    assert action.action == "upgrade"
    assert upgrade.await_args.kwargs["version"] is None


@pytest.mark.asyncio
async def test_sweep_queues_a_boards_firmware_update(async_client, db, redis):
    frame = await board_on(async_client, db, "2026.9.1")
    frame.timezone = "UTC"  # a new frame takes the backend's zone
    db.commit()
    start = AsyncMock(return_value={"applied": False})
    with patch("app.tasks.auto_update.start_embedded_firmware_update", start):
        action = await auto_update.sweep_frame(db, redis, frame, manifest_of(released("2026.9.2")), NIGHT)
    assert (action.action, action.version) == ("firmware", "2026.9.2"), action
    assert start.await_args.kwargs == {"version": "2026.9.2", "wait_seconds": 0}


@pytest.mark.asyncio
async def test_sweep_leaves_a_pico_alone(async_client, db, redis):
    from .test_embedded_device import pico_spectra_frame

    frame = await pico_spectra_frame(async_client, db)
    assert auto_update.frame_kind(frame) is None


def test_the_device_sync_compare_reads_a_missing_key_as_on():
    from app.api import frame_sync

    assert frame_sync._sync_frame_value('auto_update', None) is True
    assert frame_sync._sync_frame_value('auto_update', False) is False
    assert frame_sync._sync_label('auto_update') == 'Install updates automatically'
    assert 'auto_update' in frame_sync.FRAME_SYNC_FRAME_KEYS


@pytest.mark.asyncio
async def test_sweep_does_nothing_without_a_manifest(db, redis):
    linux_frame(db)
    assert await auto_update.auto_update_frames(db, redis, now=NIGHT) == []
