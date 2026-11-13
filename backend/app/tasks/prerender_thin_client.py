"""Draw a sleeping thin client's next picture before it wakes.

Queued by a thin client's `sleep` log line (app/utils/server_render.py
`schedule_prerender`) to run `lead` seconds before the wake; the picture is
kept for the pull at the wake (docs/server-rendering.md "Deep sleep").
"""

from __future__ import annotations

from typing import Any, Dict

from app.models.frame import Frame


async def prerender_thin_client_task(ctx: Dict[str, Any], id: int, as_of_ms: int) -> bool:
    db = ctx["db"]
    redis = ctx["redis"]
    frame = db.get(Frame, id)
    if frame is None:
        return False
    # Imported here: the API module pulls in the routers.
    from app.api.embedded_device import prerender_thin_client

    return await prerender_thin_client(db, redis, frame, int(as_of_ms))
