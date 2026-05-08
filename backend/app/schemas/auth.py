from pydantic import BaseModel, field_validator

class Token(BaseModel):
    access_token: str
    token_type: str

class UserSignup(BaseModel):
    email: str
    password: str
    password2: str
    newsletter: bool = False

    @field_validator("email")
    @classmethod
    def validate_email(cls, value: str) -> str:
        email = value.strip()
        if email.count("@") != 1:
            raise ValueError("Please enter a valid email address.")

        local_part, domain = email.split("@")
        if not local_part or not domain or any(char.isspace() for char in email):
            raise ValueError("Please enter a valid email address.")

        return email
