import os

# Ensure TEST=1 before anything else, so we always run in test mode
os.environ["TEST"] = "1"

import json  # noqa: E402
import pytest  # noqa: E402
import pytest_asyncio  # noqa: E402
from redis.asyncio import Redis  # noqa: E402
from httpx import AsyncClient  # noqa: E402
from httpx._transports.asgi import ASGITransport  # noqa: E402
from app.config import get_config  # noqa: E402
from app.fastapi import app  # noqa: E402
from app.models import User  # noqa: E402
from app.database import SessionLocal, engine, Base  # noqa: E402

@pytest.fixture(autouse=True)
def setup_and_teardown_db():
    if not get_config().TEST:
        raise ValueError("Tests should only be run with TEST=1 (or via bin/tests) as doing otherwise may wipe your database")

    # Create all tables before each test
    Base.metadata.create_all(bind=engine)
    yield
    # Drop all tables after each test
    Base.metadata.drop_all(bind=engine)

@pytest_asyncio.fixture
async def db_session():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

@pytest_asyncio.fixture
async def redis():
    client = Redis.from_url(get_config().REDIS_URL)
    yield client
    client.close()

@pytest_asyncio.fixture
async def async_client(db_session, redis):
    user = User(email="test@example.com")
    user.set_password("testpassword")
    db_session.add(user)
    db_session.commit()

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        login_data = {"username": "test@example.com", "password": "testpassword"}
        login_response = await ac.post('/api/login', data=login_data)
        token = login_response.json().get('access_token')
        headers = {"Authorization": f"Bearer {token}"}
        ac.headers.update(headers)

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