# Redis pub/sub channel for Home Assistant sync control messages
# ({"event": "settings_changed" | "sync_now", "project_id": int}).
# Kept import-light: app.api.settings imports this without pulling in aiomqtt.
HA_SYNC_CHANNEL = "ha_sync"
