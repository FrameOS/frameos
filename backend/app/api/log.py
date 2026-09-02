import json

from fastapi import HTTPException, Depends, Header, Request
from fastapi.exceptions import RequestValidationError
from pydantic import ValidationError
from sqlalchemy.orm import Session
from arq import ArqRedis as Redis

from app.database import get_db
from app.models.frame import Frame
from app.models.log import process_log
from app.schemas.log import LogRequest, LogResponse
from app.utils.rate_limit import hit_rate_limit
from app.utils.request_ip import client_ip_for_request
from app.redis import get_redis
from . import api_public

# A frame's logger batches lines between check-ins; nothing legitimate needs
# more than this per request, and a leaked key must not be able to fill the
# database (LOG_LIMIT_PER_FRAME prunes, but every insert still costs).
MAX_LOG_BODY_BYTES = 2 * 1024 * 1024
MAX_LOG_ENTRIES_PER_BATCH = 500
MAX_LOG_LINE_BYTES = 64 * 1024
LOG_REQUESTS_PER_MINUTE = 600


def _frame_from_bearer(
    request: Request,
    db: Session = Depends(get_db),
    authorization: str = Header(None),
) -> Frame:
    """The key and the declared size are checked before the body is read: the
    route parses the JSON itself, so an unauthenticated caller never gets its
    body decoded (FastAPI reads a declared body param before dependencies)."""
    if not authorization:
        raise HTTPException(status_code=401, detail="Unauthorized")

    parts = authorization.split(' ')
    if len(parts) != 2 or parts[0].lower() != "bearer" or not parts[1]:
        raise HTTPException(status_code=401, detail="Invalid Authorization header")

    server_api_key = parts[1]
    frame = db.query(Frame).filter_by(server_api_key=server_api_key).first()

    if not frame:
        raise HTTPException(status_code=401, detail="Unauthorized")

    content_length = request.headers.get("content-length")
    if content_length and content_length.isdigit() and int(content_length) > MAX_LOG_BODY_BYTES:
        raise HTTPException(status_code=413, detail="Log batch too large")
    return frame


def _check_log_entry(entry) -> None:
    if len(json.dumps(entry).encode("utf-8")) > MAX_LOG_LINE_BYTES:
        raise HTTPException(status_code=413, detail="Log line too long")


@api_public.post("/log", response_model=LogResponse)
async def post_api_log(
    request: Request,
    frame: Frame = Depends(_frame_from_bearer),
    db: Session = Depends(get_db),
    redis: Redis = Depends(get_redis),
):
    if await hit_rate_limit(redis, "frame_log", str(frame.id), limit=LOG_REQUESTS_PER_MINUTE, window_seconds=60):
        raise HTTPException(status_code=429, detail="Too many log requests")

    body = await request.body()
    if len(body) > MAX_LOG_BODY_BYTES:
        raise HTTPException(status_code=413, detail="Log batch too large")
    try:
        data = LogRequest.model_validate(json.loads(body) if body else {})
    except ValueError as exc:  # json.JSONDecodeError is a ValueError
        if isinstance(exc, ValidationError):
            raise RequestValidationError(exc.errors())
        raise HTTPException(status_code=400, detail="Invalid JSON body")

    if data.logs is not None and len(data.logs) > MAX_LOG_ENTRIES_PER_BATCH:
        raise HTTPException(status_code=413, detail="Too many log entries in one batch")
    if data.log is not None:
        _check_log_entry(data.log)
    for log in data.logs or []:
        _check_log_entry(log)

    client_ip = client_ip_for_request(request)

    if data.log:
        await process_log(db, redis, frame, data.log, ip=client_ip)

    if data.logs:
        # Commit per line, not per batch: a batch-wide transaction stayed open
        # across awaited Redis publishes, holding the SQLite write lock while
        # other requests blocked the event loop waiting for it. WAL mode with
        # synchronous=NORMAL makes per-line commits cheap.
        for log in data.logs:
            await process_log(db, redis, frame, log, ip=client_ip)

    return LogResponse(message="OK")
