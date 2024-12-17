from fastapi import Depends
from sqlalchemy.orm import Session
from app.database import get_db
from app.models.user import User

from . import public_api

@public_api.get("/has_first_user")
def has_first_user(db: Session = Depends(get_db)):
    return {"has_first_user": db.query(User).first() is not None}
