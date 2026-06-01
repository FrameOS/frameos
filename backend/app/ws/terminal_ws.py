from __future__ import annotations

import contextlib
import asyncio
import json
import uuid
from fastapi import APIRouter, WebSocket, WebSocketDisconnect, Depends
from sqlalchemy.orm import Session
from arq import ArqRedis as Redis

from app.database import SessionLocal
from app.redis import get_redis
from app.models.frame import Frame
from app.api.auth import get_current_user_from_websocket
from app.tenancy import get_user_project
from app.utils.ssh_utils import get_ssh_connection, remove_ssh_connection
from app.ws.agent_bridge import CMD_KEY, RESP_KEY, STREAM_KEY, frame_command_slot
from app.ws.agent_ws import number_of_connections_for_frame

router = APIRouter()

AGENT_TERMINAL_TIMEOUT_SECONDS = 60 * 60
AGENT_TERMINAL_IDLE_TIMEOUT_SECONDS = 5 * 60


def _agent_terminal_configured(frame: Frame) -> bool:
    agent = frame.agent if isinstance(frame.agent, dict) else {}
    return bool(
        agent.get("agentEnabled")
        and agent.get("agentRunCommands")
        and agent.get("deployWithAgent") is not False
    )


async def _should_use_agent_terminal(redis: Redis, frame: Frame) -> bool:
    if not _agent_terminal_configured(frame):
        return False
    return (await number_of_connections_for_frame(redis, frame.id)) > 0


def _redis_key_name(key: bytes | str) -> str:
    return key.decode() if isinstance(key, bytes) else key


async def _queue_agent_terminal_command(
    redis: Redis,
    frame: Frame,
    command_id: str,
    name: str,
    args: dict,
    timeout: int = AGENT_TERMINAL_TIMEOUT_SECONDS,
) -> None:
    await redis.rpush(
        CMD_KEY.format(id=frame.id),
        json.dumps(
            {
                "id": command_id,
                "frame_id": frame.id,
                "payload": {"type": "cmd", "name": name, "args": args},
                "log": False,
                "timeout": timeout,
            }
        ).encode(),
    )


async def _send_agent_stream_chunk(websocket: WebSocket, chunk: dict) -> None:
    data = str(chunk.get("data", ""))
    if not data:
        return
    if chunk.get("raw"):
        await websocket.send_text(data)
        return
    await websocket.send_text(data if data.endswith("\n") else f"{data}\n")


async def _run_agent_terminal_command(
    websocket: WebSocket,
    redis: Redis,
    frame: Frame,
    command: str,
) -> None:
    command = command.strip()
    if not command:
        return

    await websocket.send_text(f"$ {command}\n")

    async with frame_command_slot(frame.id):
        cmd_id = str(uuid.uuid4())
        await redis.rpush(
            CMD_KEY.format(id=frame.id),
            json.dumps(
                {
                    "id": cmd_id,
                    "frame_id": frame.id,
                    "payload": {"type": "cmd", "name": "shell", "args": {"cmd": command}},
                    "log": False,
                    "timeout": AGENT_TERMINAL_TIMEOUT_SECONDS,
                }
            ).encode(),
        )

        stream_key = STREAM_KEY.format(id=cmd_id)
        resp_key = RESP_KEY.format(id=cmd_id)

        try:
            while True:
                res = await redis.blpop([stream_key, resp_key], timeout=AGENT_TERMINAL_TIMEOUT_SECONDS)
                if res is None:
                    await websocket.send_text(
                        f"*** agent command timed out after {AGENT_TERMINAL_TIMEOUT_SECONDS}s ***\n"
                    )
                    return

                key, raw = res
                key_name = _redis_key_name(key)

                if key_name == stream_key:
                    chunk = json.loads(raw)
                    await _send_agent_stream_chunk(websocket, chunk)
                    continue

                if key_name == resp_key:
                    reply = json.loads(raw)
                    ok = bool(reply.get("ok"))
                    result = reply.get("result")
                    exit_status = 0 if ok else 1
                    if isinstance(result, dict):
                        exit_status = int(result.get("exit", exit_status) or exit_status)
                    if not ok and exit_status:
                        await websocket.send_text(f"*** command exited with status {exit_status} ***\n")
                    return
        finally:
            with contextlib.suppress(Exception):
                await redis.delete(stream_key)


async def _agent_terminal(websocket: WebSocket, redis: Redis, frame: Frame) -> None:
    terminal_id = str(uuid.uuid4())
    stream_key = STREAM_KEY.format(id=terminal_id)
    resp_key = RESP_KEY.format(id=terminal_id)

    await websocket.send_text("*** connected via FrameOS agent PTY ***\n")
    await _queue_agent_terminal_command(
        redis,
        frame,
        terminal_id,
        "terminal_open",
        {"term": "xterm-256color", "cols": 120, "rows": 30},
    )

    async def output_pump() -> None:
        while True:
            res = await redis.blpop([stream_key, resp_key], timeout=AGENT_TERMINAL_IDLE_TIMEOUT_SECONDS)
            if res is None:
                continue

            key, raw = res
            key_name = _redis_key_name(key)
            if key_name == stream_key:
                await _send_agent_stream_chunk(websocket, json.loads(raw))
                continue

            if key_name == resp_key:
                reply = json.loads(raw)
                ok = bool(reply.get("ok"))
                result = reply.get("result")
                exit_status = 0 if ok else 1
                error = ""
                if isinstance(result, dict):
                    exit_status = int(result.get("exit", exit_status) or exit_status)
                    error = str(result.get("error") or "")
                if error:
                    await websocket.send_text(f"\n*** agent terminal error: {error} ***\n")
                elif exit_status:
                    await websocket.send_text(f"\n*** terminal exited with status {exit_status} ***\n")
                else:
                    await websocket.send_text("\n*** terminal exited ***\n")
                return

    async def input_pump() -> None:
        while True:
            message = await websocket.receive_text()
            await _queue_agent_terminal_command(
                redis,
                frame,
                str(uuid.uuid4()),
                "terminal_input",
                {"terminal_id": terminal_id, "data": message},
                timeout=30,
            )

    output_task = asyncio.create_task(output_pump())
    input_task = asyncio.create_task(input_pump())
    try:
        done, pending = await asyncio.wait(
            {output_task, input_task},
            return_when=asyncio.FIRST_COMPLETED,
        )
        for task in done:
            with contextlib.suppress(WebSocketDisconnect):
                task.result()
    finally:
        for task in (output_task, input_task):
            task.cancel()
        await asyncio.gather(output_task, input_task, return_exceptions=True)
        with contextlib.suppress(Exception):
            await _queue_agent_terminal_command(
                redis,
                frame,
                str(uuid.uuid4()),
                "terminal_close",
                {"terminal_id": terminal_id},
                timeout=30,
            )
        with contextlib.suppress(Exception):
            await redis.delete(stream_key, resp_key)
        with contextlib.suppress(Exception):
            await websocket.close()


@router.websocket("/ws/projects/{project_id}/terminal/{frame_id}")
async def ssh_terminal(
    websocket: WebSocket,
    project_id: int,
    frame_id: int,
    redis: Redis = Depends(get_redis),
):
    db: Session = SessionLocal()
    try:
        user, error_reason = get_current_user_from_websocket(websocket, db)
    finally:
        db.close()

    if user is None:
        await websocket.close(code=1008, reason=error_reason or "Could not validate credentials")
        return

    db = SessionLocal()
    try:
        project = get_user_project(db, user, project_id)
    finally:
        db.close()

    if project is None:
        await websocket.close(code=1008, reason="Project not found")
        return

    await websocket.accept()

    db = SessionLocal()
    try:
        frame = db.query(Frame).filter(Frame.project_id == project_id, Frame.id == frame_id).first()
    finally:
        db.close()

    if frame is None:
        await websocket.close(code=1008, reason="Frame not found")
        return

    if await _should_use_agent_terminal(redis, frame):
        await _agent_terminal(websocket, redis, frame)
        return

    db = SessionLocal()
    try:
        try:
            ssh = await get_ssh_connection(db, redis, frame)
        except Exception as exc:
            await websocket.send_text(f"*** failed to connect over SSH: {exc} ***\n")
            await websocket.close(code=1011, reason="Failed to connect to frame")
            return
    finally:
        db.close()

    proc = await ssh.create_process(term_type="xterm", encoding="utf-8")

    async def pipe(reader):
        try:
            while True:
                data = await reader.read(1024)
                if not data:
                    break
                await websocket.send_text(data)
        except Exception:
            pass

    stdout_task = asyncio.create_task(pipe(proc.stdout))
    stderr_task = asyncio.create_task(pipe(proc.stderr))

    try:
        while True:
            msg = await websocket.receive_text()
            proc.stdin.write(msg)
    except WebSocketDisconnect:
        pass
    finally:
        stdout_task.cancel()
        stderr_task.cancel()
        with contextlib.suppress(Exception):
            proc.stdin.write_eof()
            await proc.wait_closed()

        db = SessionLocal()
        try:
            await remove_ssh_connection(db, redis, ssh, frame)
        finally:
            db.close()
