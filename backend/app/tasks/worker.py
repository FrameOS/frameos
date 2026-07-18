"""
backend/app/tasks/worker.py

Defines the arq worker settings and the task functions that run via arq.
"""

import asyncio
from functools import wraps
from httpx import AsyncClient
from typing import Any, Awaitable, Callable, Dict
from arq.connections import RedisSettings
from arq.worker import func

from app.tasks.deploy_frame import deploy_frame_task
from app.tasks.fast_deploy_frame import fast_deploy_frame_task
from app.tasks.reset_frame import reset_frame_task
from app.tasks.restart_frame import restart_frame_task, reboot_frame_task
from app.tasks.stop_frame import stop_frame_task
from app.tasks.deploy_remote import deploy_remote_task
from app.tasks.restart_remote import restart_remote_task
from app.tasks.buildroot_image import buildroot_sd_image_task
from app.tasks.embedded_firmware import embedded_firmware_task
from app.config import config
from app.redis import close_redis_connection, create_redis_connection
from app.database import SessionLocal

REDIS_SETTINGS = RedisSettings.from_dsn(config.REDIS_URL)


def with_db_session(task_func: Callable[..., Awaitable[Any]]) -> Callable[..., Awaitable[Any]]:
    """Give each job its own SQLAlchemy session.

    arq shares a single ``ctx`` dict across all concurrently-running jobs, so a
    Session stored there would be used by up to ``max_jobs`` jobs at once: one
    job's commit would flush another's half-applied state, and ``expire_all()``
    would invalidate ORM objects out from under in-flight jobs. Inject a fresh
    session into a per-call ctx copy and close it when the job ends.
    """
    @wraps(task_func)
    async def wrapper(ctx: Dict[str, Any], *args: Any, **kwargs: Any) -> Any:
        db = SessionLocal()
        local_ctx = {**ctx, "db": db}
        try:
            return await task_func(local_ctx, *args, **kwargs)
        finally:
            db.close()
    return wrapper

# Optional: on_startup logic
async def startup(ctx: Dict[str, Any]):
    ctx['client'] = AsyncClient()
    ctx['redis'] = create_redis_connection()
    # The Home Assistant sync service runs in the worker because it must be a
    # singleton: the HA add-on starts two uvicorns (public + ingress) but only
    # one worker process.
    if not config.TEST:
        from app.ha.sync import ha_sync_service
        ctx['ha_sync_task'] = asyncio.create_task(ha_sync_service.run())
        # Same singleton slot for the FrameOS Cloud sync (grants revocation,
        # inventory heartbeat, automatic frame backups after deploys).
        from app.cloud.sync import cloud_sync_service
        ctx['cloud_sync_task'] = asyncio.create_task(cloud_sync_service.run())
    print("Worker startup: created shared HTTPX client and Redis")

# Optional: on_shutdown logic
async def shutdown(ctx: Dict[str, Any]):
    if 'client' in ctx:
        await ctx['client'].aclose()
    for task_key in ('ha_sync_task', 'cloud_sync_task'):
        if task := ctx.pop(task_key, None):
            task.cancel()
            try:
                await task
            except (asyncio.CancelledError, Exception):
                pass
    if 'redis' in ctx:
        await close_redis_connection(ctx['redis'])

    print("Worker shutdown: closed resources")


class WorkerSettings:
    """
    WorkerSettings is what `arq` uses to run the worker process.
    You run it with: `arq app.tasks.worker.WorkerSettings`.
    """
    functions = [
        func(with_db_session(deploy_frame_task),      name="deploy_frame"),
        func(with_db_session(fast_deploy_frame_task), name="fast_deploy_frame"),
        func(with_db_session(reset_frame_task),       name="reset_frame"),
        func(with_db_session(restart_frame_task),     name="restart_frame"),
        func(with_db_session(reboot_frame_task),      name="reboot_frame"),
        func(with_db_session(stop_frame_task),        name="stop_frame"),
        func(with_db_session(deploy_remote_task),     name="deploy_remote"),
        func(with_db_session(restart_remote_task),    name="restart_remote"),
        func(with_db_session(buildroot_sd_image_task), name="buildroot_sd_image"),
        func(with_db_session(embedded_firmware_task), name="embedded_firmware"),
    ]
    on_startup = startup
    on_shutdown = shutdown

    redis_settings = REDIS_SETTINGS
    keep_result = 3600  # Keep results for 1 hour
    max_jobs = 10
    job_timeout = 21600
    allow_abort_jobs = True
