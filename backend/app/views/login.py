from flask_wtf import FlaskForm
from wtforms import StringField, PasswordField, BooleanField, SubmitField
from wtforms.validators import DataRequired
from flask import redirect, url_for, render_template, flash, jsonify
from flask_login import login_user, logout_user, login_required, current_user

from . import views
from app.models.user import User

class LoginForm(FlaskForm):
    username = StringField('Username', validators=[DataRequired()])
    password = PasswordField('Password', validators=[DataRequired()])
    remember_me = BooleanField('Remember Me')
    submit = SubmitField('Sign In')

@views.route('/login', methods=['GET', 'POST'])
def login():
    if User.query.first() is None:
        flash('Please register the first user!')
        return redirect(url_for('views.register'))
    if current_user.is_authenticated:
        return redirect(url_for('views.index'))
    form = LoginForm()
    if form.validate_on_submit():
        user = User.query.filter_by(username=form.username.data).first()
        if user is None or not user.check_password(form.password.data):
            flash('Invalid username or password')
            return redirect(url_for('views.login'))
        login_user(user, remember=form.remember_me.data)
        return redirect(url_for('views.index'))
    return render_template('login.html', title='Sign In', form=form)

@views.route('/logout')
@login_required
def logout():
    logout_user()
    return redirect(url_for('views.index'))