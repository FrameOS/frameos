from fastapi import HTTPException
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives import serialization
from . import api_with_auth
from app.schemas.ssh import SSHKeyResponse

@api_with_auth.post("/generate_ssh_keys", response_model=SSHKeyResponse)
async def generate_ssh_keys():
    try:
        private_key = rsa.generate_private_key(
            public_exponent=65537,
            key_size=3072,
        )
    except Exception:
        raise HTTPException(status_code=500, detail="Key generation error")

    public_key = private_key.public_key()
    private_key_bytes = private_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption()
    )
    public_key_bytes = public_key.public_bytes(
        encoding=serialization.Encoding.OpenSSH,
        format=serialization.PublicFormat.OpenSSH
    )

    return {
        "private": private_key_bytes.decode('utf-8'),
        "public": public_key_bytes.decode('utf-8')
    }
