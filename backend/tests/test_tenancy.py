"""Tenant isolation and role-based authorization."""

from __future__ import annotations

import pytest

from tests.conftest import login, make_actor, make_org, make_user

API = "/api/v1"


async def _website(client, actor, name="Site"):
    r = await client.post(f"{API}/websites", headers=actor.headers, json={"name": name, "url": "https://example.com/"})
    assert r.status_code == 201, r.text
    return r.json()


async def test_users_cannot_access_other_organizations(client):
    a = await make_actor(client)
    b = await make_actor(client)
    site = await _website(client, a)
    # B cannot read, modify, or delete A's resource — and gets 404 (no existence disclosure)
    assert (await client.get(f"{API}/resources/{site['id']}", headers=b.headers)).status_code == 404
    assert (await client.patch(f"{API}/resources/{site['id']}", headers=b.headers, json={"name": "pwn"})).status_code == 404
    assert (await client.delete(f"{API}/resources/{site['id']}", headers=b.headers)).status_code == 404
    check_id = site["checks"][0]["id"]
    assert (await client.get(f"{API}/checks/{check_id}/results", headers=b.headers)).status_code == 404
    # Listing shows only own data
    assert (await client.get(f"{API}/resources", headers=b.headers)).json()["total"] == 0
    # B cannot switch into A's organization with the header
    hdr = {**b.headers, "X-Organization-ID": str(a.org.id)}
    assert (await client.get(f"{API}/resources", headers=hdr)).status_code == 404


async def test_cross_tenant_references_are_rejected(client):
    a = await make_actor(client)
    b = await make_actor(client)
    g = await client.post(f"{API}/groups", headers=b.headers, json={"name": "B group"})
    r = await client.post(f"{API}/websites", headers=a.headers,
                          json={"name": "x", "url": "https://example.com", "group_id": g.json()["id"]})
    assert r.status_code == 422
    inc_b = await client.post(f"{API}/incidents", headers=b.headers, json={"title": "B incident"})
    assert (await client.post(f"{API}/incidents/{inc_b.json()['id']}/acknowledge", headers=a.headers)).status_code == 404
    # metrics query for a foreign resource
    site_b = await _website(client, b)
    q = await client.get(f"{API}/metrics/series", headers=a.headers,
                         params={"resource_id": site_b["id"], "metric": "response_time_ms"})
    assert q.status_code == 404


@pytest.mark.parametrize("role,can_write,can_ack,can_manage_users", [
    ("viewer", False, False, False),
    ("operator", False, True, False),
    ("it_admin", True, True, False),
    ("org_admin", True, True, True),
])
async def test_role_permissions_enforced_by_backend(client, role, can_write, can_ack, can_manage_users):
    org = await make_org()
    admin = await make_actor(client, org=org)
    site = await _website(client, admin)
    inc = (await client.post(f"{API}/incidents", headers=admin.headers, json={"title": "Manual"})).json()
    actor = await make_actor(client, role=role, org=org)
    w = await client.post(f"{API}/websites", headers=actor.headers, json={"name": f"n-{role}", "url": "https://example.com"})
    assert (w.status_code == 201) == can_write
    if not can_write:
        assert w.status_code == 403
    ack = await client.post(f"{API}/incidents/{inc['id']}/acknowledge", headers=actor.headers)
    assert (ack.status_code == 200) == can_ack
    u = await client.post(f"{API}/users", headers=actor.headers,
                          json={"email": f"new-{role}@example.com", "role": "viewer", "password": "Some-Password-12"})
    assert (u.status_code == 201) == can_manage_users
    # Everyone can read
    assert (await client.get(f"{API}/resources/{site['id']}", headers=actor.headers)).status_code == 200


async def test_cannot_escalate_roles(client):
    org = await make_org()
    await make_actor(client, org=org)  # keep an org admin around
    # an it_admin cannot manage users at all; an org_admin cannot grant super_admin
    oa = await make_actor(client, role="org_admin", org=org)
    r = await client.post(f"{API}/users", headers=oa.headers,
                          json={"email": "x@example.com", "role": "super_admin", "password": "Some-Password-12"})
    assert r.status_code == 422


async def test_last_org_admin_cannot_be_demoted(client):
    a = await make_actor(client)
    r = await client.patch(f"{API}/users/{a.user.id}", headers=a.headers, json={"role": "viewer"})
    assert r.status_code == 422


async def test_superadmin_can_create_and_enter_organizations(client):
    sa = await make_user(None, superadmin=True)
    token = await login(client, sa.email)
    h = {"Authorization": f"Bearer {token}"}
    r = await client.post(f"{API}/organizations", headers=h, json={"name": "New Co", "slug": "new-co"})
    assert r.status_code == 201
    org_id = r.json()["id"]
    assert (await client.get(f"{API}/resources", headers={**h, "X-Organization-ID": org_id})).status_code == 200
    normal = await make_actor(client)
    assert (await client.post(f"{API}/organizations", headers=normal.headers,
                              json={"name": "X", "slug": "x-co"})).status_code == 403
