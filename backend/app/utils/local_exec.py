from __future__ import annotations

from typing import Literal, Optional, Tuple

from arq import ArqRedis
from sqlalchemy.orm import Session

from app.models.frame import Frame
from app.utils.build_executor import create_build_executor
from app.utils.modal_sandbox import get_modal_sandbox_config


async def exec_local_command(
    db: Session | None,
    redis: ArqRedis | None,
    frame: Frame,
    command: str,
    log_command: str | bool = True,
    log_output: bool = True,
    stderr_log_tag: Literal["stderr", "stdout"] = "stderr",
) -> Tuple[int, Optional[str], Optional[str]]:
    project_id = getattr(frame, "project_id", None)
    # Keep this compatibility helper scoped to local/Modal execution. Build-host
    # commands need structured path syncing via explicit BuildExecutor use.
    modal_config = get_modal_sandbox_config(db, project_id) if project_id is not None else None
    executor = create_build_executor(
        modal_config,
        db=db,
        redis=redis,
        frame=frame,
    )
    async with executor:
        return await executor.run(
            command,
            log_command=log_command,
            log_output=log_output,
            stderr_log_tag=stderr_log_tag,
        )
