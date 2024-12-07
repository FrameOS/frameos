import pytest
from app.models.user import User, pwd_context

def test_user_password_verification(db_session):
    user = User(email='test@example.com', password=pwd_context.hash('secret123'))
    db_session.add(user)
    db_session.commit()

    db_user = db_session.query(User).filter_by(email='test@example.com').first()
    assert db_user is not None
    assert db_user.verify_password('secret123') is True
    assert db_user.verify_password('wrongpass') is False

def test_user_unique_email(db_session):
    user1 = User(email='unique@example.com', password=pwd_context.hash('password'))
    db_session.add(user1)
    db_session.commit()

    user2 = User(email='unique@example.com', password=pwd_context.hash('anotherpass'))
    db_session.add(user2)
    with pytest.raises(Exception):
        # Trying to commit another user with the same email should fail due to uniqueness constraint
        db_session.commit()
