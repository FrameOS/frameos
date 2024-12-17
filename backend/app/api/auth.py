import datetime
from typing import Optional

from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer, OAuth2PasswordRequestForm
from jose import jwt, JWTError
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.config import get_config
from app.models.user import User
from app.database import get_db
from werkzeug.security import generate_password_hash, check_password_hash

from . import public_api

config = get_config()
SECRET_KEY = config.SECRET_KEY
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 60

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="api/login")

class Token(BaseModel):
    access_token: str
    token_type: str

class UserLogin(BaseModel):
    email: str
    password: str

class UserSignup(BaseModel):
    email: str
    password: str
    password2: str
    newsletter: bool = False

def create_access_token(data: dict, expires_delta: Optional[datetime.timedelta] = None):
    to_encode = data.copy()
    if expires_delta:
        expire = datetime.datetime.utcnow() + expires_delta
    else:
        expire = datetime.datetime.utcnow() + datetime.timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    to_encode.update({"exp": expire})
    # Encode the token using python-jose
    encoded_jwt = jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)
    return encoded_jwt

async def get_current_user(token: str = Depends(oauth2_scheme), db: Session = Depends(get_db)):
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )
    try:
        # Decode token using python-jose
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
def login(form_data: OAuth2PasswordRequestForm = Depends(), db: Session = Depends(get_db)):
    email = form_data.username
    password = form_data.password
    user = db.query(User).filter_by(email=email).first()
    if user is None or not check_password_hash(user.password, password):
        raise HTTPException(status_code=401, detail="Invalid email or password")

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

    if db.query(User).filter_by(email=data.email).first():
        raise HTTPException(status_code=400, detail="Email already in use.")

    # Handle newsletter signup if needed

    user = User(email=data.email)
    user.password = generate_password_hash(data.password)
    db.add(user)
    db.commit()

    # Auto-login after signup:
    access_token_expires = datetime.timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    access_token = create_access_token(data={"sub": user.email}, expires_delta=access_token_expires)
    return {"success": True, "access_token": access_token, "token_type": "bearer"}
