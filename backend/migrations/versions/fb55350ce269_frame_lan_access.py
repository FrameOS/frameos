"""frame.lan_access: the frame-level LAN access switch

Revision ID: fb55350ce269
Revises: 5e2a9c71d4b8
Create Date: 2026-10-17

One switch per frame decides whether scene HTTP may reach private/local
addresses, on every frame type and both control planes. The device holds the
truth (state/local_access.json, ESP32 NVS `lan_access`); this column mirrors
it, seeds a new frame (frame.json `network.lanAccess`, ESP32 provisioning)
and is what the backend's own renderer obeys for the frames it renders.

Every frame that exists today keeps working: it gets LAN access ON, which is
also what a device with no stored value reads. The database default stays ON
for that reason; the ORM's default (a frame created from now on) is OFF
unless the add-frame form turned it on.

The exception is a frame the backend renders itself and that has no device
switch of its own: a virtual frame or a Pico thin client. Its scenes ran on
the backend's network under `network.allowLocalNetworkAccess`, which nothing
but an API call ever set, so it keeps that value (off, nearly always) instead
of gaining a reach into the backend's LAN it never had. The platform lists are
a frozen copy of app/tasks/embedded_firmware.py's as of this revision.
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "fb55350ce269"
down_revision = "5e2a9c71d4b8"
branch_labels = None
depends_on = None

_VIRTUAL_PLATFORMS = frozenset({"virtual", "backend-renderer", "virtual-frame"})
_PICO_PLATFORMS = frozenset(
    {"pico-w", "pico_w", "picow", "rp2040", "pico-2w", "pico2_w", "pico2w", "pico-2-w", "rp2350"}
)


def _platform(embedded, device_config) -> str:
    for source in (embedded, device_config):
        if isinstance(source, dict) and source.get("platform"):
            return str(source.get("platform")).strip().lower()
    return ""


def _backend_rendered(mode, device, embedded, device_config) -> bool:
    """A frame whose scenes the backend renders and that has no device-side
    switch: a virtual frame, a Pico thin client."""
    if (mode or "rpios") != "embedded":
        return False
    if device == "virtual":
        return True
    platform = _platform(embedded, device_config)
    return platform in _VIRTUAL_PLATFORMS or platform in _PICO_PLATFORMS


def _keep_backend_rendered_frames_as_they_were(connection) -> None:
    table = sa.Table(
        "frame",
        sa.MetaData(),
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("mode", sa.String),
        sa.Column("device", sa.String),
        sa.Column("embedded", sa.JSON()),
        sa.Column("device_config", sa.JSON()),
        sa.Column("network", sa.JSON()),
        sa.Column("lan_access", sa.Boolean()),
    )
    rows = connection.execute(
        sa.select(table.c.id, table.c.mode, table.c.device, table.c.embedded, table.c.device_config, table.c.network)
    ).all()
    for row_id, mode, device, embedded, device_config, network in rows:
        if not _backend_rendered(mode, device, embedded, device_config):
            continue
        allowed = isinstance(network, dict) and network.get("allowLocalNetworkAccess") is True
        connection.execute(table.update().where(table.c.id == row_id).values(lan_access=allowed))


def upgrade() -> None:
    with op.batch_alter_table("frame") as batch_op:
        batch_op.add_column(sa.Column("lan_access", sa.Boolean(), nullable=False, server_default=sa.true()))
    _keep_backend_rendered_frames_as_they_were(op.get_bind())


def downgrade() -> None:
    with op.batch_alter_table("frame") as batch_op:
        batch_op.drop_column("lan_access")
