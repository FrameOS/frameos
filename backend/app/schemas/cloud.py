from __future__ import annotations

from typing import Any, Optional

from pydantic import BaseModel, Field


class CloudStatusResponse(BaseModel):
    linked: bool
    cloud_auth_required: bool = False
    cloud_user_id: Optional[str] = None
    cloud_backend_name: Optional[str] = None
    cloud_backend_url: Optional[str] = None
    cloud_error: Optional[str] = None
    cloud_url: str


class CloudBackupManifestRequest(BaseModel):
    backupId: Optional[str] = None
    encryptedManifest: dict[str, Any]


class CloudBackupObjectRequest(BaseModel):
    digest: Optional[str] = None
    encryptedObject: dict[str, Any]


class CloudImportPrepareRequest(BaseModel):
    manifest: dict[str, Any] = Field(default_factory=dict)


class CloudImportCommitRequest(BaseModel):
    sessionId: str
    replaceExisting: bool = False


class CloudImportObjectResponse(BaseModel):
    ok: bool
    sessionId: str
    objectId: str
    bytes: int
