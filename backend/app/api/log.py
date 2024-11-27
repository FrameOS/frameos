import gzip
import json
from fastapi import APIRouter, Request, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.models.frame import Frame
from app.models.log import process_log
from app.dependencies import get_db  # Assuming you have this dependency

router = APIRouter()

@router.post('')
async def api_log(request: Request, db: Session = Depends(get_db)):
    auth_header = request.headers.get('Authorization')
    if not auth_header or not auth_header.startswith('Bearer '):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Unauthorized")

    server_api_key = auth_header[len('Bearer '):]
    frame = db.query(Frame).filter_by(server_api_key=server_api_key).first()

    if not frame:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Unauthorized")

    # Read the request body
    body = await request.body()

    # Check if the body is gzipped
    if body[:2] == b'\x1f\x8b':
        # Decompress the gzipped body
        body = gzip.decompress(body)

    # Decode the body to a string
    data = body.decode('utf-8')

    # Parse the JSON data
    data = json.loads(data)

    if 'log' in data:
        process_log(db, frame, data['log'])

    if 'logs' in data:
        for log_item in data['logs']:
            process_log(db, frame, log_item)

    return {"message": "OK"}
