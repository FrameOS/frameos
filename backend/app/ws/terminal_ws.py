from __future__ import annotations

import contextlib
import asyncio
from fastapi import APIRouter, WebSocket, WebSocketDisconnect, Depends
from sqlalchemy.orm import Session
from arq import ArqRedis as Redis

from app.database import SessionLocal
from app.redis import get_redis
from app.models.frame import Frame
from app.api.auth import get_current_user_from_websocket
from app.utils.ssh_utils import get_ssh_connection, remove_ssh_connection

router = APIRouter()

@router.websocket("/ws/terminal/{frame_id}")
async def ssh_terminal(
    websocket: WebSocket,
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

    await websocket.accept()

    db = SessionLocal()
    try:
        frame = db.query(Frame).filter(Frame.id == frame_id).first()
    finally:
        db.close()

    if frame is None:
        await websocket.close(code=1008, reason="Frame not found")
        return

    db = SessionLocal()
    try:
        ssh = await get_ssh_connection(db, redis, frame)
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
