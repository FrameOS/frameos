from pydantic import BaseModel, EmailStr

class Token(BaseModel):
    access_token: str
    token_type: str

class UserSignup(BaseModel):
    email: EmailStr
    password: str
    password2: str
    newsletter: bool = False
