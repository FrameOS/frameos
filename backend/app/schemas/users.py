from pydantic import BaseModel

class HasFirstUserResponse(BaseModel):
    has_first_user: bool
