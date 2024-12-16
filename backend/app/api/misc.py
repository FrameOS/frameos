from flask import jsonify
from . import api


@api.route("/generate_ssh_keys", methods=["POST"])
def generate_ssh_keys():
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.hazmat.primitives import serialization

    try:
        private_key = rsa.generate_private_key(
            public_exponent=65537,
            key_size=3072,
        )
    except:  # noqa: E722
        return jsonify(error="Key generation error"), 500

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

    return jsonify({"private": private_key_bytes.decode('utf-8'), "public": public_key_bytes.decode('utf-8')})
