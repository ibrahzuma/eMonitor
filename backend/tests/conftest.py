"""Test infrastructure.

* PostgreSQL: a real database (EMONITOR_TEST_DATABASE_URL, default local port 55432). The schema is
  created by running the Alembic migrations, so migrations are tested on every run.
* Redis: fakeredis (in-process).
* ClickHouse: the in-memory TelemetryStore implementing the same query semantics.
* Background work: ingest direct mode + inline dispatch; tests drive workers explicitly.
"""

from __future__ import annotations

import os

os.environ.setdefault("EMONITOR_TEST_DATABASE_URL", "postgresql+asyncpg://postgres@localhost:55432/emonitor_test")
os.environ["EMONITOR_DATABASE_URL"] = os.environ["EMONITOR_TEST_DATABASE_URL"]
os.environ["EMONITOR_ENVIRONMENT"] = "test"
os.environ["EMONITOR_TELEMETRY_BACKEND"] = "memory"
os.environ["EMONITOR_COOKIE_SECURE"] = "false"
os.environ["EMONITOR_LOG_JSON"] = "false"
os.environ["EMONITOR_RATE_LIMIT_API"] = "100000/60"
os.environ["EMONITOR_DEV_INLINE_WORKERS"] = "false"
os.environ.setdefault("EMONITOR_SECRET_KEY", "test-secret-key-0123456789abcdef0123456789")

import uuid  # noqa: E402
from collections.abc import AsyncIterator  # noqa: E402
from dataclasses import dataclass  # noqa: E402

import fakeredis  # noqa: E402
import httpx  # noqa: E402
import pytest  # noqa: E402
import pytest_asyncio  # noqa: E402
from sqlalchemy import text  # noqa: E402

from app.core.db import get_engine, get_sessionmaker  # noqa: E402
from app.core.redis import set_redis  # noqa: E402
from app.core.security import generate_api_key, hash_password  # noqa: E402
from app.models import ApiKey, Base, Membership, Organization, User  # noqa: E402
from app.models.tenancy import default_org_settings, default_thresholds  # noqa: E402
from app.telemetry import ingest  # noqa: E402
from app.telemetry.store import MemoryStore, set_store  # noqa: E402
from app.workers import dispatch  # noqa: E402

PASSWORD = "Correct-Horse-42"


def _run_migrations() -> None:
    import subprocess
    import sys

    subprocess.run([sys.executable, "-m", "alembic", "downgrade", "base"], check=True, capture_output=True,
                   cwd=os.path.dirname(os.path.dirname(__file__)))
    subprocess.run([sys.executable, "-m", "alembic", "upgrade", "head"], check=True, capture_output=True,
                   cwd=os.path.dirname(os.path.dirname(__file__)))


@pytest.fixture(scope="session", autouse=True)
def _schema() -> None:
    _run_migrations()


@pytest_asyncio.fixture(autouse=True, loop_scope="session")
async def _clean_state() -> AsyncIterator[None]:
    engine = get_engine()
    tables = ", ".join(f'"{t.name}"' for t in Base.metadata.sorted_tables)
    async with engine.begin() as conn:
        await conn.execute(text(f"TRUNCATE {tables} RESTART IDENTITY CASCADE"))
    store = MemoryStore()
    set_store(store)
    set_redis(fakeredis.FakeAsyncRedis(decode_responses=True))
    ingest.set_direct_mode(True)
    dispatch.set_inline(True)
    yield


@pytest.fixture
def store() -> MemoryStore:
    from app.telemetry.store import get_store

    s = get_store()
    assert isinstance(s, MemoryStore)
    return s


@pytest_asyncio.fixture(loop_scope="session")
async def db():
    async with get_sessionmaker()() as session:
        yield session


@pytest_asyncio.fixture(loop_scope="session")
async def client() -> AsyncIterator[httpx.AsyncClient]:
    from app.main import app

    transport = httpx.ASGITransport(app=app, client=("127.0.0.1", 50000))
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


@dataclass
class Actor:
    user: User
    org: Organization
    token: str

    @property
    def headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.token}", "X-Organization-ID": str(self.org.id)}


async def make_org(name: str = "Org", slug: str | None = None, scope: dict | None = None) -> Organization:
    async with get_sessionmaker()() as s:
        org = Organization(name=name, slug=slug or f"org-{uuid.uuid4().hex[:8]}", settings=default_org_settings(),
                           thresholds=default_thresholds(),
                           monitoring_scope=scope or {"allow_public": True, "cidrs": ["127.0.0.0/8"], "hostnames": []})
        s.add(org)
        await s.commit()
        return org


async def make_user(org: Organization | None, role: str = "org_admin", email: str | None = None,
                    superadmin: bool = False) -> User:
    async with get_sessionmaker()() as s:
        u = User(email=email or f"u{uuid.uuid4().hex[:8]}@example.com", full_name="Test User",
                 password_hash=hash_password(PASSWORD), is_superadmin=superadmin)
        s.add(u)
        await s.flush()
        if org is not None:
            s.add(Membership(user_id=u.id, organization_id=org.id, role=role))
        await s.commit()
        return u


async def login(client: httpx.AsyncClient, email: str, password: str = PASSWORD) -> str:
    r = await client.post("/api/v1/auth/login", json={"email": email, "password": password})
    assert r.status_code == 200, r.text
    return r.json()["access_token"]


async def make_actor(client: httpx.AsyncClient, role: str = "org_admin", org: Organization | None = None,
                     scope: dict | None = None) -> Actor:
    org = org or await make_org(scope=scope)
    user = await make_user(org, role)
    return Actor(user=user, org=org, token=await login(client, user.email))


async def make_api_key(org: Organization, role: str = "it_admin", scopes: list[str] | None = None) -> str:
    full, prefix, h = generate_api_key()
    async with get_sessionmaker()() as s:
        s.add(ApiKey(organization_id=org.id, name="test", prefix=prefix, secret_hash=h, role=role, scopes=scopes or []))
        await s.commit()
    return full
