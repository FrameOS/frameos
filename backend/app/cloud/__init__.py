# Control channel for the cloud sync service in the arq worker. Publish
# {"event": "sync_now"} after connect/disconnect so grant changes and the
# first inventory heartbeat land immediately instead of on the next tick.
CLOUD_SYNC_CHANNEL = "cloud_sync"
