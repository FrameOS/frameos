from http import HTTPStatus
from fastapi import Depends, Request
from fastapi.responses import JSONResponse
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.settings import get_settings_dict, Settings
from . import api

@api.get("/settings")
async def get_settings(db: Session = Depends(get_db)):
    return JSONResponse(content=get_settings_dict(db), status_code=200)

@api.post("/settings")
async def set_settings(request: Request, db: Session = Depends(get_db)):
    payload = await request.json()
    if not payload:
        return JSONResponse(content={"error": "No JSON payload received"}, status_code=HTTPStatus.BAD_REQUEST)

    try:
        current_settings = get_settings_dict(db)
        for key, value in payload.items():
            if value != current_settings.get(key):
                setting = db.query(Settings).filter_by(key=key).first()
                if setting:
                    setting.value = value
                else:
                    new_setting = Settings(key=key, value=value)
                    db.add(new_setting)
        db.commit()
    except SQLAlchemyError:
        return JSONResponse(content={"error": "Database error"}, status_code=HTTPStatus.INTERNAL_SERVER_ERROR)

    return JSONResponse(content=get_settings_dict(db), status_code=200)
