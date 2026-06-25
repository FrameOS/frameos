from __future__ import annotations

import asyncio
import base64
from contextlib import asynccontextmanager
import json
import uuid
from arq import ArqRedis as Redis

from app.utils.env import get_env_float

CMD_KEY = "remote:cmd:{id}"     # per-frame inbound queue
RESP_KEY = "remote:resp:{id}"   # per-command outbound queue
STREAM_KEY = "remote:cmd:stream:{id}"

_frame_locks: dict[int, asyncio.Lock] = {}


DEFAULT_REMOTE_COMMAND_QUEUE_TIMEOUT = get_env_float(
    "REMOTE_COMMAND_QUEUE_TIMEOUT",
    30.0,
)


def _get_frame_lock(frame_id: int) -> asyncio.Lock:
    lock = _frame_locks.get(frame_id)
    if lock is None:
        lock = asyncio.Lock()
        _frame_locks[frame_id] = lock
    return lock


@asynccontextmanager
async def frame_command_slot(
    frame_id: int,
    queue_timeout: float | None = DEFAULT_REMOTE_COMMAND_QUEUE_TIMEOUT,
):
    lock = _get_frame_lock(frame_id)
    acquired = False
    try:
        if queue_timeout is None:
            await lock.acquire()
        else:
            try:
                await asyncio.wait_for(lock.acquire(), timeout=queue_timeout)
            except asyncio.TimeoutError as exc:
                raise TimeoutError(
                    f"remote command queue busy for frame {frame_id} after {queue_timeout:g}s"
                ) from exc
        acquired = True
        yield
    finally:
        if acquired:
            lock.release()

async def send_cmd(
    redis: Redis,
    frame_id: int,
    payload: dict,
    *,
    blob: bytes | None = None,
    timeout: int = 120,
    queue_timeout: float | None = DEFAULT_REMOTE_COMMAND_QUEUE_TIMEOUT,
):
    async with frame_command_slot(frame_id, queue_timeout):
        cmd_id = str(uuid.uuid4())
        job = {
            "id": cmd_id,
            "frame_id": frame_id,
            "payload": payload,
            "timeout": timeout,
        }
        if blob is not None:
            job["blob"] = base64.b64encode(blob).decode()

        await redis.rpush(CMD_KEY.format(id=frame_id), json.dumps(job).encode())

        res = await redis.blpop(RESP_KEY.format(id=cmd_id), timeout=timeout)
        if res is None:                                    # ⏰ timed out
            raise TimeoutError(f"remote timed-out after {timeout}s")

        key, raw = res
        reply = json.loads(raw)
        if not reply.get("ok"):
            raise RuntimeError(reply.get("result", {}).get("error") or reply.get("error", "remote error"))

        if reply.get("binary"):
            return base64.b64decode(reply["result"])
        res = reply.get("result")

        # --- nested binary inside an http dict ------------------------------
        if isinstance(res, dict) and res.get("binary"):
            body = res.get("body")
            if isinstance(body, str):                  # base64 string → bytes
                res["body"] = base64.b64decode(body)
        return res
