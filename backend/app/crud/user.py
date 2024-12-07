from sqlalchemy.orm import Session
from app.models.user import User, pwd_context

def get_user_by_email(db: Session, email: str) -> User:
    return db.query(User).filter(User.email == email).first()

def create_user(db: Session, email: str, password: str) -> User:
    hashed_password = pwd_context.hash(password)
    user = User(email=email, password=hashed_password)
    db.add(user)
    db.commit()
    db.refresh(user)
    return user
