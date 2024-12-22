from pydantic import ConfigDict, RootModel, BaseModel

class SettingsResponse(RootModel):
    pass


class SettingsUpdateRequest(BaseModel):
    model_config = ConfigDict(extra='allow')

    def to_dict(self):
        return self.model_dump()