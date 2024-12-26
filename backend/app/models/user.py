from werkzeug.security import generate_password_hash, check_password_hash
from sqlalchemy import Integer, String
from sqlalchemy.orm import mapped_column
from app.database import Base

class User(Base):
    __tablename__ = 'user'
    id = mapped_column(Integer, primary_key=True)
    email = mapped_column(String(120), unique=True)
    password = mapped_column(String(128))

    def set_password(self, password):
        self.password = generate_password_hash(password)

    def check_password(self, password):
        return check_password_hash(self.password, password)
