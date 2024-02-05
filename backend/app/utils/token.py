import secrets
from base64 import urlsafe_b64encode

def secure_token(bytes: int) -> str:
    token_bytes = secrets.token_bytes(bytes)
    token = urlsafe_b64encode(token_bytes).decode('utf-8').replace('=', '')
    return token
