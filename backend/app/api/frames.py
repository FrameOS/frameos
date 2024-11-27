from fastapi import APIRouter, Depends, HTTPException, status
from app.models.frame import Frame
from app.models.user import User
from app.dependencies import get_current_user

router = APIRouter()

@router.get("/")
async def api_frames(current_user: User = Depends(get_current_user)):
    try:
        frames = Frame.query.all()
        frames_list = [frame.to_dict() for frame in frames]
        return {"frames": frames_list}
    except Exception as e:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e))
