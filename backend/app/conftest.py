import json
import pytest
import pytest_asyncio
from httpx import AsyncClient
from httpx._transports.asgi import ASGITransport
from app.config import get_config
from app.fastapi import app
from app.models import User
from app.database import SessionLocal, engine, Base

@pytest.fixture(autouse=True)
def setup_and_teardown_db():
    if not get_config().TEST:
        raise ValueError("Tests should only be run with TEST=1 (or via bin/tests) as doing otherwise may wipe your database")

    # Create all tables before each test
    Base.metadata.create_all(bind=engine)
    yield
    # Drop all tables after each test
    Base.metadata.drop_all(bind=engine)

@pytest_asyncio.fixture(scope="session")
async def db_session():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

@pytest_asyncio.fixture
async def async_client(db_session):
    user = User(email="test@example.com")
    user.set_password("testpassword")
    db_session.add(user)
    db_session.commit()

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        # r = await ac.post('/api/login', json={"email": "test@example.com", "password": "testpassword"})
        # assert r.status_code == 200, f"Login failed: {r.text}"
        yield ac

@pytest_asyncio.fixture
async def no_auth_client():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac


class MockResponse:
    def __init__(self, status_code, content=None):
        self.status_code = status_code
        self.content = content

    def json(self):
        try:
            return json.loads(self.content) if self.content else {}
        except json.JSONDecodeError:
            return {}