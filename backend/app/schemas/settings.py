from pydantic import RootModel

class SettingsResponse(RootModel):
    pass


class SettingsUpdateRequest(RootModel):
    def to_dict(self):
        return self.__root__
