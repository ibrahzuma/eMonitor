"""Administrative CLI.

    python -m app.cli bootstrap --email admin@example.com --org-name "Acme" --org-slug acme
    python -m app.cli create-user --email ops@example.com --org-slug acme --role operator
    python -m app.cli clickhouse-migrate
    python -m app.cli seed-demo            # development/demo environments only

Passwords are read interactively (or from EMONITOR_BOOTSTRAP_PASSWORD for automation).
"""

from __future__ import annotations

import argparse
import asyncio
import getpass
import os
import re
import sys
from pathlib import Path

from sqlalchemy import func, select

from app.core.config import get_settings
from app.core.db import dispose_engine, session_scope
from app.core.security import hash_password, validate_password_strength
from app.models import Membership, Organization, User
from app.models.enums import Role
from app.models.tenancy import default_org_settings, default_thresholds


def _password(prompt: str = "Password: ") -> str:
    pw = os.environ.get("EMONITOR_BOOTSTRAP_PASSWORD")
    if not pw:
        pw = getpass.getpass(prompt)
        if getpass.getpass("Repeat password: ") != pw:
            sys.exit("Passwords do not match")
    problems = validate_password_strength(pw)
    if problems:
        sys.exit("Password " + ", ".join(problems))
    return pw


async def bootstrap(email: str, org_name: str, org_slug: str, full_name: str) -> None:
    async with session_scope() as db:
        if await db.scalar(select(User.id).where(User.is_superadmin.is_(True))):
            print("A Super Administrator already exists; nothing to do.")
            return
        pw = _password()
        user = User(email=email.lower(), full_name=full_name, password_hash=hash_password(pw), is_superadmin=True)
        db.add(user)
        org = await db.scalar(select(Organization).where(Organization.slug == org_slug))
        if org is None:
            org = Organization(name=org_name, slug=org_slug, settings=default_org_settings(),
                               thresholds=default_thresholds(),
                               monitoring_scope={"allow_public": True, "cidrs": [], "hostnames": []})
            db.add(org)
        await db.flush()
        db.add(Membership(user_id=user.id, organization_id=org.id, role=Role.ORG_ADMIN))
    print(f"Created Super Administrator {email} and organization '{org_name}' ({org_slug}).")


async def create_user(email: str, org_slug: str, role: str, full_name: str) -> None:
    async with session_scope() as db:
        org = await db.scalar(select(Organization).where(Organization.slug == org_slug))
        if not org:
            sys.exit(f"organization {org_slug!r} not found")
        user = await db.scalar(select(User).where(func.lower(User.email) == email.lower()))
        if user is None:
            user = User(email=email.lower(), full_name=full_name, password_hash=hash_password(_password()))
            db.add(user)
            await db.flush()
        if await db.scalar(select(Membership.id).where(Membership.user_id == user.id,
                                                       Membership.organization_id == org.id)):
            sys.exit("user is already a member")
        db.add(Membership(user_id=user.id, organization_id=org.id, role=Role(role)))
    print(f"Added {email} to {org_slug} as {role}.")


async def clickhouse_migrate() -> None:
    import clickhouse_connect

    s = get_settings()
    db = s.clickhouse_database
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{0,62}", db):
        sys.exit("invalid ClickHouse database name")
    client = await clickhouse_connect.get_async_client(
        host=s.clickhouse_host, port=s.clickhouse_port, username=s.clickhouse_user,
        password=s.clickhouse_password.get_secret_value(), secure=s.clickhouse_secure)
    await client.command(f"CREATE DATABASE IF NOT EXISTS {db}")
    sql = (Path(__file__).parent / "telemetry" / "schema.sql").read_text(encoding="utf-8")
    for stmt in [x.strip() for x in sql.split("\n;;\n") if x.strip()]:
        body = "\n".join(line for line in stmt.splitlines() if not line.strip().startswith("--")).strip()
        if body:
            await client.command(body.replace("{db}", db))
    await client.command(f"INSERT INTO {db}.schema_migrations (version) VALUES (1)")
    print(f"ClickHouse schema applied to database {db}.")


async def seed_demo() -> None:
    """Demo org with real, publicly reachable targets. No monitoring results are fabricated."""
    s = get_settings()
    if s.is_production:
        sys.exit("seed-demo is not allowed in production")
    from datetime import UTC, datetime

    from app.models import Check, Resource

    async with session_scope() as db:
        org = await db.scalar(select(Organization).where(Organization.slug == "demo"))
        if org is None:
            org = Organization(name="Demo Organization (DEMO DATA)", slug="demo", settings=default_org_settings(),
                               thresholds=default_thresholds(),
                               monitoring_scope={"allow_public": True, "cidrs": [], "hostnames": []})
            db.add(org)
            await db.flush()
        admin = await db.scalar(select(User).where(User.is_superadmin.is_(True)))
        if admin and not await db.scalar(select(Membership.id).where(Membership.user_id == admin.id,
                                                                     Membership.organization_id == org.id)):
            db.add(Membership(user_id=admin.id, organization_id=org.id, role=Role.ORG_ADMIN))
        demo = [
            ("Example.com", "website", "https://example.com/", {"keyword": "Example Domain"}),
            ("IANA", "website", "https://www.iana.org/", {}),
            ("Wikipedia", "website", "https://www.wikipedia.org/", {"keyword": "Wikipedia"}),
            ("GitHub API", "api", "https://api.github.com/", {"expected_status": ["200"]}),
        ]
        now = datetime.now(UTC)
        for name, kind, url, extra in demo:
            if await db.scalar(select(Resource.id).where(Resource.organization_id == org.id, Resource.name == name)):
                continue
            r = Resource(organization_id=org.id, kind=kind, name=name, address=url, environment="production",
                         tags=["demo"], description="Demo resource (clearly identified demo data)")
            db.add(r)
            await db.flush()
            db.add(Check(organization_id=org.id, resource_id=r.id, name="HTTP", type="http",
                         config={"url": url, "method": "GET", "expected_status": ["200-399"], "ssl_check": True, **extra},
                         interval_seconds=60, timeout_seconds=10, next_run_at=now))
        if not await db.scalar(select(Resource.id).where(Resource.organization_id == org.id, Resource.name == "Cloudflare DNS")):
            r = Resource(organization_id=org.id, kind="service", name="Cloudflare DNS", address="1.1.1.1",
                         tags=["demo"], description="Demo resource (clearly identified demo data)")
            db.add(r)
            await db.flush()
            db.add(Check(organization_id=org.id, resource_id=r.id, name="DNS example.com", type="dns",
                         config={"name": "example.com", "record_type": "A", "nameserver": "1.1.1.1"},
                         interval_seconds=60, timeout_seconds=5, next_run_at=now))
            db.add(Check(organization_id=org.id, resource_id=r.id, name="TCP 53", type="tcp",
                         config={"host": "1.1.1.1", "port": 53}, interval_seconds=60, timeout_seconds=5, next_run_at=now))
    print("Demo organization 'demo' seeded with public targets (tagged 'demo').")


def main() -> None:
    p = argparse.ArgumentParser(prog="python -m app.cli")
    sub = p.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("bootstrap", help="create the first Super Administrator and organization")
    b.add_argument("--email", required=True)
    b.add_argument("--full-name", default="Administrator")
    b.add_argument("--org-name", required=True)
    b.add_argument("--org-slug", required=True)
    u = sub.add_parser("create-user", help="add a user to an organization")
    u.add_argument("--email", required=True)
    u.add_argument("--org-slug", required=True)
    u.add_argument("--role", choices=[r.value for r in Role if r != Role.SUPER_ADMIN], required=True)
    u.add_argument("--full-name", default="")
    sub.add_parser("clickhouse-migrate", help="create/upgrade the ClickHouse schema")
    sub.add_parser("seed-demo", help="create a clearly-labelled demo organization (non-production only)")
    args = p.parse_args()

    async def run() -> None:
        try:
            if args.cmd == "bootstrap":
                await bootstrap(args.email, args.org_name, args.org_slug, args.full_name)
            elif args.cmd == "create-user":
                await create_user(args.email, args.org_slug, args.role, args.full_name)
            elif args.cmd == "clickhouse-migrate":
                await clickhouse_migrate()
            elif args.cmd == "seed-demo":
                await seed_demo()
        finally:
            await dispose_engine()

    asyncio.run(run())


if __name__ == "__main__":
    main()
