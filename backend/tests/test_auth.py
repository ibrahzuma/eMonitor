from __future__ import annotations

import pyotp
from sqlalchemy import select

from app.core.db import get_sessionmaker
from app.models import PasswordResetToken, User
from app.services import auth as auth_svc
from tests.conftest import PASSWORD, login, make_actor, make_api_key, make_org, make_user

API = "/api/v1"


async def test_login_success_sets_refresh_and_csrf_cookies(client):
    org = await make_org()
    user = await make_user(org)
    r = await client.post(f"{API}/auth/login", json={"email": user.email.upper(), "password": PASSWORD})
    assert r.status_code == 200
    body = r.json()
    assert body["access_token"] and body["user"]["email"] == user.email
    assert "emonitor_refresh" in r.cookies and "emonitor_csrf" in r.cookies
    me = await client.get(f"{API}/auth/me", headers={"Authorization": f"Bearer {body['access_token']}"})
    assert me.status_code == 200
    assert me.json()["memberships"][0]["role"] == "org_admin"
    assert "users:manage" in me.json()["permissions"][str(org.id)]


async def test_login_wrong_password_generic_error_and_lockout(client):
    user = await make_user(await make_org())
    r = await client.post(f"{API}/auth/login", json={"email": user.email, "password": "nope-nope-nope"})
    assert r.status_code == 401
    assert r.json()["error"]["message"] == "Invalid email or password"
    r = await client.post(f"{API}/auth/login", json={"email": "missing@example.com", "password": "x"})
    assert r.status_code == 401 and r.json()["error"]["message"] == "Invalid email or password"
    # Lock the account after repeated failures (rate limiter allows 10 per window; use service directly)
    async with get_sessionmaker()() as db:
        for _ in range(auth_svc.MAX_FAILED_LOGINS):
            try:
                await auth_svc.check_credentials(db, user.email, "bad-password-x")
            except Exception:
                pass
    r = await client.post(f"{API}/auth/login", json={"email": user.email, "password": PASSWORD})
    assert r.status_code == 401 and "locked" in r.json()["error"]["message"]


async def test_login_rate_limited(client):
    user = await make_user(await make_org())
    codes = [(await client.post(f"{API}/auth/login", json={"email": user.email, "password": "wrong-pass"})).status_code
             for _ in range(11)]
    assert codes[-1] == 429


async def test_refresh_requires_csrf_and_rotates_with_reuse_detection(client):
    user = await make_user(await make_org())
    r = await client.post(f"{API}/auth/login", json={"email": user.email, "password": PASSWORD})
    old_refresh = r.cookies["emonitor_refresh"]
    csrf = r.cookies["emonitor_csrf"]
    # Missing CSRF header → rejected
    assert (await client.post(f"{API}/auth/refresh")).status_code == 403
    r2 = await client.post(f"{API}/auth/refresh", headers={"X-CSRF-Token": csrf})
    assert r2.status_code == 200 and r2.json()["access_token"]
    new_refresh = r2.cookies["emonitor_refresh"]
    assert new_refresh != old_refresh
    # Simulate reuse of the old (rotated) token after the grace period → whole family revoked
    async with get_sessionmaker()() as db:
        from datetime import timedelta

        from app.core.security import sha256_hex
        from app.models import UserSession

        s = await db.scalar(select(UserSession).where(UserSession.refresh_hash == sha256_hex(old_refresh)))
        s.rotated_at = s.rotated_at - timedelta(seconds=60)
        await db.commit()
    client.cookies.set("emonitor_refresh", old_refresh, path="/api/v1/auth")
    r3 = await client.post(f"{API}/auth/refresh", headers={"X-CSRF-Token": client.cookies.get("emonitor_csrf")})
    assert r3.status_code == 401
    client.cookies.set("emonitor_refresh", new_refresh, path="/api/v1/auth")
    r4 = await client.post(f"{API}/auth/refresh", headers={"X-CSRF-Token": client.cookies.get("emonitor_csrf")})
    assert r4.status_code == 401  # the new token died with its family


async def test_access_token_invalid_after_logout(client):
    user = await make_user(await make_org())
    r = await client.post(f"{API}/auth/login", json={"email": user.email, "password": PASSWORD})
    token = r.json()["access_token"]
    out = await client.post(f"{API}/auth/logout", headers={"X-CSRF-Token": r.cookies["emonitor_csrf"]})
    assert out.status_code == 200
    me = await client.get(f"{API}/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert me.status_code == 401


async def test_password_change_and_reset_flow(client):
    a = await make_actor(client)
    bad = await client.post(f"{API}/auth/change-password", headers=a.headers,
                            json={"current_password": PASSWORD, "new_password": "short"})
    assert bad.status_code == 422
    ok = await client.post(f"{API}/auth/change-password", headers=a.headers,
                           json={"current_password": PASSWORD, "new_password": "Brand-New-Pass-99"})
    assert ok.status_code == 200
    assert (await client.post(f"{API}/auth/login", json={"email": a.user.email, "password": "Brand-New-Pass-99"})).status_code == 200

    # Forgot password never reveals whether the account exists
    r1 = await client.post(f"{API}/auth/forgot-password", json={"email": a.user.email})
    r2 = await client.post(f"{API}/auth/forgot-password", json={"email": "nobody@example.com"})
    assert r1.status_code == r2.status_code == 202 and r1.json() == r2.json()
    async with get_sessionmaker()() as db:
        user = await db.get(User, a.user.id)
        token = await auth_svc.create_reset_token(db, user)
        await db.commit()
    r = await client.post(f"{API}/auth/reset-password", json={"token": token, "new_password": "Reset-Password-77"})
    assert r.status_code == 200
    again = await client.post(f"{API}/auth/reset-password", json={"token": token, "new_password": "Reset-Password-78"})
    assert again.status_code == 422  # single use
    async with get_sessionmaker()() as db:
        assert (await db.scalar(select(PasswordResetToken).where(PasswordResetToken.user_id == a.user.id,
                                                                PasswordResetToken.used_at.is_(None)))) is not None
    await login(client, a.user.email, "Reset-Password-77")


async def test_totp_two_factor_flow(client):
    a = await make_actor(client)
    setup = await client.post(f"{API}/auth/2fa/setup", headers=a.headers)
    secret = setup.json()["secret"]
    assert (await client.post(f"{API}/auth/2fa/enable", headers=a.headers, json={"code": "000000"})).status_code == 422
    assert (await client.post(f"{API}/auth/2fa/enable", headers=a.headers,
                              json={"code": pyotp.TOTP(secret).now()})).status_code == 200
    r = await client.post(f"{API}/auth/login", json={"email": a.user.email, "password": PASSWORD})
    assert r.json()["mfa_required"] is True and r.json()["access_token"] is None
    mfa = r.json()["mfa_token"]
    assert (await client.post(f"{API}/auth/login/mfa", json={"mfa_token": mfa, "code": "123456"})).status_code == 401
    ok = await client.post(f"{API}/auth/login/mfa", json={"mfa_token": mfa, "code": pyotp.TOTP(secret).now()})
    assert ok.status_code == 200 and ok.json()["access_token"]


async def test_api_key_authentication_and_scopes(client):
    org = await make_org()
    key = await make_api_key(org, role="it_admin", scopes=["view"])
    r = await client.get(f"{API}/resources", headers={"Authorization": f"Bearer {key}"})
    assert r.status_code == 200
    # Scoped to view only: writes are forbidden even though the role could write
    w = await client.post(f"{API}/websites", headers={"X-API-Key": key}, json={"name": "x", "url": "https://example.com"})
    assert w.status_code == 403
    bad = await client.get(f"{API}/resources", headers={"Authorization": f"Bearer {key[:-2]}xx"})
    assert bad.status_code == 401
    # API key cannot be used for another organization
    other = await make_org()
    x = await client.get(f"{API}/resources", headers={"X-API-Key": key, "X-Organization-ID": str(other.id)})
    assert x.status_code == 403


async def test_api_key_lifecycle_via_api_is_audited(client):
    a = await make_actor(client)
    r = await client.post(f"{API}/api-keys", headers=a.headers, json={"name": "ci", "role": "viewer"})
    assert r.status_code == 201 and r.json()["key"].startswith("emk_")
    key_id = r.json()["id"]
    listed = (await client.get(f"{API}/api-keys", headers=a.headers)).json()
    assert "key" not in listed[0] and listed[0]["prefix"]
    assert (await client.delete(f"{API}/api-keys/{key_id}", headers=a.headers)).status_code == 200
    assert (await client.get(f"{API}/resources", headers={"X-API-Key": r.json()["key"]})).status_code == 401
    audit = (await client.get(f"{API}/audit-logs", headers=a.headers)).json()["items"]
    actions = {x["action"] for x in audit}
    assert {"api_key.created", "api_key.revoked"} <= actions
