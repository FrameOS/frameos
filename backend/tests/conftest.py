import os
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

import app.models
from app.main import app
from app.core.database import Base, SessionLocal
from app.core.deps import get_db
from app.config import get_config

# Set the environment to testing before loading config
os.environ["APP_ENV"] = "testing"
config = get_config()

# Create a separate, in-memory database engine for tests
engine = create_engine(config.SQLALCHEMY_DATABASE_URI, connect_args={"check_same_thread": False})
TestingSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

@pytest.fixture(scope="session", autouse=True)
def setup_database():
    # Drop all tables
    Base.metadata.drop_all(bind=engine)
    # Re-create all tables
    Base.metadata.create_all(bind=engine)
    yield
    # After the test completes, drop tables again if desired
    Base.metadata.drop_all(bind=engine)

@pytest.fixture
def db_session():
    # Start a transaction
    connection = engine.connect()
    transaction = connection.begin()
    session = SessionLocal(bind=connection)

    try:
        yield session
    finally:
        # Roll back the transaction after the test
        session.close()
        transaction.rollback()
        connection.close()

# Override the get_db dependency to use the test session
app.dependency_overrides[get_db] = lambda: next(iter([TestingSessionLocal()]))

@pytest.fixture
def client():
    # Use the TestClient from FastAPI
    with TestClient(app) as c:
        yield c
