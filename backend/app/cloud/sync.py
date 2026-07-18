"""FrameOS Cloud sync service (CLOUD-TODO Phase 1).

Runs as a single asyncio task inside the arq worker (same singleton slot as
the Home Assistant sync). Responsibilities:

- Grants sync: periodically re-reads /api/backends/grants so a cloud-side
  revocation takes effect quickly. A 401 means the link was revoked: the local
  link resets and local password login is re-enabled so nobody is locked out.
- Inventory heartbeat: keeps version/health fresh on the provider.
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
from app.utils import cloud_link

GRANT_SYNC_INTERVAL_SECONDS = 15 * 60


class CloudSync:
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
            await pubsub.subscribe(CLOUD_SYNC_CHANNEL)
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
        try:
            parsed = json.loads(message["data"])
        except (TypeError, ValueError):
            return
        if not isinstance(parsed, dict):
            return
        if message.get("channel") == CLOUD_SYNC_CHANNEL:
            if parsed.get("event") == "sync_now":
                await self._sync_link()

    # ---- grants + inventory --------------------------------------------------

    def _load_link(self) -> tuple[Optional[CloudBackendLink], Optional[str], int]:
        db = SessionLocal()
        try:
            link = current_cloud_backend_link(db)
            token = (
                cloud_link.decrypt_cloud_secret(link.access_token)
                if link is not None and link.status == "connected"
                else None
            )
            return link, token, link.id if link else 0
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
            from app.api.cloud import _reset_link

            _reset_link(link, poll_error="revoked")
            db.commit()
            print("🟠 FrameOS Cloud sync: the provider revoked this link; local login re-enabled")
        finally:
            db.close()


def _frameos_version() -> str:
    from app.utils.versions import current_frameos_version

    return current_frameos_version()


cloud_sync_service = CloudSync()
