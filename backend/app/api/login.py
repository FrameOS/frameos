from flask import request, jsonify
from flask_login import login_user, logout_user, login_required

from . import api
from app.models.user import User

@api.route('/login', methods=['POST'])
def login():
    if User.query.first() is None:
        return jsonify({'error': 'Please register a user first!'}), 404

    email = request.json.get('email', None)
    password = request.json.get('password', None)

    if email is not None and password is not None:
        user = User.query.filter_by(email=email).first()
        if user is None or not user.check_password(password):
            return jsonify({'error': 'Invalid email or password'}), 401
        login_user(user, remember=True)
        return jsonify({'success': True})
    return jsonify({'error': 'Please specify an email and a password'}), 401

@api.route('/logout', methods=['POST'])
@login_required
def logout():
    logout_user()
    return jsonify({'success': True})
