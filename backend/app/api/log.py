from fastapi import HTTPException, Depends, Header, Request
from sqlalchemy.orm import Session
from arq import ArqRedis as Redis

from app.database import get_db
from app.models.frame import Frame
from app.models.log import process_log
from app.schemas.log import LogRequest, LogResponse
from app.utils.request_ip import extract_client_ip
from app.redis import get_redis
from . import api_public

@api_public.post("/log", response_model=LogResponse)
async def post_api_log(
    data: LogRequest,
    request: Request,
    db: Session = Depends(get_db),
    redis: Redis = Depends(get_redis),
    authorization: str = Header(None)
):
    if not authorization:
        raise HTTPException(status_code=401, detail="Unauthorized")

    parts = authorization.split(' ')
    if len(parts) != 2:
        raise HTTPException(status_code=401, detail="Invalid Authorization header")

    server_api_key = parts[1]
    frame = db.query(Frame).filter_by(server_api_key=server_api_key).first()

    if not frame:
        raise HTTPException(status_code=401, detail="Unauthorized")

    client_ip = extract_client_ip(
        request.headers,
        request.client.host if request.client else None,
    )

    if data.log:
        await process_log(db, redis, frame, data.log, ip=client_ip)

    if data.logs:
        for log in data.logs:
            await process_log(db, redis, frame, log, ip=client_ip)

    return LogResponse(message="OK")
