import datetime

from fastapi import Depends, Header, HTTPException, Request, Response, status
from sqlalchemy.orm import Session
from app import config as app_config
from app.api.auth import (
    ACCESS_TOKEN_EXPIRE_MINUTES,
    _should_use_secure_cookie,
    current_session_id,
    get_current_user_from_request,
)
from app.database import get_db
from app.models.user import User
from app.schemas.users import HasFirstUserResponse, UserEmailUpdate, UserPasswordUpdate, UserResponse
from app.models.user_session import (
    create_user_session,
    revoke_sessions_for_user,
)
from app.utils.session_cookie import SESSION_COOKIE_NAME, create_session_cookie_value
from . import api_open, api_user

@api_open.get("/has_first_user", response_model=HasFirstUserResponse)
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


@api_user.get("/user", response_model=UserResponse)
def api_user_get(current_user: User = Depends(get_current_local_user)):
    return {"email": current_user.email}


@api_user.post("/user/email", response_model=UserResponse)
def api_user_update_email(
    data: UserEmailUpdate,
    request: Request,
    response: Response,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_local_user),
):
    if data.email == current_user.email:
        return {"email": current_user.email}
    # The email is the login name, so changing it is as sensitive as changing
    # the password: a stolen cookie must not be enough. Cloud-created users
    # have no local password (see the password route) and are already
    # authenticated here.
    if current_user.password:
        if not data.current_password:
            raise HTTPException(status_code=400, detail="Current password is required.")
        if not current_user.check_password(data.current_password):
            raise HTTPException(status_code=400, detail="Current password is incorrect.")
    if db.query(User).filter(User.email == data.email, User.id != current_user.id).first() is not None:
        raise HTTPException(status_code=400, detail="Email already in use.")

    current_user.email = data.email
    db.add(current_user)
    db.commit()

    access_token_expires = datetime.timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    session_id = create_user_session(
        db,
        user_id=current_user.id,
        expires_at=datetime.datetime.utcnow() + access_token_expires,
    )
    # Every other session (including the bearer token of the browser doing the
    # changing) ends here; the fresh cookie below is the one credential left.
    revoke_sessions_for_user(db, current_user.id, keep_session_id=session_id)
    session_value, max_age = create_session_cookie_value(
        email=current_user.email, session_id=session_id, expires_delta=access_token_expires
    )
    response.set_cookie(
        key=SESSION_COOKIE_NAME,
        value=session_value,
        max_age=max_age,
        httponly=True,
        samesite="lax",
        secure=_should_use_secure_cookie(request),
    )

    return {"email": current_user.email}


@api_user.post("/user/password", response_model=UserResponse)
def api_user_update_password(
    data: UserPasswordUpdate,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_local_user),
):
    # A cloud-created user has no local password at all (cloud signup leaves it
    # NULL). Requiring the current one would leave them no way to ever set one,
    # so if the cloud link later breaks — revoked, provider gone, or
    # FRAMEOS_CLOUD_URL=disabled — they would be locked out with no recovery
    # short of editing the database. They are already authenticated here.
    if current_user.password:
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

    # A password change is also how someone reacts to a stolen laptop or a
    # leaked cookie, so every other session ends here. The browser doing the
    # changing keeps its own.
    revoke_sessions_for_user(db, current_user.id, keep_session_id=current_session_id(request))

    return {"email": current_user.email}
