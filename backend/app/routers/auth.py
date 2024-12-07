from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from app.schemas.user import UserCreate, UserLogin, UserRead, Token
from app.crud.user import get_user_by_email, create_user
from app.core.deps import get_db
from app.utils.token import create_access_token

router = APIRouter(prefix="/auth", tags=["auth"])

@router.post("/signup", response_model=UserRead, status_code=201)
def signup(user_data: UserCreate, db: Session = Depends(get_db)):
    # Check if a user already exists (like the old code: only one user allowed)
    existing_user = db.query(db.query_user).first()  # adjust as needed
    if existing_user is not None:
        raise HTTPException(status_code=400, detail="User already exists. Please login.")

    if user_data.password != user_data.password2:
        raise HTTPException(status_code=400, detail="Passwords do not match.")

    if get_user_by_email(db, user_data.email):
        raise HTTPException(status_code=400, detail="Please use a different email address.")

    # Create the user
    user = create_user(db, user_data.email, user_data.password)

    # Optionally sign up for newsletter (optional)
    # if user_data.newsletter:
    #     # call external service
    #     pass

    return user

@router.post("/login", response_model=Token)
def login(login_data: UserLogin, db: Session = Depends(get_db)):
    user = get_user_by_email(db, login_data.email)
    if user is None or not user.verify_password(login_data.password):
        raise HTTPException(status_code=401, detail="Invalid email or password")

    access_token = create_access_token(data={"sub": user.email})
    return {"access_token": access_token, "token_type": "bearer"}

@router.post("/logout")
def logout():
    # In a JWT scenario, there's no server-side logout by default.
    # A common pattern is to invalidate the token on the client side,
    # or maintain a token blacklist on server if needed.
    return {"success": True}
