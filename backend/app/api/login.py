from flask import request, jsonify, g
from flask_login import login_user, logout_user

from . import api
from app.models.user import User

@api.route('/login', methods=['POST'])
def login():
    db = g.db
    if db.query(User).first() is None:
        return jsonify({'error': 'Please register a user first!'}), 404

    email = request.json.get('email', None)
    password = request.json.get('password', None)

    if email is not None and password is not None:
        user = db.query(User).filter_by(email=email).first()
        if user is None or not user.check_password(password):
            return jsonify({'error': 'Invalid email or password'}), 401
        login_user(user, remember=True)
        return jsonify({'success': True})
    return jsonify({'error': 'Please specify an email and a password'}), 401

@api.route('/logout', methods=['POST'])
def logout():
    logout_user()
    return jsonify({'success': True})
