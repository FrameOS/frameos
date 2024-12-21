from pydantic import RootModel, BaseModel

class SettingsResponse(RootModel):
    pass


class SettingsUpdateRequest(BaseModel):
    # Let’s allow arbitrary keys:
    __allow_extra__ = True  # or in pydantic v2: class Config: extra = "allow"

    # We'll store everything in a dict
    def to_dict(self):
        return self.model_dump()
