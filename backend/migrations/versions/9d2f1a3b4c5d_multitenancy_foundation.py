"""multitenancy foundation

Revision ID: 9d2f1a3b4c5d
Revises: 8b3d7a41c9e2
Create Date: 2026-06-01 00:00:00.000000

"""
import secrets

from alembic import op
import sqlalchemy as sa


revision = "9d2f1a3b4c5d"
down_revision = "8b3d7a41c9e2"
branch_labels = None
depends_on = None


TENANT_TABLES = (
    "ai_embeddings",
    "assets",
    "chat",
    "chat_message",
    "frame",
    "log",
    "metrics",
    "repository",
    "scene_image",
    "settings",
    "template",
)


def _default_project_id(conn) -> int:
    user_id = conn.execute(sa.text('SELECT id FROM "user" ORDER BY id ASC LIMIT 1')).scalar()

    conn.execute(sa.text("INSERT INTO organization (name, created_at) VALUES (:name, CURRENT_TIMESTAMP)"), {"name": "Default Organization"})
    organization_id = conn.execute(sa.text("SELECT max(id) FROM organization")).scalar()

    conn.execute(
        sa.text("INSERT INTO project (organization_id, name, created_at) VALUES (:organization_id, :name, CURRENT_TIMESTAMP)"),
        {"organization_id": organization_id, "name": "Default Project"},
    )
    project_id = conn.execute(sa.text("SELECT max(id) FROM project")).scalar()

    if user_id is not None:
        conn.execute(
            sa.text(
                "INSERT INTO organization_member (organization_id, user_id, role, created_at) "
                "VALUES (:organization_id, :user_id, 'owner', CURRENT_TIMESTAMP)"
            ),
            {"organization_id": organization_id, "user_id": user_id},
        )

    return int(project_id)


def _dedupe_frame_server_api_keys(conn) -> None:
    conn.execute(sa.text("UPDATE frame SET server_api_key = NULL WHERE server_api_key = ''"))
    rows = conn.execute(
        sa.text(
            "SELECT id, server_api_key FROM frame "
            "WHERE server_api_key IS NOT NULL "
            "ORDER BY server_api_key, id"
        )
    ).fetchall()
    seen: set[str] = set()
    for frame_id, server_api_key in rows:
        if server_api_key not in seen:
            seen.add(server_api_key)
            continue
        replacement = secrets.token_hex(32)
        while replacement in seen:
            replacement = secrets.token_hex(32)
        seen.add(replacement)
        conn.execute(
            sa.text("UPDATE frame SET server_api_key = :server_api_key WHERE id = :frame_id"),
            {"server_api_key": replacement, "frame_id": frame_id},
        )


def upgrade():
    op.create_table(
        "organization",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(length=256), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_table(
        "organization_member",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("organization_id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("role", sa.String(length=32), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["organization_id"], ["organization.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["user.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("organization_id", "user_id", name="uq_organization_member_user"),
    )
    op.create_table(
        "project",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("organization_id", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(length=256), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["organization_id"], ["organization.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )

    conn = op.get_bind()
    project_id = _default_project_id(conn)

    for table in TENANT_TABLES:
        with op.batch_alter_table(table, schema=None) as batch_op:
            batch_op.add_column(sa.Column("project_id", sa.Integer(), nullable=True))
            batch_op.create_index(f"ix_{table}_project_id", ["project_id"])

        conn.execute(sa.text(f"UPDATE {table} SET project_id = :project_id WHERE project_id IS NULL"), {"project_id": project_id})

        with op.batch_alter_table(table, schema=None) as batch_op:
            batch_op.alter_column("project_id", existing_type=sa.Integer(), nullable=False)
            batch_op.create_foreign_key(f"fk_{table}_project_id_project", "project", ["project_id"], ["id"])

    with op.batch_alter_table("settings", schema=None) as batch_op:
        batch_op.create_unique_constraint("uq_settings_project_key", ["project_id", "key"])
    # The legacy assets table only had the id primary key and an unnamed
    # assets.path uniqueness constraint. SQLite batch_alter_table preserves
    # that unnamed constraint, so recreate the table explicitly and replace it
    # with per-project path uniqueness.
    op.create_table(
        "assets_multitenant",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("path", sa.Text(), nullable=False),
        sa.Column("data", sa.LargeBinary(), nullable=True),
        sa.Column("project_id", sa.Integer(), nullable=False),
        sa.ForeignKeyConstraint(["project_id"], ["project.id"], name="fk_assets_project_id_project"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("project_id", "path", name="uq_assets_project_path"),
    )
    conn.execute(sa.text("INSERT INTO assets_multitenant (id, path, data, project_id) SELECT id, path, data, project_id FROM assets"))
    op.drop_table("assets")
    op.rename_table("assets_multitenant", "assets")
    op.create_index("ix_assets_project_id", "assets", ["project_id"])
    with op.batch_alter_table("ai_embeddings", schema=None) as batch_op:
        batch_op.drop_constraint("uq_ai_embeddings_source", type_="unique")
        batch_op.create_unique_constraint("uq_ai_embeddings_project_source", ["project_id", "source_type", "source_path"])
    with op.batch_alter_table("scene_image", schema=None) as batch_op:
        batch_op.drop_constraint("u_frame_scene", type_="unique")
        batch_op.create_unique_constraint("u_project_frame_scene", ["project_id", "frame_id", "scene_id"])
    # Existing installs may have duplicated or empty legacy keys. Normalize
    # those rows before adding the global unique constraint.
    _dedupe_frame_server_api_keys(conn)
    with op.batch_alter_table("frame", schema=None) as batch_op:
        batch_op.create_unique_constraint("uq_frame_server_api_key", ["server_api_key"])


def downgrade():
    with op.batch_alter_table("frame", schema=None) as batch_op:
        batch_op.drop_constraint("uq_frame_server_api_key", type_="unique")
    with op.batch_alter_table("scene_image", schema=None) as batch_op:
        batch_op.drop_constraint("u_project_frame_scene", type_="unique")
        batch_op.create_unique_constraint("u_frame_scene", ["frame_id", "scene_id"])
    with op.batch_alter_table("ai_embeddings", schema=None) as batch_op:
        batch_op.drop_constraint("uq_ai_embeddings_project_source", type_="unique")
        batch_op.create_unique_constraint("uq_ai_embeddings_source", ["source_type", "source_path"])
    with op.batch_alter_table("assets", schema=None) as batch_op:
        batch_op.drop_constraint("uq_assets_project_path", type_="unique")
    with op.batch_alter_table("settings", schema=None) as batch_op:
        batch_op.drop_constraint("uq_settings_project_key", type_="unique")

    for table in reversed(TENANT_TABLES):
        with op.batch_alter_table(table, schema=None) as batch_op:
            batch_op.drop_constraint(f"fk_{table}_project_id_project", type_="foreignkey")
            batch_op.drop_index(f"ix_{table}_project_id")
            batch_op.drop_column("project_id")

    op.drop_table("project")
    op.drop_table("organization_member")
    op.drop_table("organization")
