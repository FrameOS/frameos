from fastapi import Depends, Header, HTTPException, Request, status
from sqlalchemy.orm import Session
from app import config as app_config
from app.api.auth import get_current_user_from_request
from app.database import get_db
from app.models.user import User
from app.schemas.users import HasFirstUserResponse, UserPasswordUpdate, UserResponse
from . import api_no_auth, api_with_auth

@api_no_auth.get("/has_first_user", response_model=HasFirstUserResponse)
def has_first_user(db: Session = Depends(get_db)):
    return {"has_first_user": db.query(User).first() is not None}


async def get_current_local_user(
    request: Request,
    authorization: str | None = Header(default=None),
    db: Session = Depends(get_db),
) -> User:
    if app_config.config.HASSIO_RUN_MODE is not None:
        raise HTTPException(status_code=401, detail="Account management is not available with HASSIO_RUN_MODE.")

    user = await get_current_user_from_request(request, db, authorization)
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Could not validate credentials",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return user


@api_with_auth.get("/user", response_model=UserResponse)
def api_user_get(current_user: User = Depends(get_current_local_user)):
    return {"email": current_user.email}


@api_with_auth.post("/user/password", response_model=UserResponse)
def api_user_update_password(
    data: UserPasswordUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_local_user),
):
    if not data.current_password:
        raise HTTPException(status_code=400, detail="Current password is required.")
    if not current_user.check_password(data.current_password):
        raise HTTPException(status_code=400, detail="Current password is incorrect.")
    if not data.password:
        raise HTTPException(status_code=400, detail="New password is required.")
    if data.password != data.password2:
        raise HTTPException(status_code=400, detail="Passwords do not match.")
    if len(data.password) < 8:
        raise HTTPException(status_code=400, detail="Password too short.")

    current_user.set_password(data.password)
    db.add(current_user)
    db.commit()

    return {"email": current_user.email}
