from fastapi import HTTPException, Request, Depends
from fastapi.responses import JSONResponse
from app.database import get_db
from sqlalchemy.orm import Session
from app.models.frame import Frame
from app.models.log import process_log

from . import public_api

@public_api.post("/log")
async def post_api_log(request: Request, db: Session = Depends(get_db)):
    auth_header = request.headers.get('Authorization')
    if not auth_header:
        raise HTTPException(status_code=401, detail="Unauthorized")

    parts = auth_header.split(' ')
    if len(parts) != 2:
        raise HTTPException(status_code=401, detail="Invalid Authorization header")

    server_api_key = parts[1]
    frame = db.query(Frame).filter_by(server_api_key=server_api_key).first()

    if not frame:
        raise HTTPException(status_code=401, detail="Unauthorized")

    data = await request.json()
    if log := data.get('log'):
        await process_log(db, frame, log)

    if logs := data.get('logs'):
        for log in logs:
            await process_log(db, frame, log)

    return JSONResponse(status_code=200, content={"message": "OK"})
