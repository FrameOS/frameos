"""FrameOS Cloud sync service.

Runs as a single asyncio task inside the arq worker (same singleton slot as
the Home Assistant sync). Responsibilities:

- Grants sync: periodically re-reads /api/backends/grants so a cloud-side
  revocation takes effect quickly. A 401 means the link was revoked: the local
  link resets and local password login is re-enabled so nobody is locked out.
- Inventory heartbeat: keeps version/health fresh on the provider.
- Automatic frame backups (scope ``backup:frames``): watches the
  ``update_frame`` broadcast for a changed ``last_successful_deploy_at`` —
  i.e. a finished deploy — and pushes a sanitized frame backup.
"""
from __future__ import annotations

import asyncio
import json
from typing import Optional

from redis.asyncio import from_url as create_redis

from app.cloud import CLOUD_SYNC_CHANNEL
from app.config import config
from app.database import SessionLocal
from app.models.cloud import CloudBackendLink, CloudMembership, current_cloud_backend_link
from app.utils import cloud_backup, cloud_link

BROADCAST_CHANNEL = "broadcast_channel"
GRANT_SYNC_INTERVAL_SECONDS = 15 * 60


class CloudSync:
    def __init__(self):
        # frame_id -> last_successful_deploy_at we already backed up
        self._deploys_seen: dict[int, str] = {}
        self._deploys_primed = False

    # ---- lifecycle ----------------------------------------------------------

    async def run(self):
        backoff = 5.0
        while True:
            try:
                await self._run_once()
                backoff = 5.0
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001
                print(f"🔴 FrameOS Cloud sync error, retrying in {backoff:.0f}s: {e}")
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 300.0)

    async def _run_once(self):
        redis_sub = create_redis(config.REDIS_URL, decode_responses=True)
        try:
            pubsub = redis_sub.pubsub()
            await pubsub.subscribe(BROADCAST_CHANNEL, CLOUD_SYNC_CHANNEL)
            # Learn current deploy stamps before listening so a restart neither
            # re-pushes every frame nor mistakes old deploys for new ones.
            self._prime_deploys_seen()
            await self._sync_link()
            next_sync = asyncio.get_running_loop().time() + GRANT_SYNC_INTERVAL_SECONDS
            while True:
                timeout = max(next_sync - asyncio.get_running_loop().time(), 1.0)
                message = await pubsub.get_message(ignore_subscribe_messages=True, timeout=timeout)
                if message is not None:
                    await self._handle_message(message)
                if asyncio.get_running_loop().time() >= next_sync:
                    await self._sync_link()
                    next_sync = asyncio.get_running_loop().time() + GRANT_SYNC_INTERVAL_SECONDS
        finally:
            try:
                await redis_sub.close()
            except Exception:  # noqa: BLE001
                pass

    async def _handle_message(self, message: dict):
        raw = message.get("data")
        if message.get("channel") != CLOUD_SYNC_CHANNEL:
            # The broadcast channel also carries every log line and metrics
            # sample; a cheap substring check avoids parsing all of them.
            if not isinstance(raw, str) or '"update_frame"' not in raw:
                return
        try:
            parsed = json.loads(raw)
        except (TypeError, ValueError):
            return
        if not isinstance(parsed, dict):
            return
        if message.get("channel") == CLOUD_SYNC_CHANNEL:
            if parsed.get("event") == "sync_now":
                await self._sync_link()
            return
        if parsed.get("event") == "update_frame" and isinstance(parsed.get("data"), dict):
            await self._maybe_backup_frame(parsed["data"])

    # ---- grants + inventory --------------------------------------------------

    def _load_link(self) -> tuple[Optional[CloudBackendLink], Optional[str], int]:
        db = SessionLocal()
        try:
            link = current_cloud_backend_link(db)
            if link is None or link.status != "connected":
                return link, None, link.id if link else 0

            token = cloud_link.decrypt_cloud_secret(link.access_token)
            if token is None:
                # The stored token cannot be decrypted with any configured key,
                # which in practice means SECRET_KEY changed without
                # CLOUD_SECRET_KEY / PREVIOUS_SECRET_KEYS being set. Say so
                # instead of silently doing nothing forever while the UI keeps
                # reporting the link as connected.
                if link.poll_error != "secret_key_changed":
                    link.poll_error = "secret_key_changed"
                    db.commit()
                print(
                    "🔴 FrameOS Cloud sync: the stored link token cannot be decrypted. "
                    "SECRET_KEY most likely changed; set PREVIOUS_SECRET_KEYS to the old value "
                    "to recover (and CLOUD_SECRET_KEY to decouple them from now on), or "
                    "reconnect the cloud link. See docs/cloud-link.md."
                )
                return link, None, link.id

            # A rotation is in progress: migrate this secret to the current key
            # so the old one can be dropped after a sync cycle.
            rewrapped = cloud_link.rewrap_cloud_secret(link.access_token)
            if rewrapped is not None:
                link.access_token = rewrapped
                db.commit()
                print("🔵 FrameOS Cloud sync: re-encrypted the link token with the current key")
            elif link.poll_error == "secret_key_changed":
                link.poll_error = None
                db.commit()

            return link, token, link.id
        finally:
            db.close()

    async def _sync_link(self):
        link, access_token, link_id = self._load_link()
        if link is None or access_token is None:
            return

        try:
            status_code, response = await cloud_link.backend_grants(link.provider_url, access_token)
        except Exception as e:  # noqa: BLE001
            print(f"🟡 FrameOS Cloud sync: grants check failed ({e}); keeping cached state")
            return

        if status_code == 401:
            self._revoke_link_locally(link_id)
            return
        if status_code != 200:
            print(f"🟡 FrameOS Cloud sync: grants returned {status_code}; keeping cached state")
            return

        self._store_grants(link_id, response)

        try:
            await cloud_link.backend_inventory(
                link.provider_url,
                access_token,
                {
                    "reported_frameos_version": _frameos_version(),
                    "capabilities": {"localFallback": True},
                    "health": {"status": "ok"},
                },
            )
            self._stamp_inventory(link_id)
        except Exception:  # noqa: BLE001
            pass

    def _store_grants(self, link_id: int, response: dict):
        import datetime

        grants = [g for g in (response.get("grants") or []) if isinstance(g, dict)]
        db = SessionLocal()
        try:
            link = db.get(CloudBackendLink, link_id)
            if link is None or link.status != "connected":
                return
            owner = next((g for g in grants if g.get("role") == "owner"), None)
            if owner:
                link.cloud_account_id = owner.get("account_id")
                link.cloud_account_email = owner.get("account_email")
            # Storage usage + limits ride along on the grants response; cache
            # the snapshot so /api/cloud/status can show quota headroom
            # without another provider round trip.
            usage = response.get("usage")
            if isinstance(usage, dict):
                link.cloud_usage = usage
            link.last_grant_sync_at = datetime.datetime.utcnow()

            seen_accounts = set()
            for grant in grants:
                account_id = grant.get("account_id")
                if not account_id:
                    continue
                seen_accounts.add(account_id)
                membership = (
                    db.query(CloudMembership)
                    .filter(
                        CloudMembership.backend_link_id == link.id,
                        CloudMembership.cloud_account_id == account_id,
                    )
                    .first()
                )
                if membership is None:
                    membership = CloudMembership(
                        backend_link_id=link.id,
                        cloud_account_id=account_id,
                        cloud_organization_id="",
                    )
                    db.add(membership)
                membership.role = grant.get("role") or "member"
                membership.synced_at = datetime.datetime.utcnow()
            stale = db.query(CloudMembership).filter(CloudMembership.backend_link_id == link.id)
            if seen_accounts:
                stale = stale.filter(CloudMembership.cloud_account_id.notin_(seen_accounts))
            stale.delete(synchronize_session=False)
            db.commit()
        finally:
            db.close()

    def _stamp_inventory(self, link_id: int):
        import datetime

        db = SessionLocal()
        try:
            link = db.get(CloudBackendLink, link_id)
            if link is not None:
                link.last_inventory_sync_at = datetime.datetime.utcnow()
                db.commit()
        finally:
            db.close()

    def _revoke_link_locally(self, link_id: int):
        db = SessionLocal()
        try:
            link = db.get(CloudBackendLink, link_id)
            if link is None or link.status != "connected":
                return
            from app.api.cloud import _reset_link, revoke_cloud_login_sessions

            _reset_link(link, poll_error="revoked")
            db.commit()
            # Sessions minted through the cloud handoff go with the link,
            # otherwise a revocation on the cloud side takes up to seven days
            # to reach this install.
            revoke_cloud_login_sessions(db)
            print("🟠 FrameOS Cloud sync: the provider revoked this link; local login re-enabled")
        finally:
            db.close()

    # ---- automatic frame backups ----------------------------------------------

    def _prime_deploys_seen(self):
        """Learn current deploy stamps so a worker restart doesn't re-push everything."""
        from app.models.frame import Frame

        db = SessionLocal()
        try:
            for frame_id, backed_up_at in db.query(Frame.id, Frame.last_cloud_backup_deploy_at).all():
                if backed_up_at is not None:
                    self._deploys_seen[frame_id] = backed_up_at.isoformat()
        finally:
            db.close()
        self._deploys_primed = True

    def _mark_deploy_backed_up(self, frame_id: int, marker: str):
        import datetime

        from app.models.frame import Frame

        backed_up_at = datetime.datetime.fromisoformat(marker.removesuffix("Z"))
        db = SessionLocal()
        try:
            frame = db.get(Frame, frame_id)
            if frame is not None:
                frame.last_cloud_backup_deploy_at = backed_up_at
                db.commit()
        finally:
            db.close()

    async def _maybe_backup_frame(self, frame_dict: dict):
        frame_id = frame_dict.get("id")
        deployed_at = frame_dict.get("last_successful_deploy_at")
        if frame_id is None or not deployed_at:
            return
        if not self._deploys_primed:
            self._prime_deploys_seen()
        # The isoformat here comes from Frame.to_dict() (UTC-stamped), while the
        # primed value is the naive column isoformat; compare loosely.
        marker = str(deployed_at).replace("+00:00", "")
        if self._deploys_seen.get(frame_id) == marker:
            return

        link, access_token, private_key = self._load_link_for_backup()
        if link is None or access_token is None or private_key is None:
            return
        # The broadcast is only the trigger: it omits the secret-bearing
        # settings (mountpoints, agent, ...) that a restore needs, so the
        # payload comes from the row itself.
        frame_dict = self._load_frame_dict(frame_id) or frame_dict
        project_name = self._project_name(frame_dict.get("project_id"))
        try:
            status_code, response = await cloud_backup.push_frame_backup(
                link, access_token, private_key, frame_dict, project_name
            )
            if status_code == 200:
                self._mark_deploy_backed_up(frame_id, marker)
                self._deploys_seen[frame_id] = marker
                print(f"🟢 FrameOS Cloud: backed up frame {frame_id} after deploy")
            else:
                detail = response.get("error") or status_code
                print(f"🟡 FrameOS Cloud: frame {frame_id} backup failed: {detail}")
        except Exception as e:  # noqa: BLE001
            print(f"🟡 FrameOS Cloud: frame {frame_id} backup failed: {e}")

    def _load_frame_dict(self, frame_id) -> Optional[dict]:
        from app.models.frame import Frame

        db = SessionLocal()
        try:
            frame = db.get(Frame, frame_id)
            return frame.to_dict() if frame is not None else None
        finally:
            db.close()

    def _load_link_for_backup(self) -> tuple[Optional[CloudBackendLink], Optional[str], Optional[bytes]]:
        """The link, token, and backup key iff frame backups may upload.
        The scope is a permission; the local switch is the feature. The key is
        generated on first use, then reloaded so the detached link instance
        keeps usable attributes after the session closes."""
        db = SessionLocal()
        try:
            link = current_cloud_backend_link(db)
            token = cloud_backup.link_access_token(link)
            if link is None or token is None or "backup:frames" not in link.scopes:
                return None, None, None
            if not link.backup_frames_enabled:
                return None, None, None
            private_key = cloud_backup.ensure_backup_key(db, link)
            db.refresh(link)
            return link, token, private_key
        finally:
            db.close()

    def _project_name(self, project_id) -> Optional[str]:
        if project_id is None:
            return None
        from app.models.organization import Project

        db = SessionLocal()
        try:
            project = db.get(Project, project_id)
            return project.name if project else None
        finally:
            db.close()


def _frameos_version() -> str:
    from app.utils.versions import current_frameos_version

    return current_frameos_version()


cloud_sync_service = CloudSync()
