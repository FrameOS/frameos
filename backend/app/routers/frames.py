from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from typing import List
from app.schemas.frame import FrameOut, FrameCreate, FrameUpdate
from app.crud.frame import get_frames, get_frame, create_frame, update_frame, delete_frame
from app.core.deps import get_db, get_current_user

router = APIRouter(
    prefix="/frames",
    tags=["frames"]
)

@router.get("/", response_model=List[FrameOut])
def list_frames(db: Session = Depends(get_db), current_user: dict = Depends(get_current_user)):
    print("WAT")
    frames = get_frames(db)
    return frames

@router.get("/{frame_id}", response_model=FrameOut)
def get_frame_by_id(frame_id: int, db: Session = Depends(get_db), current_user: dict = Depends(get_current_user)):
    frame = get_frame(db, frame_id)
    if not frame:
        raise HTTPException(status_code=404, detail="Frame not found")
    return frame

@router.post("/new", response_model=FrameOut, status_code=201)
def create_new_frame(data: FrameCreate, db: Session = Depends(get_db), current_user: dict = Depends(get_current_user)):
    try:
        frame = create_frame(db, data)
        return frame
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception:
        raise HTTPException(status_code=500, detail="Internal Server Error")

@router.post("/{frame_id}", response_model=FrameOut)
def update_frame_by_id(frame_id: int, data: FrameUpdate, db: Session = Depends(get_db), current_user: dict = Depends(get_current_user)):
    frame = get_frame(db, frame_id)
    if not frame:
        raise HTTPException(status_code=404, detail="Frame not found")
    try:
        updated = update_frame(db, frame, data)
        # Handle next_action if specified (e.g. restart, stop, deploy) by invoking the relevant tasks
        return updated
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception:
        raise HTTPException(status_code=500, detail="Internal Server Error")

@router.delete("/{frame_id}")
def delete_frame_by_id(frame_id: int, db: Session = Depends(get_db), current_user: dict = Depends(get_current_user)):
    success = delete_frame(db, frame_id)
    if success:
        return {"message": "Frame deleted successfully"}
    else:
        raise HTTPException(status_code=404, detail="Frame not found")
