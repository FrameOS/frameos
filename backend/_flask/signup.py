# # backend/app/api/signup.py

# import requests
# from flask import request, jsonify, g
# from flask_login import login_user
# from . import api
# from app.models.user import User

# @api.route('/signup', methods=['POST'])
# def signup():
#     db = g.db
#     # Check if there is already a user registered
#     if db.query(User).first() is not None:
#         return jsonify({'error': 'Only one user is allowed. Please login!'}), 400

#     data = request.get_json()
#     if not data:
#         return jsonify({'error': 'Invalid input'}), 400

#     email = data.get('email')
#     password = data.get('password')
#     password2 = data.get('password2')
#     newsletter = data.get('newsletter', False)

#     errors = {}

#     if not email:
#         errors['email'] = 'Email is required.'
#     if not password:
#         errors['password'] = 'Password is required.'
#     if password != password2:
#         errors['password2'] = 'Passwords do not match.'
#     if db.query(User).filter_by(email=email).first():
#         errors['email'] = 'Please use a different email address.'

#     if errors:
#         return jsonify({'errors': errors}), 400

#     if newsletter:
#         url = "https://buttondown.email/api/emails/embed-subscribe/frameos"
#         data = { "email": email }
#         response = requests.post(url, data=data)
#         if response.status_code != 200:
#             return jsonify({'error': 'Error signing up to newsletter'}), 400

#     user = User(email=email)
#     user.set_password(password)
#     db.add(user)
#     db.commit()

#     login_user(user, remember=True)
#     return jsonify({'success': True}), 201
