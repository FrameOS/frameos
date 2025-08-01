"""
backend/app/tasks/worker.py

Defines the arq worker settings and the task functions that run via arq.
"""

from httpx import AsyncClient
from typing import Any, Dict
from arq.connections import RedisSettings
from arq.worker import func

from app.tasks.build_sd_card_image import build_sd_card_image_task
from app.tasks.deploy_frame import deploy_frame_task
from app.tasks.fast_deploy_frame import fast_deploy_frame_task
from app.tasks.reset_frame import reset_frame_task
from app.tasks.restart_frame import restart_frame_task, reboot_frame_task
from app.tasks.stop_frame import stop_frame_task
from app.tasks.deploy_agent import deploy_agent_task
from app.tasks.restart_agent import restart_agent_task
from app.config import config
from app.redis import create_redis_connection
from app.database import SessionLocal

REDIS_SETTINGS = RedisSettings.from_dsn(config.REDIS_URL)

# Optional: on_startup logic
async def startup(ctx: Dict[str, Any]):
    ctx['client'] = AsyncClient()
    ctx['redis'] = create_redis_connection()
    ctx['db'] = SessionLocal()
    print("Worker startup: created shared HTTPX client, Redis, and DB session")

# Optional: on_shutdown logic
async def shutdown(ctx: Dict[str, Any]):
    if 'client' in ctx:
        await ctx['client'].aclose()
    if 'redis' in ctx:
        await ctx['redis'].close()
    if 'db' in ctx:
        ctx['db'].close()

    print("Worker shutdown: closed resources")


class WorkerSettings:
    """
    WorkerSettings is what `arq` uses to run the worker process.
    You run it with: `arq app.tasks.worker.WorkerSettings`.
    """
    functions = [
        func(build_sd_card_image_task, name="build_sd_card_image"),
        func(deploy_frame_task,      name="deploy_frame"),
        func(fast_deploy_frame_task, name="fast_deploy_frame"),
        func(reset_frame_task,       name="reset_frame"),
        func(restart_frame_task,     name="restart_frame"),
        func(reboot_frame_task,      name="reboot_frame"),
        func(stop_frame_task,        name="stop_frame"),
        func(deploy_agent_task,      name="deploy_agent"),
        func(restart_agent_task,     name="restart_agent"),
    ]
    on_startup = startup
    on_shutdown = shutdown

    redis_settings = REDIS_SETTINGS
    keep_result = 3600  # Keep results for 1 hour
    max_jobs = 10
    job_timeout = 7200
    allow_abort_jobs = True
