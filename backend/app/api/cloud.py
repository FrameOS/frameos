from __future__ import annotations

import json
import mimetypes
import os
import shlex
from datetime import datetime, timedelta
from http import HTTPStatus
from pathlib import Path
from typing import Any

import asyncssh
import httpx
from arq import ArqRedis as Redis
from fastapi import Depends, HTTPException, Query, Request, Response
from fastapi.responses import RedirectResponse
from sqlalchemy.orm import Session
from werkzeug.security import generate_password_hash

from app.api.auth import (
    ACCESS_TOKEN_EXPIRE_MINUTES,
    _should_use_secure_cookie,
    create_access_token,
    get_current_user,
)
from app.config import config
from app.database import get_db
from app.models.assets import Assets
from app.models.cloud import (
    CloudAuthSession,
    CloudExportObject,
    CloudImportObject,
    CloudImportSession,
    expires_in,
    random_prefixed_id,
    utcnow,
)
from app.models.frame import Frame
from app.models.settings import Settings, get_settings_dict
from app.models.user import User
from app.redis import get_redis
from app.schemas.cloud import (
    CloudImportCommitRequest,
    CloudImportObjectResponse,
    CloudImportPrepareRequest,
    CloudStatusResponse,
)
from app.schemas.auth import UserSignup
from app.utils.cloud import cloud_base_url, protect_secret, sanitize_return_to, state_hash, unprotect_secret
from app.utils.cloud_auth import create_cloud_auth_session
from app.utils.remote_exec import _use_agent, run_command, upload_file
from app.utils.session_cookie import SESSION_COOKIE_NAME, create_session_cookie_value
from app.utils.ssh_utils import get_ssh_connection, remove_ssh_connection
from app.utils.versions import get_versions
from app.ws.agent_ws import assets_list_on_frame, file_read_on_frame

from . import api_no_auth, api_with_auth


FRAMEOS_ROOT = Path(__file__).resolve().parents[3]
LOCAL_COPIED_FONTS = FRAMEOS_ROOT / "frameos" / "assets" / "copied" / "fonts"
FORBIDDEN_PLAINTEXT_KEYS = {"asset", "assets", "frame", "frames", "manifest", "metadata", "payload", "plaintext", "state"}


def _bad_request(message: str, status_code: int = HTTPStatus.BAD_REQUEST) -> None:
    raise HTTPException(status_code=status_code, detail=message)


def _content_type(path: str) -> str:
    return mimetypes.guess_type(path)[0] or "application/octet-stream"


def _export_object(
    db: Session,
    *,
    kind: str,
    locator: dict[str, Any],
    content_type: str,
    size: int | None = None,
    ttl_hours: int = 6,
) -> CloudExportObject:
    item = CloudExportObject(
        id=random_prefixed_id("obj"),
        kind=kind,
        locator=locator,
        content_type=content_type,
        size=size,
        expires_at=utcnow() + timedelta(hours=ttl_hours),
    )
    db.add(item)
    return item


def _reject_plaintext_backup_keys(body: dict[str, Any]) -> None:
    for key in body.keys():
        if key.lower() in FORBIDDEN_PLAINTEXT_KEYS:
            _bad_request(f"Send {key} inside an encrypted envelope, not as plaintext.")


def _assert_encrypted_envelope(envelope: dict[str, Any] | None, label: str) -> None:
    if not isinstance(envelope, dict) or isinstance(envelope, list):
        _bad_request(f"{label} must be an object.")
    algorithm = str(envelope.get("algorithm") or "")
    if "AES" not in algorithm.upper() or "GCM" not in algorithm.upper():
        _bad_request(f"{label} must use AES-GCM.")
    if not isinstance(envelope.get("iv"), str) or len(envelope["iv"]) < 12:
        _bad_request(f"{label} must include an iv.")
    if not isinstance(envelope.get("ciphertext"), str) or len(envelope["ciphertext"]) < 16:
        _bad_request(f"{label} must include ciphertext.")


def _cloud_user(db: Session) -> User | None:
    return db.query(User).filter(User.cloud_backend_token.isnot(None)).first()


def _cloud_status_user(db: Session) -> User | None:
    return _cloud_user(db) or db.query(User).filter(User.cloud_auth_required.is_(True)).first()


def _require_cloud_token(db: Session) -> str:
    user = _cloud_user(db)
    token = unprotect_secret(user.cloud_backend_token if user else None)
    if not token:
        _bad_request("FrameOS Cloud is not linked.", HTTPStatus.CONFLICT)
    return token


def _cloud_response(response: httpx.Response) -> Response:
    content_type = response.headers.get("content-type", "application/json")
    return Response(
        content=response.content,
        status_code=response.status_code,
        media_type=content_type.split(";", 1)[0],
    )


async def _request_cloud(
    request: Request,
    db: Session,
    method: str,
    path: str,
    *,
    json_body: dict[str, Any] | None = None,
) -> Response:
    token = _require_cloud_token(db)
    url = f"{cloud_base_url()}{path}"
    headers = {"Authorization": f"Bearer {token}"}
    client: httpx.AsyncClient | None = getattr(request.app.state, "http_client", None)
    if client is not None:
        response = await client.request(method, url, json=json_body, headers=headers, timeout=60)
    else:
        async with httpx.AsyncClient() as fallback_client:
            response = await fallback_client.request(method, url, json=json_body, headers=headers, timeout=60)
    return _cloud_response(response)


async def _request_cloud_backend_session(request: Request, token: str) -> httpx.Response:
    url = f"{cloud_base_url()}/api/cloud/backend/session"
    headers = {"Authorization": f"Bearer {token}"}
    client: httpx.AsyncClient | None = getattr(request.app.state, "http_client", None)
    if client is not None:
        return await client.get(url, headers=headers, timeout=15)
    async with httpx.AsyncClient() as fallback_client:
        return await fallback_client.get(url, headers=headers, timeout=15)


async def _validate_cloud_link_for_status(request: Request, db: Session, user: User | None) -> str | None:
    token = unprotect_secret(user.cloud_backend_token if user else None)
    if not user or not token:
        return None

    try:
        response = await _request_cloud_backend_session(request, token)
    except httpx.HTTPError as exc:
        return f"Could not verify FrameOS Cloud status: {exc}"

    try:
        body = response.json()
    except json.JSONDecodeError:
        body = {}

    if response.status_code < 400:
        backend = body.get("backend") if isinstance(body.get("backend"), dict) else {}
        if backend:
            user.cloud_backend_link_id = str(backend.get("id") or user.cloud_backend_link_id or "")
            user.cloud_backend_name = str(backend.get("backendName") or user.cloud_backend_name or "")
            user.cloud_backend_url = str(backend.get("backendUrl") or user.cloud_backend_url or "")
            db.commit()
        return None

    if response.status_code in {HTTPStatus.UNAUTHORIZED, HTTPStatus.FORBIDDEN, HTTPStatus.NOT_FOUND}:
        user.cloud_backend_token = None
        user.cloud_backend_link_id = None
        user.cloud_auth_required = True
        db.commit()
        return "FrameOS Cloud no longer recognizes this backend. Re-authenticate to link it again."

    message = (body.get("error") or body.get("detail")) if isinstance(body, dict) else None
    return str(message or f"FrameOS Cloud status check failed with HTTP {response.status_code}.")


async def _exchange_cloud_code(request: Request, session: CloudAuthSession, code: str) -> dict[str, Any]:
    payload = {
        "code": code,
        "backendName": session.backend_name,
        "backendUrl": session.backend_url,
    }
    url = f"{cloud_base_url()}/api/cloud/backend/auth/exchange"
    client: httpx.AsyncClient | None = getattr(request.app.state, "http_client", None)
    if client is not None:
        response = await client.post(url, json=payload, timeout=30)
    else:
        async with httpx.AsyncClient() as fallback_client:
            response = await fallback_client.post(url, json=payload, timeout=30)

    try:
        body = response.json()
    except json.JSONDecodeError:
        body = {}
    if response.status_code >= 400:
        _bad_request(body.get("error") or body.get("detail") or "FrameOS Cloud rejected the auth code.", response.status_code)
    return body


def _store_cloud_link(user: User, exchange: dict[str, Any], session: CloudAuthSession) -> None:
    backend_token = str(exchange.get("backendToken") or "")
    cloud_user = exchange.get("user") if isinstance(exchange.get("user"), dict) else {}
    backend = exchange.get("backend") if isinstance(exchange.get("backend"), dict) else {}
    if not backend_token:
        _bad_request("FrameOS Cloud response did not include a backend token.")

    user.cloud_auth_required = True
    user.cloud_user_id = str(cloud_user.get("id") or user.cloud_user_id or "")
    user.cloud_backend_token = protect_secret(backend_token)
    user.cloud_backend_link_id = str(backend.get("id") or user.cloud_backend_link_id or "")
    user.cloud_backend_name = str(backend.get("backendName") or session.backend_name)
    user.cloud_backend_url = str(backend.get("backendUrl") or session.backend_url)


def _login_response(request: Request, response: Response, user: User) -> dict[str, str]:
    expires = timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    token = create_access_token(data={"sub": user.email}, expires_delta=expires)
    session_value, max_age = create_session_cookie_value(email=user.email, expires_delta=expires)
    response.set_cookie(
        key=SESSION_COOKIE_NAME,
        value=session_value,
        max_age=max_age,
        httponly=True,
        samesite="lax",
        secure=_should_use_secure_cookie(request),
    )
    return {"access_token": token, "token_type": "bearer"}


@api_no_auth.get("/cloud/signup/start")
async def api_cloud_signup_start():
    _bad_request("Use the signup form to set local credentials before cloud authentication.")


@api_no_auth.post("/cloud/signup/start")
async def api_cloud_signup_start_with_local_credentials(
    request: Request,
    data: UserSignup,
    db: Session = Depends(get_db),
):
    if config.HASSIO_RUN_MODE is not None:
        _bad_request("Cloud signup is not allowed with HASSIO_RUN_MODE.", HTTPStatus.UNAUTHORIZED)
    if db.query(User).first() is not None:
        _bad_request("Only the first local user can be linked during cloud signup.")
    if not data.password:
        _bad_request("Password is required.")
    if data.password != data.password2:
        _bad_request("Passwords do not match.")
    if len(data.password) < 8:
        _bad_request("Password too short.")

    _, cloud_auth_url = create_cloud_auth_session(
        db=db,
        request=request,
        purpose="signup",
        return_to=sanitize_return_to(request, request.headers.get("x-frameos-return-to")),
        pending_email=data.email,
        pending_password_hash=generate_password_hash(data.password),
    )
    return {"cloud_auth_url": cloud_auth_url}


@api_no_auth.get("/cloud/callback")
async def api_cloud_callback(
    request: Request,
    code: str = Query(""),
    state: str = Query(""),
    error: str = Query(""),
    db: Session = Depends(get_db),
):
    if not state:
        _bad_request("Missing FrameOS Cloud auth state.")

    session = db.query(CloudAuthSession).filter_by(state_hash=state_hash(state)).first()
    if session is None or not session.is_active():
        _bad_request("Invalid or expired FrameOS Cloud auth state.", HTTPStatus.UNAUTHORIZED)

    if error:
        session.consumed_at = utcnow()
        db.commit()
        return RedirectResponse(session.return_to or "/")

    if not code:
        _bad_request("Missing FrameOS Cloud auth code.")

    exchange = await _exchange_cloud_code(request, session, code)
    cloud_user = exchange.get("user") if isinstance(exchange.get("user"), dict) else {}
    email = str(cloud_user.get("email") or "").strip()
    if not email:
        _bad_request("FrameOS Cloud response did not include a user email.")

    if session.purpose == "signup":
        if db.query(User).first() is not None:
            _bad_request("Only the first local user can be linked during cloud signup.")
        if session.pending_email and session.pending_email.lower() != email.lower():
            _bad_request("FrameOS Cloud email did not match the signup email.", HTTPStatus.UNAUTHORIZED)
        user = User(email=email)
        if session.pending_password_hash:
            user.password = session.pending_password_hash
        else:
            user.set_password(random_prefixed_id("cloud_password", 32))
        db.add(user)
        db.flush()
    elif session.purpose == "login":
        user = db.get(User, session.user_id) if session.user_id else None
        first_user = db.query(User).order_by(User.id.asc()).first()
        if user is None or first_user is None or first_user.id != user.id:
            _bad_request("FrameOS Cloud login session is no longer valid.", HTTPStatus.UNAUTHORIZED)
        cloud_user_id = str(cloud_user.get("id") or "")
        if user.cloud_user_id and cloud_user_id and user.cloud_user_id != cloud_user_id:
            _bad_request("FrameOS Cloud account did not match this backend user.", HTTPStatus.UNAUTHORIZED)
    else:
        _bad_request("Unsupported FrameOS Cloud auth session.", HTTPStatus.UNAUTHORIZED)

    _store_cloud_link(user, exchange, session)
    session.consumed_at = utcnow()
    db.commit()

    redirect = RedirectResponse(session.return_to or "/")
    _login_response(request, redirect, user)
    return redirect


@api_with_auth.get("/cloud/status", response_model=CloudStatusResponse)
async def api_cloud_status(request: Request, db: Session = Depends(get_db)):
    user = _cloud_status_user(db)
    cloud_error = await _validate_cloud_link_for_status(request, db, user)
    linked = bool(user and user.cloud_backend_token and not cloud_error)
    return {
        "linked": linked,
        "cloud_auth_required": bool(user and user.cloud_auth_required),
        "cloud_user_id": user.cloud_user_id if user else None,
        "cloud_backend_name": user.cloud_backend_name if user else None,
        "cloud_backend_url": user.cloud_backend_url if user else None,
        "cloud_error": cloud_error,
        "cloud_url": cloud_base_url(),
    }


@api_with_auth.post("/cloud/reauth/start")
async def api_cloud_reauth_start(
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    first_user = db.query(User).order_by(User.id.asc()).first()
    if first_user is None or first_user.id != current_user.id:
        _bad_request("Only the first local user can be linked to FrameOS Cloud.", HTTPStatus.FORBIDDEN)

    linked_user = _cloud_user(db)
    if linked_user is not None and linked_user.id != current_user.id:
        _bad_request("Another local user is already linked to FrameOS Cloud.", HTTPStatus.CONFLICT)

    _, cloud_auth_url = create_cloud_auth_session(
        db=db,
        request=request,
        purpose="login",
        user_id=current_user.id,
        return_to=sanitize_return_to(request, request.headers.get("x-frameos-return-to")),
    )
    return {"cloud_auth_url": cloud_auth_url}


@api_with_auth.get("/cloud/backups")
async def api_cloud_backups_list(request: Request, db: Session = Depends(get_db)):
    return await _request_cloud(request, db, "GET", "/api/cloud/backups")


@api_with_auth.post("/cloud/backups")
async def api_cloud_backups_upsert(
    request: Request,
    db: Session = Depends(get_db),
):
    payload = await request.json()
    if not isinstance(payload, dict):
        _bad_request("Backup payload must be a JSON object.")
    _reject_plaintext_backup_keys(payload)
    _assert_encrypted_envelope(payload.get("encryptedManifest"), "encryptedManifest")
    return await _request_cloud(request, db, "POST", "/api/cloud/backups", json_body=payload)


@api_with_auth.get("/cloud/backups/{backup_id}")
async def api_cloud_backups_get(backup_id: str, request: Request, db: Session = Depends(get_db)):
    return await _request_cloud(request, db, "GET", f"/api/cloud/backups/{backup_id}")


@api_with_auth.delete("/cloud/backups/{backup_id}")
async def api_cloud_backups_delete(backup_id: str, request: Request, db: Session = Depends(get_db)):
    return await _request_cloud(request, db, "DELETE", f"/api/cloud/backups/{backup_id}")


@api_with_auth.put("/cloud/backups/{backup_id}/objects/{object_id}")
async def api_cloud_backup_object_put(
    backup_id: str,
    object_id: str,
    request: Request,
    db: Session = Depends(get_db),
):
    payload = await request.json()
    if not isinstance(payload, dict):
        _bad_request("Backup object payload must be a JSON object.")
    _reject_plaintext_backup_keys(payload)
    _assert_encrypted_envelope(payload.get("encryptedObject"), "encryptedObject")
    return await _request_cloud(
        request,
        db,
        "PUT",
        f"/api/cloud/backups/{backup_id}/objects/{object_id}",
        json_body=payload,
    )


@api_with_auth.get("/cloud/backups/{backup_id}/objects/{object_id}")
async def api_cloud_backup_object_get(backup_id: str, object_id: str, request: Request, db: Session = Depends(get_db)):
    return await _request_cloud(request, db, "GET", f"/api/cloud/backups/{backup_id}/objects/{object_id}")


@api_with_auth.delete("/cloud/backups/{backup_id}/objects/{object_id}")
async def api_cloud_backup_object_delete(
    backup_id: str,
    object_id: str,
    request: Request,
    db: Session = Depends(get_db),
):
    return await _request_cloud(request, db, "DELETE", f"/api/cloud/backups/{backup_id}/objects/{object_id}")


async def _list_frame_files(db: Session, redis: Redis, frame: Frame, root: str) -> list[dict[str, Any]]:
    if await _use_agent(frame, redis):
        items = await assets_list_on_frame(frame.id, root, redis=redis)
        return [
            {
                "path": item["path"],
                "size": int(item.get("size", 0)),
                "mtime": item.get("mtime"),
            }
            for item in items
            if not item.get("is_dir")
        ]

    command = (
        f"if [ -d {shlex.quote(root)} ]; then "
        f"find {shlex.quote(root)} -type f -exec stat --printf='%s|%Y|%n\\n' {{}} +; "
        "fi"
    )
    status, stdout, stderr = await run_command(db, redis, frame, command, log_output=False, log_command=False, timeout=30)
    if status != 0:
        raise RuntimeError(stderr or f"Could not list {root}")

    files: list[dict[str, Any]] = []
    for line in stdout.splitlines():
        parts = line.split("|", 2)
        if len(parts) != 3:
            continue
        size, mtime, path = parts
        files.append({"path": path, "size": int(size), "mtime": int(mtime)})
    return files


async def _download_frame_file(db: Session, redis: Redis, frame: Frame, remote_path: str) -> bytes:
    if await _use_agent(frame, redis):
        return await file_read_on_frame(frame.id, remote_path, redis=redis)

    ssh = await get_ssh_connection(db, redis, frame)
    tmp_name = None
    try:
        import tempfile

        with tempfile.NamedTemporaryFile(delete=False) as tmp:
            tmp_name = tmp.name
        await asyncssh.scp((ssh, shlex.quote(remote_path)), tmp_name, recurse=False)
        with open(tmp_name, "rb") as fh:
            return fh.read()
    finally:
        if tmp_name and os.path.exists(tmp_name):
            os.remove(tmp_name)
        await remove_ssh_connection(db, redis, ssh, frame)


@api_with_auth.get("/cloud/export/manifest")
async def api_cloud_export_manifest(
    include_frame_files: bool = Query(True, alias="includeFrameFiles"),
    db: Session = Depends(get_db),
    redis: Redis = Depends(get_redis),
):
    db.query(CloudExportObject).filter(CloudExportObject.expires_at <= utcnow()).delete()

    objects: list[dict[str, Any]] = []
    warnings: list[str] = []

    for asset in db.query(Assets).order_by(Assets.path.asc()).all():
        item = _export_object(
            db,
            kind="backend_asset",
            locator={"type": "backend_asset", "asset_id": asset.id},
            content_type=_content_type(asset.path),
            size=len(asset.data or b""),
        )
        objects.append(item.to_manifest_dict({"path": asset.path}))

    if LOCAL_COPIED_FONTS.exists():
        for path in sorted(LOCAL_COPIED_FONTS.rglob("*")):
            if path.is_file():
                item = _export_object(
                    db,
                    kind="copied_font",
                    locator={"type": "local_file", "path": str(path)},
                    content_type=_content_type(str(path)),
                    size=path.stat().st_size,
                )
                objects.append(item.to_manifest_dict({"path": str(path.relative_to(LOCAL_COPIED_FONTS.parent))}))

    frames = db.query(Frame).order_by(Frame.id.asc()).all()
    if include_frame_files:
        async def collect_frame(frame: Frame) -> None:
            roots = [
                ("frame_state", "/srv/frameos/state"),
                ("frame_asset", frame.assets_path or "/srv/assets"),
            ]
            for kind, root in roots:
                try:
                    for remote_file in await _list_frame_files(db, redis, frame, root):
                        item = _export_object(
                            db,
                            kind=kind,
                            locator={"type": "frame_file", "frame_id": frame.id, "path": remote_file["path"]},
                            content_type=_content_type(remote_file["path"]),
                            size=remote_file.get("size"),
                        )
                        objects.append(
                            item.to_manifest_dict(
                                {
                                    "frameId": frame.id,
                                    "path": remote_file["path"],
                                    "mtime": remote_file.get("mtime"),
                                }
                            )
                        )
                except Exception as exc:  # noqa: BLE001
                    warnings.append(f"Frame {frame.id} {root}: {exc}")

        for frame in frames:
            await collect_frame(frame)

    db.commit()

    manifest = {
        "schemaVersion": "frameos.backend.export.v1",
        "exportedAt": utcnow().isoformat(),
        "backend": {
            "versions": get_versions(),
            "cloudUrl": cloud_base_url(),
        },
        "database": {
            "frames": [frame.to_dict() for frame in frames],
            "settings": [setting.to_dict() for setting in db.query(Settings).order_by(Settings.key.asc()).all()],
            "assets": [
                {
                    "id": asset.id,
                    "path": asset.path,
                    "size": len(asset.data or b""),
                    "objectId": next((obj["id"] for obj in objects if obj.get("kind") == "backend_asset" and obj.get("path") == asset.path), None),
                }
                for asset in db.query(Assets).order_by(Assets.path.asc()).all()
            ],
        },
        "settings": get_settings_dict(db),
        "objects": objects,
        "warnings": warnings,
    }
    return manifest


@api_with_auth.get("/cloud/export/objects/{object_id}")
async def api_cloud_export_object(
    object_id: str,
    db: Session = Depends(get_db),
    redis: Redis = Depends(get_redis),
):
    item = db.get(CloudExportObject, object_id)
    if item is None or item.expires_at <= utcnow():
        raise HTTPException(status_code=HTTPStatus.NOT_FOUND, detail="Export object not found")

    locator = item.locator or {}
    if locator.get("type") == "backend_asset":
        asset = db.get(Assets, locator.get("asset_id"))
        if asset is None:
            raise HTTPException(status_code=HTTPStatus.NOT_FOUND, detail="Asset not found")
        data = asset.data or b""
    elif locator.get("type") == "local_file":
        path = Path(str(locator.get("path") or ""))
        if not path.is_file():
            raise HTTPException(status_code=HTTPStatus.NOT_FOUND, detail="Local file not found")
        data = path.read_bytes()
    elif locator.get("type") == "frame_file":
        frame = db.get(Frame, int(locator.get("frame_id")))
        if frame is None:
            raise HTTPException(status_code=HTTPStatus.NOT_FOUND, detail="Frame not found")
        data = await _download_frame_file(db, redis, frame, str(locator.get("path")))
    else:
        _bad_request("Unsupported export object type.")

    return Response(content=data, media_type=item.content_type or "application/octet-stream")


def _validate_import_manifest(manifest: dict[str, Any]) -> None:
    if manifest.get("schemaVersion") != "frameos.backend.export.v1":
        _bad_request("Unsupported backup manifest schemaVersion.")
    if not isinstance(manifest.get("database"), dict):
        _bad_request("Backup manifest must include database metadata.")


@api_with_auth.post("/cloud/import/prepare")
async def api_cloud_import_prepare(body: CloudImportPrepareRequest, db: Session = Depends(get_db)):
    manifest = body.manifest
    _validate_import_manifest(manifest)
    session = CloudImportSession(
        id=random_prefixed_id("imp"),
        manifest=manifest,
        status="prepared",
        expires_at=expires_in(60),
    )
    db.add(session)
    db.commit()

    objects = manifest.get("objects") if isinstance(manifest.get("objects"), list) else []
    db_meta = manifest.get("database") or {}
    return {
        "sessionId": session.id,
        "restorePlan": {
            "frames": len(db_meta.get("frames") or []),
            "settings": len(db_meta.get("settings") or []),
            "assets": len(db_meta.get("assets") or []),
            "objects": len(objects),
        },
        "requiredObjects": [obj.get("id") for obj in objects if isinstance(obj, dict) and obj.get("id")],
    }


def _import_session(db: Session, session_id: str) -> CloudImportSession:
    session = db.get(CloudImportSession, session_id)
    if session is None or session.expires_at <= utcnow():
        raise HTTPException(status_code=HTTPStatus.NOT_FOUND, detail="Import session not found")
    if session.status not in {"prepared", "objects_uploaded"}:
        _bad_request("Import session is not accepting objects.")
    return session


@api_with_auth.post("/cloud/import/objects/{object_id}", response_model=CloudImportObjectResponse)
async def api_cloud_import_object(
    object_id: str,
    request: Request,
    session_id: str = Query(..., alias="sessionId"),
    db: Session = Depends(get_db),
):
    session = _import_session(db, session_id)
    data = await request.body()
    existing = (
        db.query(CloudImportObject)
        .filter_by(session_id=session.id, object_id=object_id)
        .first()
    )
    if existing:
        existing.data = data
        existing.content_type = request.headers.get("content-type")
    else:
        db.add(
            CloudImportObject(
                session_id=session.id,
                object_id=object_id,
                content_type=request.headers.get("content-type"),
                data=data,
            )
        )
    session.status = "objects_uploaded"
    db.commit()
    return {"ok": True, "sessionId": session.id, "objectId": object_id, "bytes": len(data)}


def _parse_import_datetime(value: Any) -> Any:
    if not isinstance(value, str):
        return value
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).replace(tzinfo=None)
    except ValueError:
        return value


async def _commit_import(
    db: Session,
    redis: Redis,
    session: CloudImportSession,
    *,
    replace_existing: bool,
) -> dict[str, Any]:
    manifest = session.manifest or {}
    db_meta = manifest.get("database") or {}
    objects_by_id = {
        row.object_id: row
        for row in db.query(CloudImportObject).filter_by(session_id=session.id).all()
    }

    if replace_existing:
        db.query(Settings).delete()
        db.query(Assets).delete()
        db.query(Frame).delete()
        db.flush()

    restored = {"frames": 0, "settings": 0, "assets": 0, "frameFiles": 0, "warnings": []}

    for setting_data in db_meta.get("settings") or []:
        if not isinstance(setting_data, dict) or not setting_data.get("key"):
            continue
        setting = db.query(Settings).filter_by(key=setting_data["key"]).first()
        if setting is None:
            setting = Settings(key=setting_data["key"])
            db.add(setting)
        setting.value = setting_data.get("value")
        restored["settings"] += 1

    frame_columns = {column.name for column in Frame.__table__.columns}
    datetime_columns = {"last_log_at", "last_successful_deploy_at"}
    for frame_data in db_meta.get("frames") or []:
        if not isinstance(frame_data, dict):
            continue
        frame_id = frame_data.get("id")
        frame = db.get(Frame, int(frame_id)) if frame_id is not None else None
        if frame is None:
            frame = Frame()
            db.add(frame)
        for key, value in frame_data.items():
            if key in frame_columns:
                setattr(frame, key, _parse_import_datetime(value) if key in datetime_columns else value)
        restored["frames"] += 1
    db.flush()

    for asset_data in db_meta.get("assets") or []:
        if not isinstance(asset_data, dict) or not asset_data.get("path"):
            continue
        object_id = asset_data.get("objectId")
        imported = objects_by_id.get(object_id)
        if imported is None:
            restored["warnings"].append(f"Missing object for backend asset {asset_data['path']}")
            continue
        asset = db.query(Assets).filter_by(path=asset_data["path"]).first()
        if asset is None:
            asset = Assets(path=asset_data["path"])
            db.add(asset)
        asset.data = imported.data
        restored["assets"] += 1

    object_manifest = manifest.get("objects") if isinstance(manifest.get("objects"), list) else []
    for object_info in object_manifest:
        if not isinstance(object_info, dict) or object_info.get("kind") not in {"frame_state", "frame_asset"}:
            continue
        imported = objects_by_id.get(object_info.get("id"))
        if imported is None:
            restored["warnings"].append(f"Missing object for frame file {object_info.get('id')}")
            continue
        frame_id = object_info.get("frameId")
        path = object_info.get("path")
        frame = db.get(Frame, int(frame_id)) if frame_id is not None else None
        if frame is None or not path:
            restored["warnings"].append(f"Could not restore frame file {object_info.get('id')}: missing frame or path")
            continue
        try:
            await upload_file(db, redis, frame, path, imported.data)
            restored["frameFiles"] += 1
        except Exception as exc:  # noqa: BLE001
            restored["warnings"].append(f"Could not restore {path} on frame {frame_id}: {exc}")

    session.status = "committed"
    session.committed_at = utcnow()
    db.commit()
    return restored


@api_with_auth.post("/cloud/import/commit")
async def api_cloud_import_commit(
    body: CloudImportCommitRequest,
    db: Session = Depends(get_db),
    redis: Redis = Depends(get_redis),
):
    session = _import_session(db, body.sessionId)
    _validate_import_manifest(session.manifest)
    try:
        restored = await _commit_import(db, redis, session, replace_existing=body.replaceExisting)
    except Exception as exc:  # noqa: BLE001
        session.status = "failed"
        session.error = str(exc)
        db.commit()
        raise
    return {"ok": True, "sessionId": session.id, "restored": restored}
