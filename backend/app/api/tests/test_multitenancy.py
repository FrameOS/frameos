from http import HTTPStatus

import pytest
from sqlalchemy.orm import Session

from app.models.assets import Assets
from app.models.frame import Frame
from app.models.user import User
from app.api.auth import create_access_token
from app.tenancy import ensure_default_project_for_user

pytestmark = pytest.mark.asyncio


def create_user_with_project(db: Session, email: str):
    user = User(email=email)
    user.set_password("testpassword")
    db.add(user)
    db.commit()
    db.refresh(user)
    project = ensure_default_project_for_user(db, user)
    return user, project


def authorize_client(client, user: User):
    client.headers.update({"Authorization": f"Bearer {create_access_token({'sub': user.email})}"})


async def test_project_access_is_required(no_auth_client, db: Session):
    user, project = create_user_with_project(db, "tenant1@example.com")
    authorize_client(no_auth_client, user)
    _, other_project = create_user_with_project(db, "tenant2@example.com")

    response = await no_auth_client.get(f"/api/projects/{other_project.id}/assets")

    assert response.status_code == HTTPStatus.NOT_FOUND


async def test_assets_are_scoped_to_selected_project(no_auth_client, db: Session):
    user, project = create_user_with_project(db, "tenant1@example.com")
    authorize_client(no_auth_client, user)
    _, other_project = create_user_with_project(db, "tenant2@example.com")
    asset = Assets(project_id=other_project.id, path="fonts/Other.ttf", data=b"font")
    db.add(asset)
    db.commit()
    db.refresh(asset)

    response = await no_auth_client.get(f"/api/projects/{project.id}/assets/{asset.id}")

    assert response.status_code == HTTPStatus.NOT_FOUND


async def test_frames_are_scoped_to_selected_project(no_auth_client, db: Session):
    user, project = create_user_with_project(db, "tenant1@example.com")
    authorize_client(no_auth_client, user)
    _, other_project = create_user_with_project(db, "tenant2@example.com")
    frame = Frame(
        project_id=other_project.id,
        name="Other project frame",
        frame_host="other-frame.local",
        status="ready",
    )
    db.add(frame)
    db.commit()
    db.refresh(frame)

    response = await no_auth_client.get(f"/api/projects/{project.id}/frames/{frame.id}/logs")

    assert response.status_code == HTTPStatus.NOT_FOUND


@pytest.mark.parametrize(
    "path",
    [
        "reset",
        "restart",
        "reboot",
        "deploy_agent",
        "restart_agent",
        "stop",
        "deploy",
    ],
)
async def test_frame_task_routes_require_frame_in_selected_project(no_auth_client, db: Session, path: str):
    user, project = create_user_with_project(db, "tenant1@example.com")
    authorize_client(no_auth_client, user)
    _, other_project = create_user_with_project(db, "tenant2@example.com")
    frame = Frame(
        project_id=other_project.id,
        name="Other project frame",
        frame_host="other-frame.local",
        status="ready",
    )
    db.add(frame)
    db.commit()
    db.refresh(frame)

    response = await no_auth_client.post(f"/api/projects/{project.id}/frames/{frame.id}/{path}")

    assert response.status_code == HTTPStatus.NOT_FOUND
