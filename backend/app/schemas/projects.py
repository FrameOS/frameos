from pydantic import BaseModel


class OrganizationResponse(BaseModel):
    id: int
    name: str


class ProjectResponse(BaseModel):
    id: int
    name: str
    organization: OrganizationResponse


class ProjectsListResponse(BaseModel):
    projects: list[ProjectResponse]
