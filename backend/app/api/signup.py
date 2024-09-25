# backend/app/api/signup.py

from flask import request, jsonify
from flask_login import login_user
from app import db
from . import api
from app.models.user import User

@api.route('/signup', methods=['POST'])
def signup():
    # Check if there is already a user registered
    if User.query.first() is not None:
        return jsonify({'error': 'Only one user is allowed. Please login!'}), 400

    data = request.get_json()
    if not data:
        return jsonify({'error': 'Invalid input'}), 400

    email = data.get('email')
    password = data.get('password')
    password2 = data.get('password2')

    errors = {}

    if not email:
        errors['email'] = 'Email is required.'
    if not password:
        errors['password'] = 'Password is required.'
    if password != password2:
        errors['password2'] = 'Passwords do not match.'
    if User.query.filter_by(email=email).first():
        errors['email'] = 'Please use a different email address.'

    if errors:
        return jsonify({'errors': errors}), 400

    user = User(email=email)
    user.set_password(password)
    db.session.add(user)
    db.session.commit()
    login_user(user, remember=True)
    return jsonify({'success': True}), 201
