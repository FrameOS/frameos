from fastapi import HTTPException
from fastapi.responses import JSONResponse
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives import serialization
from . import private_api

@private_api.post("/generate_ssh_keys")
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

    return JSONResponse(content={
        "private": private_key_bytes.decode('utf-8'),
        "public": public_key_bytes.decode('utf-8')
    })
