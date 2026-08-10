import sys

from sqlalchemy import create_engine, event
from sqlalchemy.orm import declarative_base, sessionmaker
from app.config import config

is_sqlite = config.DATABASE_URL.startswith("sqlite")

engine = create_engine(
    config.DATABASE_URL,
    pool_size=20,
    max_overflow=40,
    pool_timeout=30,  # seconds
    pool_recycle=1800,  # seconds
    # SQLite: wait up to 30s for a write lock instead of failing immediately
    connect_args={"timeout": 30} if is_sqlite else {},
)

if is_sqlite:
    # Warn at most once per process: the check runs per connection, and a
    # pooled engine opens many.
    _journal_mode_warned = False

    @event.listens_for(engine, "connect")
    def _set_sqlite_pragmas(dbapi_connection, _connection_record):
        global _journal_mode_warned
        cursor = dbapi_connection.cursor()
        # WAL lets concurrent readers proceed while one connection writes,
        # which is essential with a pooled engine + a separate worker process.
        # `PRAGMA journal_mode=WAL` reports the mode actually in force, so the
        # verification below costs nothing extra.
        journal_row = cursor.execute("PRAGMA journal_mode=WAL").fetchone()
        cursor.execute("PRAGMA synchronous=NORMAL")
        cursor.execute("PRAGMA busy_timeout=30000")
        cursor.close()

        # WAL silently falls back to another journal mode on filesystems that
        # don't support it; surface that instead of guessing later. This is
        # deliberately checked HERE rather than by opening a connection at
        # import time: this module is imported by CLI tools that never touch
        # the database (`backend/bin/cross matrix` in the release workflow,
        # for one), and eagerly connecting made every such invocation print a
        # scary "unable to open database file" in CI. A connection that is
        # actually needed and actually fails still raises normally.
        mode = (journal_row[0] if journal_row else "") or ""
        if mode.lower() != "wal" and not _journal_mode_warned:
            _journal_mode_warned = True
            # stderr: some callers capture stdout (the release workflow's
            # platform listing parses it as JSON).
            print(f"🔴 SQLite journal_mode is {mode!r} (expected 'wal'); "
                  "concurrent writes may fail with 'database is locked'",
                  file=sys.stderr)

SessionLocal = sessionmaker(
    autocommit=False,
    autoflush=False,
    bind=engine,
    expire_on_commit=False,
)
Base = declarative_base()

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
