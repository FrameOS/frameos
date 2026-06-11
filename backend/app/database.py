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
    @event.listens_for(engine, "connect")
    def _set_sqlite_pragmas(dbapi_connection, _connection_record):
        cursor = dbapi_connection.cursor()
        # WAL lets concurrent readers proceed while one connection writes,
        # which is essential with a pooled engine + a separate worker process.
        cursor.execute("PRAGMA journal_mode=WAL")
        cursor.execute("PRAGMA synchronous=NORMAL")
        cursor.execute("PRAGMA busy_timeout=30000")
        cursor.close()

    # WAL silently falls back to another journal mode on filesystems that
    # don't support it; surface that in the logs instead of guessing later.
    try:
        with engine.connect() as _conn:
            _journal_mode = _conn.exec_driver_sql("PRAGMA journal_mode").scalar()
        if _journal_mode != "wal":
            print(f"🔴 SQLite journal_mode is {_journal_mode!r} (expected 'wal'); "
                  "concurrent writes may fail with 'database is locked'")
    except Exception as e:
        print(f"🔴 Could not verify SQLite journal mode: {e}")

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
