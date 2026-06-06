from http import HTTPStatus
from fastapi import Depends, HTTPException
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.settings import get_settings_dict, Settings
from app.schemas.settings import SettingsResponse, SettingsUpdateRequest
from app.tenancy import current_project_id
from app.utils.build_environment import selected_build_environment_provider
from app.utils.build_host import BuildHostConfig, BuildHostSession
from app.utils.modal_sandbox import ModalSandboxConfig, ModalSandboxSession
from app.utils.posthog import initialize_posthog
from . import api_project

@api_project.get("/settings", response_model=SettingsResponse)
async def get_settings(db: Session = Depends(get_db)):
    return get_settings_dict(db, project_id=current_project_id())

@api_project.post("/settings", response_model=SettingsResponse)
async def set_settings(data: SettingsUpdateRequest, db: Session = Depends(get_db)):
    project_id = current_project_id()
    payload = data.to_dict()
    if not payload:
        raise HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail="No JSON payload received")

    provider = selected_build_environment_provider(payload)
    if isinstance(payload.get("buildHost"), dict):
        payload["buildHost"] = {**payload["buildHost"], "enabled": provider == "buildHost"}
    if isinstance(payload.get("modalSandbox"), dict):
        payload["modalSandbox"] = {**payload["modalSandbox"], "enabled": provider == "modal"}

    try:
        current_settings = get_settings_dict(db, project_id=project_id)
        for key, value in payload.items():
            if value != current_settings.get(key):
                setting = db.query(Settings).filter_by(project_id=project_id, key=key).first()
                if setting:
                    setting.value = value
                else:
                    new_setting = Settings(project_id=project_id, key=key, value=value)
                    db.add(new_setting)
        db.commit()
    except SQLAlchemyError:
        raise HTTPException(status_code=500, detail="Database error")

    updated_settings = get_settings_dict(db, project_id=project_id)
    if "posthog" in payload:
        initialize_posthog(updated_settings, project_id=project_id)
    return updated_settings


@api_project.post("/settings/test_build_host")
async def test_build_host(data: SettingsUpdateRequest):
    payload = data.to_dict()
    raw_build_host_settings = payload.get("buildHost") if isinstance(payload, dict) else None
    build_host_config = BuildHostConfig.from_settings(
        {**raw_build_host_settings, "enabled": True} if isinstance(raw_build_host_settings, dict) else raw_build_host_settings
    )
    if build_host_config is None:
        raise HTTPException(
            status_code=HTTPStatus.BAD_REQUEST,
            detail="Select build host via SSH and enter a host, user, and private SSH key first",
        )

    try:
        async with BuildHostSession(build_host_config) as build_host:
            status, out, err = await build_host.run(
                "echo frameos-build-host-ok && command -v docker >/dev/null && docker buildx version >/dev/null",
                log_command=False,
                log_output=False,
            )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=HTTPStatus.BAD_GATEWAY, detail=f"Build host connection failed: {exc}") from exc

    if status != 0:
        raise HTTPException(
            status_code=HTTPStatus.BAD_GATEWAY,
            detail=err or out or "Build host is missing Docker or the Docker Buildx plugin",
        )

    return {"ok": True, "output": (out or "").strip()}


@api_project.post("/settings/test_modal_sandbox")
async def test_modal_sandbox(data: SettingsUpdateRequest):
    payload = data.to_dict()
    raw_modal_settings = payload.get("modalSandbox") if isinstance(payload, dict) else None
    modal_config = ModalSandboxConfig.from_settings(raw_modal_settings)
    if modal_config is None:
        raise HTTPException(
            status_code=HTTPStatus.BAD_REQUEST,
            detail="Select Modal sandboxes and enter a token ID and token secret first",
        )

    try:
        async with ModalSandboxSession(modal_config) as sandbox:
            status, out, err = await sandbox.run(
                "command -v nimble && nimble --version >/dev/null && echo frameos-modal-sandbox-ok",
                log_command=False,
                log_output=False,
            )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=HTTPStatus.BAD_GATEWAY, detail=f"Modal sandbox test failed: {exc}") from exc

    if status != 0:
        raise HTTPException(
            status_code=HTTPStatus.BAD_GATEWAY,
            detail=err or out or "Modal sandbox image is missing the FrameOS Nim toolchain",
        )

    return {"ok": True, "output": (out or "").strip()}
