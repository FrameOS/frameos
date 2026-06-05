import importlib

import sqlalchemy as sa


def test_multitenancy_migration_dedupes_frame_server_api_keys(monkeypatch):
    migration = importlib.import_module("migrations.versions.9d2f1a3b4c5d_multitenancy_foundation")
    replacements = iter(["alpha", "replacement-one", "replacement-two"])
    monkeypatch.setattr(migration.secrets, "token_hex", lambda _bytes: next(replacements))

    engine = sa.create_engine("sqlite:///:memory:")
    with engine.begin() as conn:
        conn.execute(sa.text("CREATE TABLE frame (id INTEGER PRIMARY KEY, server_api_key VARCHAR(64))"))
        conn.execute(
            sa.text("INSERT INTO frame (id, server_api_key) VALUES (:id, :server_api_key)"),
            [
                {"id": 1, "server_api_key": "alpha"},
                {"id": 2, "server_api_key": "alpha"},
                {"id": 3, "server_api_key": "beta"},
                {"id": 4, "server_api_key": "beta"},
                {"id": 5, "server_api_key": ""},
                {"id": 6, "server_api_key": None},
            ],
        )

        migration._dedupe_frame_server_api_keys(conn)

        rows = conn.execute(sa.text("SELECT id, server_api_key FROM frame ORDER BY id")).fetchall()
        values = [row.server_api_key for row in rows]
        non_null_values = [value for value in values if value is not None]

        assert values == ["alpha", "replacement-one", "beta", "replacement-two", None, None]
        assert len(non_null_values) == len(set(non_null_values))
