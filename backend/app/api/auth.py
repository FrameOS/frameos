import datetime
from typing import Optional

from fastapi import Depends, HTTPException, status, Request
from fastapi.security import OAuth2PasswordBearer, OAuth2PasswordRequestForm
from jose import jwt, JWTError
from sqlalchemy.orm import Session
from redis.asyncio import Redis

from app.config import get_config
from app.models.user import User
from app.database import get_db
from app.redis import get_redis
from werkzeug.security import generate_password_hash, check_password_hash
from app.schemas.auth import Token, UserSignup

from . import public_api

config = get_config()
SECRET_KEY = config.SECRET_KEY
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 7 * 24 * 60  # 7 days

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="api/login")

def create_access_token(data: dict, expires_delta: Optional[datetime.timedelta] = None):
    to_encode = data.copy()
    if expires_delta:
        expire = datetime.datetime.utcnow() + expires_delta
    else:
        expire = datetime.datetime.utcnow() + datetime.timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    to_encode.update({"exp": expire})
    encoded_jwt = jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)
    return encoded_jwt

async def get_current_user(token: str = Depends(oauth2_scheme), db: Session = Depends(get_db)):
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        email: str = payload.get("sub")
        if email is None:
            raise credentials_exception
    except JWTError:
        raise credentials_exception

    user = db.query(User).filter(User.email == email).first()
    if user is None:
        raise credentials_exception
    return user

@public_api.post("/login", response_model=Token)
async def login(request: Request, form_data: OAuth2PasswordRequestForm = Depends(), db: Session = Depends(get_db), redis: Redis = Depends(get_redis)):
    email = form_data.username
    password = form_data.password
    ip = request.client.host
    key = f"login_attempts:{ip}"
    attempts = (await redis.get(key)) or '0'
    if int(attempts) > 10:  # limit to 10 attempts for example
        raise HTTPException(status_code=429, detail="Too many login attempts")

    user = db.query(User).filter_by(email=email).first()
    if user is None or not check_password_hash(user.password, password):
        await redis.incr(key)
        await redis.expire(key, 300)  # expire after 5 minutes
        raise HTTPException(status_code=401, detail="Invalid email or password")

    await redis.delete(key)
    access_token_expires = datetime.timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    access_token = create_access_token(data={"sub": user.email}, expires_delta=access_token_expires)
    return {"access_token": access_token, "token_type": "bearer"}

@public_api.post("/signup")
def signup(data: UserSignup, db: Session = Depends(get_db)):
    # Check if there is already a user registered (one-user system)
    if db.query(User).first() is not None:
        raise HTTPException(status_code=400, detail="Only one user is allowed. Please login!")

    if not data.email:
        raise HTTPException(status_code=400, detail="Email is required.")
    if not data.password:
        raise HTTPException(status_code=400, detail="Password is required.")
    if data.password != data.password2:
        raise HTTPException(status_code=400, detail="Passwords do not match.")
    if len(data.password) < 8:
        raise HTTPException(status_code=400, detail="Password too short.")

    if db.query(User).filter_by(email=data.email).first():
        raise HTTPException(status_code=400, detail="Email already in use.")

    # TODO: Handle newsletter signup

    user = User(email=data.email)
    user.password = generate_password_hash(data.password)
    db.add(user)
    db.commit()

    # Auto-login after signup:
    access_token_expires = datetime.timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    access_token = create_access_token(data={"sub": user.email}, expires_delta=access_token_expires)
    return {"success": True, "access_token": access_token, "token_type": "bearer"}
