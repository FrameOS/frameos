from fastapi import APIRouter, Request, HTTPException, status
from app.models.frame import Frame
from app.models.log import process_log

router = APIRouter()

@router.post("/")
async def api_log(request: Request):
    print("!!!!!!!")
    auth_header = request.headers.get('Authorization')
    if not auth_header:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Unauthorized")

    print(auth_header)

    server_api_key = auth_header.split(' ')[1]
    frame = Frame.query.filter_by(server_api_key=server_api_key).first()

    if not frame:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Unauthorized")

    data = await request.json()
    if log := data.get('log', None):
        process_log(frame, log)

    if logs := data.get('logs', None):
        for log in logs:
            process_log(frame, log)

    return {"message": "OK"}