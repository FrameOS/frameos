"""Cloud config backups and the local tarball export (CLOUD-TODO Phase 3).

Templates and frame configs can be pushed to / restored from the linked
FrameOS Cloud provider (scopes ``backup:templates`` / ``backup:frames``), and
everything can always be exported as a plain local tarball — the do-it-
yourself alternative that works without any cloud.
"""
from __future__ import annotations

import base64
import datetime
import io
import json
import tarfile
from http import HTTPStatus

from arq import ArqRedis as Redis
from fastapi import Depends, HTTPException
from fastapi.responses import Response
from sqlalchemy.orm import Session

from app.api.auth import get_current_user
from app.api.templates import parse_template_zip, safe_template_name, template_zip_bytes
from app.database import get_db
from app.models.cloud import current_cloud_backend_link
from app.models.frame import Frame
from app.models.organization import OrganizationMember, Project
from app.models.template import Template
from app.models.user import User
from app.redis import get_redis
from app.schemas.cloud import (
    CloudBackupRestoreRequest,
    CloudBackupSaveFrameRequest,
    CloudBackupSaveTemplateRequest,
    CloudStatusResponse,
)
from app.tenancy import get_user_project
from app.utils import cloud_backup, cloud_link
from app.websockets import publish_message

from . import api_user

# Frame columns a cloud restore may write. Everything else (credentials, TLS
# material, tokens) is regenerated or re-entered locally; a cloud backup never
# contained it in the first place (see app/utils/cloud_backup.py).
FRAME_RESTORE_FIELDS = (
    "name",
    "mode",
    "frame_host",
    "frame_port",
    "frame_access",
    "ssh_user",
    "ssh_port",
    "server_host",
    "server_port",
    "server_send_logs",
    "width",
    "height",
    "device",
    "device_config",
    "color",
    "timezone",
    "timezone_updater",
    "interval",
    "metrics_interval",
    "max_http_response_bytes",
    "scaling_mode",
    "image_engine",
    "rotate",
    "flip",
    "background_color",
    "debug",
    "scenes",
    "log_to_file",
    "assets_path",
    "save_assets",
    "upload_fonts",
    "reboot",
    "control_code",
    "schedule",
    "gpio_buttons",
    "network",
    "agent",
    "mountpoints",
    "error_behavior",
    "palette",
    "buildroot",
    "embedded",
    "rpios",
)


def _require_user(current_user: User | None) -> User:
    if current_user is None:
        raise HTTPException(status_code=HTTPStatus.UNAUTHORIZED, detail="Log in first")
    return current_user


def _require_linked(db: Session, scope: str):
    link = current_cloud_backend_link(db)
    access_token = cloud_backup.link_access_token(link)
    if link is None or access_token is None:
        raise HTTPException(status_code=HTTPStatus.CONFLICT, detail="This install is not linked to FrameOS Cloud")
    if scope not in link.scopes:
        raise HTTPException(
            status_code=HTTPStatus.FORBIDDEN,
            detail=f"The cloud link is missing the {scope} permission; reconnect with it enabled",
        )
    return link, access_token


def _user_project_or_404(db: Session, user: User, project_id: int) -> Project:
    project = get_user_project(db, user, project_id)
    if project is None:
        raise HTTPException(status_code=HTTPStatus.NOT_FOUND, detail="Project not found")
    return project


def _user_projects(db: Session, user: User) -> list[Project]:
    return (
        db.query(Project)
        .join(OrganizationMember, OrganizationMember.organization_id == Project.organization_id)
        .filter(OrganizationMember.user_id == user.id)
        .order_by(Project.id.asc())
        .all()
    )


@api_user.get("/cloud/backups", response_model=CloudStatusResponse)
async def list_cloud_backups(
    db: Session = Depends(get_db), current_user: User | None = Depends(get_current_user)
):
    _require_user(current_user)
    link = current_cloud_backend_link(db)
    access_token = cloud_backup.link_access_token(link)
    if link is None or access_token is None:
        raise HTTPException(status_code=HTTPStatus.CONFLICT, detail="This install is not linked to FrameOS Cloud")
    has_scope = any(scope in link.scopes for scope in ("backup:templates", "backup:frames"))
    if not has_scope:
        return {"backups": [], "missing_scope": True}
    try:
        status_code, response = await cloud_link.backup_list(link.provider_url, access_token)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            status_code=HTTPStatus.BAD_GATEWAY, detail=f"Could not reach {link.provider_url}: {exc}"
        ) from exc
    if status_code != 200:
        detail = response.get("error") or f"unexpected status {status_code}"
        raise HTTPException(status_code=HTTPStatus.BAD_GATEWAY, detail=f"FrameOS Cloud error: {detail}")
    return {"backups": response.get("backups") or [], "missing_scope": False}


@api_user.post("/cloud/backups/templates", response_model=CloudStatusResponse)
async def backup_template_to_cloud(
    data: CloudBackupSaveTemplateRequest,
    db: Session = Depends(get_db),
    current_user: User | None = Depends(get_current_user),
):
    user = _require_user(current_user)
    link, access_token = _require_linked(db, "backup:templates")
    template = db.query(Template).filter_by(id=data.template_id).first()
    if template is None or get_user_project(db, user, template.project_id) is None:
        raise HTTPException(status_code=HTTPStatus.NOT_FOUND, detail="Template not found")

    try:
        status_code, response = await cloud_backup.push_template_backup(
            link, access_token, str(template.id), template.name, template_zip_bytes(template)
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            status_code=HTTPStatus.BAD_GATEWAY, detail=f"Could not reach {link.provider_url}: {exc}"
        ) from exc
    if status_code != 200:
        detail = response.get("error") or f"unexpected status {status_code}"
        raise HTTPException(status_code=HTTPStatus.BAD_GATEWAY, detail=f"FrameOS Cloud error: {detail}")
    return {"status": "saved", "backup": response.get("backup")}


@api_user.post("/cloud/backups/frames", response_model=CloudStatusResponse)
async def backup_frame_to_cloud(
    data: CloudBackupSaveFrameRequest,
    db: Session = Depends(get_db),
    current_user: User | None = Depends(get_current_user),
):
    user = _require_user(current_user)
    link, access_token = _require_linked(db, "backup:frames")
    frame = db.query(Frame).filter_by(id=data.frame_id).first()
    if frame is None or get_user_project(db, user, frame.project_id) is None:
        raise HTTPException(status_code=HTTPStatus.NOT_FOUND, detail="Frame not found")

    project = db.get(Project, frame.project_id)
    try:
        status_code, response = await cloud_backup.push_frame_backup(
            link, access_token, frame.to_dict(), project.name if project else None
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            status_code=HTTPStatus.BAD_GATEWAY, detail=f"Could not reach {link.provider_url}: {exc}"
        ) from exc
    if status_code != 200:
        detail = response.get("error") or f"unexpected status {status_code}"
        raise HTTPException(status_code=HTTPStatus.BAD_GATEWAY, detail=f"FrameOS Cloud error: {detail}")
    return {"status": "saved", "backup": response.get("backup")}


@api_user.post("/cloud/backups/restore", response_model=CloudStatusResponse)
async def restore_cloud_backup(
    data: CloudBackupRestoreRequest,
    db: Session = Depends(get_db),
    redis: Redis = Depends(get_redis),
    current_user: User | None = Depends(get_current_user),
):
    user = _require_user(current_user)
    project = _user_project_or_404(db, user, data.project_id)

    link = current_cloud_backend_link(db)
    access_token = cloud_backup.link_access_token(link)
    if link is None or access_token is None:
        raise HTTPException(status_code=HTTPStatus.CONFLICT, detail="This install is not linked to FrameOS Cloud")

    try:
        status_code, response = await cloud_link.backup_get(link.provider_url, access_token, data.backup_id)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            status_code=HTTPStatus.BAD_GATEWAY, detail=f"Could not reach {link.provider_url}: {exc}"
        ) from exc
    if status_code != 200:
        detail = response.get("error") or f"unexpected status {status_code}"
        raise HTTPException(status_code=HTTPStatus.BAD_GATEWAY, detail=f"FrameOS Cloud error: {detail}")

    backup = response.get("backup") or {}
    try:
        content = base64.b64decode(backup.get("content_base64") or "")
    except (TypeError, ValueError):
        content = b""
    if not content:
        raise HTTPException(status_code=HTTPStatus.BAD_GATEWAY, detail="The backup had no content")

    if backup.get("kind") == "templates":
        try:
            fields = parse_template_zip(content)
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(
                status_code=HTTPStatus.UNPROCESSABLE_ENTITY, detail=f"Could not parse the template backup: {exc}"
            ) from exc
        image = fields.get("image")
        template = Template(
            project_id=project.id,
            name=fields.get("name") or backup.get("name") or "Restored template",
            description=fields.get("description"),
            scenes=fields.get("scenes") or [],
            config=fields.get("config"),
            image=image if isinstance(image, bytes) else None,
            image_width=fields.get("imageWidth") or fields.get("image_width"),
            image_height=fields.get("imageHeight") or fields.get("image_height"),
        )
        db.add(template)
        db.commit()
        db.refresh(template)
        return {"status": "restored", "kind": "template", "id": template.id}

    if backup.get("kind") == "frames":
        try:
            payload = json.loads(content)
        except (TypeError, ValueError) as exc:
            raise HTTPException(
                status_code=HTTPStatus.UNPROCESSABLE_ENTITY, detail="Could not parse the frame backup"
            ) from exc
        frame_dict = payload.get("frame") if isinstance(payload, dict) else None
        if not isinstance(frame_dict, dict):
            raise HTTPException(status_code=HTTPStatus.UNPROCESSABLE_ENTITY, detail="Could not parse the frame backup")

        from app.models.frame import secure_token

        frame = Frame(
            project_id=project.id,
            status="uninitialized",
            frame_access_key=secure_token(20),
            server_api_key=secure_token(32),
        )
        for field in FRAME_RESTORE_FIELDS:
            if field in frame_dict:
                setattr(frame, field, frame_dict[field])
        agent = dict(frame.agent or {}) if isinstance(frame.agent, dict) else {}
        agent["agentSharedSecret"] = secure_token(32)
        frame.agent = agent
        if not frame.name:
            frame.name = backup.get("name") or "Restored frame"
        if not frame.frame_host:
            frame.frame_host = "frame.local"
        db.add(frame)
        db.commit()
        db.refresh(frame)
        await publish_message(redis, "new_frame", frame.to_dict())
        return {"status": "restored", "kind": "frame", "id": frame.id}

    raise HTTPException(status_code=HTTPStatus.UNPROCESSABLE_ENTITY, detail="Unknown backup kind")


@api_user.get("/backup/export")
async def export_backup_tarball(
    db: Session = Depends(get_db), current_user: User | None = Depends(get_current_user)
):
    """Everything as a plain tar.gz — the self-service alternative to cloud
    backups. Stays local, so unlike cloud frame backups it keeps credentials."""
    user = _require_user(current_user)
    projects = _user_projects(db, user)

    now = datetime.datetime.utcnow()
    buffer = io.BytesIO()

    def add_file(tar: tarfile.TarFile, path: str, content: bytes) -> None:
        info = tarfile.TarInfo(name=path)
        info.size = len(content)
        info.mtime = int(now.timestamp())
        tar.addfile(info, io.BytesIO(content))

    manifest: dict = {"format": "frameos-backup-v1", "exported_at": now.isoformat(), "projects": []}
    with tarfile.open(fileobj=buffer, mode="w:gz") as tar:
        for project in projects:
            frames = db.query(Frame).filter(Frame.project_id == project.id).all()
            templates = db.query(Template).filter(Template.project_id == project.id).all()
            manifest["projects"].append(
                {
                    "id": project.id,
                    "name": project.name,
                    "frames": len(frames),
                    "templates": len(templates),
                }
            )
            add_file(
                tar,
                f"projects/{project.id}/project.json",
                json.dumps({"id": project.id, "name": project.name}, indent=2).encode(),
            )
            for frame in frames:
                add_file(
                    tar,
                    f"projects/{project.id}/frames/frame-{frame.id}.json",
                    json.dumps(frame.to_dict(), indent=2, default=str).encode(),
                )
            for template in templates:
                add_file(
                    tar,
                    f"projects/{project.id}/templates/{template.id} - {safe_template_name(template)}.zip",
                    template_zip_bytes(template),
                )
        add_file(tar, "manifest.json", json.dumps(manifest, indent=2).encode())

    filename = f"frameos-backup-{now.strftime('%Y%m%d-%H%M%S')}.tar.gz"
    return Response(
        buffer.getvalue(),
        media_type="application/gzip",
        headers={"Content-Disposition": f"attachment; filename={filename}"},
    )
