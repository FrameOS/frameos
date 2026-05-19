from werkzeug.security import generate_password_hash, check_password_hash
from sqlalchemy import Boolean, Integer, String, Text
from sqlalchemy.orm import mapped_column
from app.database import Base

class User(Base):
    __tablename__ = 'user'
    id = mapped_column(Integer, primary_key=True)
    email = mapped_column(String(120), unique=True)
    password = mapped_column(String(256))
    cloud_auth_required = mapped_column(Boolean, nullable=False, default=False)
    cloud_user_id = mapped_column(String(128), nullable=True)
    cloud_backend_link_id = mapped_column(String(128), nullable=True)
    cloud_backend_name = mapped_column(String(256), nullable=True)
    cloud_backend_url = mapped_column(String(1024), nullable=True)
    cloud_backend_token = mapped_column(Text, nullable=True)

    def set_password(self, password):
        self.password = generate_password_hash(password)

    def check_password(self, password):
        return check_password_hash(self.password, password)
