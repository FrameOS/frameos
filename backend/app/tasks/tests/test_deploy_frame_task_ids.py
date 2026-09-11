from __future__ import annotations

import pytest

from app.tasks.deploy_frame import deploy_frame, deploy_task_log_line
from app.tasks.fast_deploy_frame import fast_deploy_frame


class FakeRedis:
    def __init__(self):
        self.jobs = []

    async def enqueue_job(self, name: str, **kwargs):
        # arq answers a job id it already holds with None.
        job_id = kwargs.get("_job_id")
        if job_id and any(existing.get("_job_id") == job_id for _name, existing in self.jobs):
            return None
        self.jobs.append((name, kwargs))
        return object()


@pytest.mark.asyncio
async def test_deploy_frame_enqueues_task_id_as_job_id():
    redis = FakeRedis()

    task_id = await deploy_frame(7, redis, task_id="deploy:7:test")

    assert task_id == "deploy:7:test"
    assert redis.jobs == [
        (
            "deploy_frame",
            {
                "id": 7,
                "task_id": "deploy:7:test",
                "_job_id": "deploy:7:test",
            },
        )
    ]


@pytest.mark.asyncio
async def test_fast_deploy_frame_enqueues_task_id_as_job_id():
    redis = FakeRedis()

    task_id = await fast_deploy_frame(7, redis, task_id="fast-deploy:7:test")

    assert task_id == "fast-deploy:7:test"
    assert redis.jobs == [
        (
            "fast_deploy_frame",
            {
                "id": 7,
                "task_id": "fast-deploy:7:test",
                "_job_id": "fast-deploy:7:test",
            },
        )
    ]


def test_deploy_task_log_line_anchors_task_id():
    assert deploy_task_log_line("deploy:7:test", "completed", "fast") == (
        "[frameos-task:deploy:7:test] deploy completed fast"
    )
