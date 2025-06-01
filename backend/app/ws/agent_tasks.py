from __future__ import annotations

import asyncio
import json
import base64            # << added
from arq import ArqRedis as Redis

from app.ws.agent_ws import queue_command                     # unchanged

CMD_QUEUE   = "agent:cmd:queue"
RESP_PREFIX = "agent:resp:"


async def _handle_one(redis: Redis, raw: bytes) -> None:
    job = json.loads(raw)
    cmd_id   = job["id"]
    frame_id = job["frame_id"]
    payload  = job["payload"]
    timeout  = job.get("timeout", 120)
    blob_b64 = job.get("blob")

    blob: bytes | None = None
    if blob_b64 is not None:
        try:
            blob = base64.b64decode(blob_b64)
        except Exception:
            resp_key = f"{RESP_PREFIX}{cmd_id}"
            await redis.rpush(
                resp_key,
                json.dumps({"ok": False, "error": "cannot decode blob"}).encode(),
            )
            await redis.expire(resp_key, 60)
            return

    try:
        fut, _ = queue_command(frame_id, payload, blob)
        result = await asyncio.wait_for(fut, timeout=timeout)

        if isinstance(result, (bytes, bytearray)):
            reply = {
                "ok": True,
                "binary": True,
                "result": base64.b64encode(result).decode(),
            }
        elif (
            isinstance(result, dict)
            and result.get("binary")
            and isinstance(result.get("body"), (bytes, bytearray))
        ):
            fixed = dict(result)
            fixed["body"] = base64.b64encode(fixed["body"]).decode()
            fixed["body_b64"] = True
            reply = {"ok": True, "result": fixed}
        else:
            reply = {"ok": True, "result": result}

    except Exception as e:  # noqa: BLE001
        reply = {"ok": False, "error": str(e)}

    resp_key = f"{RESP_PREFIX}{cmd_id}"
    await redis.rpush(resp_key, json.dumps(reply).encode())
    await redis.expire(resp_key, 60)


async def agent_command_worker(redis: Redis) -> None:
    while True:
        try:
            _key, raw = await redis.blpop(CMD_QUEUE, timeout=0)
            await _handle_one(redis, raw)
        except Exception:  # noqa: BLE001
            pass


def start_background_listener(app) -> None:
    redis: Redis = app.state.redis
    app.state.agent_cmd_listener = asyncio.create_task(agent_command_worker(redis))
