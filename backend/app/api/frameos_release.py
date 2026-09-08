"""Which FrameOS release this backend runs — asked by the Pi/Buildroot runtime.

``GET /api/frameos/release`` (bearer = the frame's server API key, the same
credential the log uploader sends) answers ``{"version": "2026.9.12"}``:
versions.json's release without the +sha, i.e. the version this backend's
own deploys install. A backend-managed frame's auto-updater
(frameos/src/frameos/auto_updater.nim → upgrade.nim resolveFrameOSRelease)
installs exactly that release instead of GitHub's latest, so a frame never
climbs past its backend — the next deploy would only downgrade it again.
The ESP32 gets the same pin through the OTA manifest (firmware_release.py).
A backend whose version has no published release (a dev checkout) still
answers; the frame then finds no such tag on GitHub and stays put.
"""

from __future__ import annotations

from fastapi import Depends, Header, HTTPException
from sqlalchemy.orm import Session

from app.api.firmware_release import backend_release_version
from app.database import get_db
from app.models.frame import Frame

from . import api_public


def _frame_from_bearer(db: Session, authorization: str | None) -> Frame:
    if not authorization:
        raise HTTPException(status_code=401, detail="Unauthorized")
    parts = authorization.split(" ")
    if len(parts) != 2 or parts[0].lower() != "bearer" or not parts[1]:
        raise HTTPException(status_code=401, detail="Invalid Authorization header")
    frame = db.query(Frame).filter_by(server_api_key=parts[1]).first()
    if not frame:
        raise HTTPException(status_code=401, detail="Unauthorized")
    return frame


@api_public.get("/frameos/release")
async def api_frameos_release(
    db: Session = Depends(get_db),
    authorization: str = Header(None),
):
    _frame_from_bearer(db, authorization)
    version = backend_release_version()
    if not version:
        raise HTTPException(status_code=503, detail="release_version_unknown")
    return {"version": version}
