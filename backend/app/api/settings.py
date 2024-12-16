from flask import jsonify, request, g
from sqlalchemy.exc import SQLAlchemyError
from . import api
from app.models.settings import get_settings_dict, Settings

@api.route("/settings", methods=["GET"])
def settings():
    db = g.db
    return jsonify(get_settings_dict(db))

@api.route("/settings", methods=["POST"])
def set_settings():
    db = g.db
    payload = request.get_json()
    if not payload:
        return jsonify(error="No JSON payload received"), 400

    try:
        current_settings = get_settings_dict()
        for key, value in payload.items():
            if value != current_settings.get(key, None):
                if key in current_settings:
                    setting = db.query(Settings).filter_by(key=key).first()
                    setting.value = value
                else:
                    setting = Settings(key=key, value=value)
                    db.add(setting)
        db.commit()
    except SQLAlchemyError:
        return jsonify(error="Database error"), 500

    return jsonify(get_settings_dict())
