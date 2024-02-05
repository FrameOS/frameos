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
    except SQLAlchemyError:
        return jsonify(error="Database error"), 500

    return jsonify(get_settings_dict())
