import os
from urllib.parse import urlsplit, urlunsplit

# Ensure TEST=1 before anything else, so we always run in test mode
os.environ["TEST"] = "1"


def _isolate_xdist_worker() -> None:
    """Under pytest-xdist (`pytest -n N`, what CI runs) every worker is its own
    process with its own database file and its own Redis database, set here
    before app.config reads them: the tables are created and dropped around
    every test and the Redis fixture flushes its database, so two workers
    sharing either would wipe each other's state mid-test. Worker gwN gets
    the default (or given) Redis database number plus N, so N workers need
    that many databases on the server: CI starts redis with --databases 64."""
    worker = os.environ.get("PYTEST_XDIST_WORKER", "")
    if not worker.startswith("gw"):
        return
    index = int(worker[2:])
    database_url = os.environ.get("DATABASE_URL") or "sqlite:///migrations/test.db"
    if database_url.startswith("sqlite:///") and database_url.endswith(".db"):
        os.environ["DATABASE_URL"] = f"{database_url[:-3]}-{worker}.db"
    redis = urlsplit(os.environ.get("REDIS_URL") or "redis://localhost:6379/1")
    base = int(redis.path.strip("/") or 0)
    os.environ["REDIS_URL"] = urlunsplit(redis._replace(path=f"/{base + index}"))


_isolate_xdist_worker()

import json  # noqa: E402
import pytest  # noqa: E402
import pytest_asyncio  # noqa: E402
from arq import ArqRedis as Redis  # noqa: E402
from httpx import AsyncClient  # noqa: E402
from httpx._transports.asgi import ASGITransport  # noqa: E402
from app.config import config  # noqa: E402
from app.fastapi import app  # noqa: E402
from app.database import SessionLocal, engine, Base  # noqa: E402
from app.models.organization import Project  # noqa: E402
from app.models.user import User  # noqa: E402
from app.tenancy import ensure_default_project_for_user  # noqa: E402


PROJECT_SCOPED_TEST_PATHS = (
    "/api/ai/",
    "/api/apps",
    "/api/assets",
    "/api/fonts",
    "/api/frames",
    "/api/photos",
    "/api/repositories",
    "/api/settings",
    "/api/templates",
)

PROJECT_SCOPED_TEST_EXCLUSIONS = (
    "/api/projects/",
    "/api/photos/shared/",
    "/api/repositories/system",
    "/api/repositories/system/",
)


class ProjectAsyncClient(AsyncClient):
    project_id: int | None = None

    def _project_url(self, url):
        if not isinstance(url, str) or self.project_id is None:
            return url
        path, separator, query = url.partition("?")
        if (
            any(path.startswith(exclusion) for exclusion in PROJECT_SCOPED_TEST_EXCLUSIONS)
            or not any(path == prefix or path.startswith(f"{prefix}/") for prefix in PROJECT_SCOPED_TEST_PATHS)
        ):
            return url
        scoped = f"/api/projects/{self.project_id}{path[len('/api'):]}"
        return f"{scoped}{separator}{query}"

    async def request(self, method, url, *args, **kwargs):
        return await super().request(method, self._project_url(url), *args, **kwargs)


@pytest.fixture(autouse=True)
def fictional_hosts_resolve(monkeypatch):
    """The outbound target guard (app/utils/network.py) resolves every host
    the backend is asked to fetch from. Tests use made-up names
    (frame.local, cloud.example.com, ...) with the HTTP client faked, so
    those resolve to a public address here; literals are judged as
    themselves, which is what the guard's own tests exercise. A test that
    wants real DNS restores `network.resolve_target_dns`."""
    import ipaddress

    from app.utils import network

    async def resolve(host: str):
        literal = network.literal_address(host)
        if literal is not None:
            return [literal]
        if not network.is_safe_host(host.strip("[]")):
            raise network.TargetBlocked(host, "does not resolve")
        return [ipaddress.ip_address("93.184.216.34")]

    monkeypatch.setattr(network, "resolve_target", resolve)


@pytest.fixture(autouse=True)
def setup_and_teardown_db():
    if not config.TEST:
        raise ValueError("Tests should only be run with TEST=1 (or via bin/tests) as doing otherwise may wipe your database")

    # Create all tables before each test
    Base.metadata.create_all(bind=engine)
    # Frame ids repeat across tests (fresh tables each time), so reset the
    # per-process log-prune throttle to keep tests order-independent.
    from app.models.log import _inserts_since_prune_check
    _inserts_since_prune_check.clear()
    yield
    # Drop all tables after each test
    Base.metadata.drop_all(bind=engine)

@pytest_asyncio.fixture
async def db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

@pytest_asyncio.fixture
async def redis():
    client = Redis.from_url(config.REDIS_URL)
    try:
        await client.flushdb()
        yield client
    finally:
        await client.flushdb()
        await client.close(True)


@pytest_asyncio.fixture
async def default_project(db):
    user = User(email="project@example.com")
    user.set_password("testpassword")
    db.add(user)
    db.commit()
    db.refresh(user)
    return ensure_default_project_for_user(db, user)

@pytest_asyncio.fixture
async def async_client(db):
    user = User(email="test@example.com")
    user.set_password("testpassword")
    db.add(user)
    db.commit()
    db.refresh(user)
    project = ensure_default_project_for_user(db, user)

    transport = ASGITransport(app=app)
    async with ProjectAsyncClient(transport=transport, base_url="http://test") as ac:
        login_data = {"username": "test@example.com", "password": "testpassword"}
        login_response = await ac.post('/api/login', data=login_data)
        token = login_response.json().get('access_token')
        headers = {"Authorization": f"Bearer {token}"}
        ac.headers.update(headers)
        ac.project_id = project.id

        yield ac


@pytest_asyncio.fixture
async def project(db, async_client):
    yield db.get(Project, async_client.project_id)

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
