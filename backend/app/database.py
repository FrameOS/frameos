from sqlalchemy import create_engine
from sqlalchemy.orm import declarative_base, sessionmaker
from app.config import config

engine = create_engine(
    config.DATABASE_URL,
    pool_size=20,
    max_overflow=40,
    pool_timeout=30,  # seconds
    pool_recycle=1800  # seconds
)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
