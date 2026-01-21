from http import HTTPStatus
from fastapi import Depends, HTTPException
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.settings import get_settings_dict, Settings
from app.schemas.settings import SettingsResponse, SettingsUpdateRequest
from app.utils.posthog import initialize_posthog
from . import api_with_auth

@api_with_auth.get("/settings", response_model=SettingsResponse)
async def get_settings(db: Session = Depends(get_db)):
    return get_settings_dict(db)

@api_with_auth.post("/settings", response_model=SettingsResponse)
async def set_settings(data: SettingsUpdateRequest, db: Session = Depends(get_db)):
    payload = data.to_dict()
    if not payload:
        raise HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail="No JSON payload received")

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
        raise HTTPException(status_code=500, detail="Database error")

    updated_settings = get_settings_dict(db)
    if "posthog" in payload:
        initialize_posthog(updated_settings)
    return updated_settings
