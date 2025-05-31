"""
Bridge between background-queue workers and the in-process agent
websocket code.  Workers push jobs to a Redis list; we pop them here,
forward to `queue_command`, then push the reply back so the worker can
continue.
"""

from __future__ import annotations

import asyncio
import json
import base64

from arq import ArqRedis as Redis

from app.ws.agent_ws import queue_command

CMD_QUEUE   = "agent:cmd:queue"      # RPush by workers, BLPop by us
RESP_PREFIX = "agent:resp:"          # per-command response list


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
            # malformed data – fail fast so caller sees the error
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
        reply  = {"ok": True, "result": result}
    except Exception as e:  # noqa: BLE001
        reply = {"ok": False, "error": str(e)}

    resp_key = f"{RESP_PREFIX}{cmd_id}"
    await redis.rpush(resp_key, json.dumps(reply).encode())
    await redis.expire(resp_key, 60)  # drop after 60 s just in case


async def agent_command_worker(redis: Redis) -> None:  # launched on startup
    while True:
        try:
            _key, raw = await redis.blpop(CMD_QUEUE, timeout=0)
            await _handle_one(redis, raw)
        except Exception:  # noqa: BLE001
            # keep the loop alive – errors are logged to stderr
            pass


def start_background_listener(app) -> None:
    """
    Kick off the Redis-listener task once the FastAPI app starts.
    Call from an `@app.on_event("startup")` handler.
    """
    redis: Redis = app.state.redis       # already initialised elsewhere
    app.state.agent_cmd_listener = asyncio.create_task(agent_command_worker(redis))
