import secrets
import base64
import jwt
from datetime import datetime, timedelta
from typing import Union

SECRET_KEY = "YOUR_JWT_SECRET_KEY"
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 30

def create_access_token(data: dict, expires_delta: Union[timedelta, None] = None):
    to_encode = data.copy()
    expire = datetime.utcnow() + (expires_delta or timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES))
    to_encode.update({"exp": expire})
    return jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)

def decode_token(token: str):
    return jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])

def secure_token(length: int = 32) -> str:
    # Generate a token with `length` bytes of random data
    # Then base64-url encode it, strip any trailing '=' for cleanliness
    token_bytes = secrets.token_bytes(length)
    token = base64.urlsafe_b64encode(token_bytes).decode('utf-8').rstrip('=')
    return token