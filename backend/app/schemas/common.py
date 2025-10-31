from pydantic import BaseModel


class ImageTokenResponse(BaseModel):
    token: str
    expires_in: int

