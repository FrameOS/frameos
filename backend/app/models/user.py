from sqlalchemy import Column, Integer, String
from app.core.database import Base
from passlib.context import CryptContext

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True)
    email = Column(String(120), unique=True, index=True)
    password = Column(String(128))

    def verify_password(self, plain_password: str) -> bool:
        return pwd_context.verify(plain_password, self.password)
