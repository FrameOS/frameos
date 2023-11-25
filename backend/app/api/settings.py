from flask import jsonify, request
from flask_login import login_required
from sqlalchemy.exc import SQLAlchemyError
from app import db
from . import api
from app.models.settings import get_settings_dict, Settings

@api.route("/settings", methods=["GET"])
@login_required
def settings():
    return jsonify(get_settings_dict())

@api.route("/settings", methods=["POST"])
@login_required
def set_settings():
    payload = request.get_json()
    if not payload:
        return jsonify(error="No JSON payload received"), 400

    try:
        current_settings = get_settings_dict()
        for key, value in payload.items():
            if value != current_settings.get(key, None):
                if key in current_settings:
                    setting = Settings.query.filter_by(key=key).first()
                    setting.value = value
                else:
                    setting = Settings(key=key, value=value)
                    db.session.add(setting)
        db.session.commit()
    except SQLAlchemyError as e:
        return jsonify(error="Database error"), 500

    return jsonify(get_settings_dict())

@api.route("/generate_ssh_keys", methods=["POST"])
@login_required
def generate_ssh_keys():
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.hazmat.primitives import serialization

    try:
        private_key = rsa.generate_private_key(
            public_exponent=65537,
            key_size=3072,
        )
    except Exception as e:
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
