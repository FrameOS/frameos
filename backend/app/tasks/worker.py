"""
backend/app/tasks/worker.py

This file defines:
- The arq worker settings (how to run the worker).
- The tasks/coroutines that run via arq.
"""

from httpx import AsyncClient
from typing import Any, Dict
from arq.connections import RedisSettings
from arq.worker import func

from app.tasks.deploy_frame import deploy_frame_task
from app.tasks.reset_frame import reset_frame_task
from app.tasks.restart_frame import restart_frame_task
from app.tasks.stop_frame import stop_frame_task
from app.config import get_config
from app.redis import create_redis_connection
from app.database import SessionLocal


REDIS_SETTINGS = RedisSettings.from_dsn(get_config().REDIS_URL)

# Optional: on_startup logic
async def startup(ctx: Dict[str, Any]):
    """
    Example: if you want to open a single shared httpx session or DB session in the worker
    """
    ctx['client'] = AsyncClient()
    ctx['redis'] = create_redis_connection()
    ctx['db'] = SessionLocal()
    print("Worker startup: created shared HTTPX client")

# Optional: on_shutdown logic
async def shutdown(ctx: Dict[str, Any]):
    """
    Example: close that shared session
    """
    if 'client' in ctx:
        await ctx['client'].aclose()
    if 'redis' in ctx:
        await ctx['redis'].close()
    if 'db' in ctx:
        ctx['db'].close()

    print("Worker shutdown: closed shared HTTPX client")


class WorkerSettings:
    """
    WorkerSettings is what `arq` uses to actually run the worker process.
    You will run it with `arq app.tasks.WorkerSettings`.
    """
    functions = [
        func(deploy_frame_task,  name="deploy_frame"),
        func(reset_frame_task,   name="reset_frame"),
        func(restart_frame_task, name="restart_frame"),
        func(stop_frame_task,    name="stop_frame"),
    ]
    on_startup = startup
    on_shutdown = shutdown

    # Connect to the same redis instance used in your app:
    redis_settings = REDIS_SETTINGS

    # Keep results for 1 hour (3600s) by default, or set any other retention
    keep_result = 3600

    # max concurrency:
    max_jobs = 10

    # If you want to allow job abort (stop/cancel):
    allow_abort_jobs = True
