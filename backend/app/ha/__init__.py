# Redis pub/sub channel for Home Assistant sync control messages
# ({"event": "settings_changed" | "sync_now", "project_id": int}).
# Kept import-light: app.api.settings imports this without pulling in aiomqtt.
HA_SYNC_CHANNEL = "ha_sync"

# Redis key holding a pending "sync now" request from the API
# ({"reply_channel": str, "project_id": int}). Stored as a key rather than only
# published, so the sync service still finds it when the nudge on
# HA_SYNC_CHANNEL lands while the service is between reconnects.
HA_SYNC_REQUEST_KEY = "ha_sync:request"
