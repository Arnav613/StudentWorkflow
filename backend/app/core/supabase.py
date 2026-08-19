"""Service-role access to Postgres, over PostgREST.

The browser talks to Supabase directly and is fenced in by RLS. The sync job
cannot be: it writes rows on behalf of a user who is not driving the request
(the hourly cron in phase 04 has no session at all), and it touches
`google_tokens`, which has no policy granting the client anything.

So this uses the service role key, which bypasses RLS entirely. That makes
every function below responsible for its own `user_id` filter — the database
will no longer catch a missing one. Each query here carries it explicitly.

httpx against PostgREST rather than the supabase-py SDK: this needs six verbs
against five tables, and the SDK's sync client would add a dependency and a
connection pool we would then have to manage inside FastAPI's event loop.
"""

from typing import Any

import httpx

from app.core.config import get_settings


class DbError(RuntimeError):
    pass


class DuplicateKey(DbError):
    """A unique index rejected the write — someone got there first.

    Worth its own type because it is the expected outcome of two syncs racing,
    not a failure. Callers adopt the existing row instead of giving up.
    """


def _client() -> httpx.AsyncClient:
    settings = get_settings()
    if not settings.supabase_url or not settings.supabase_service_role_key:
        raise DbError("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not configured")
    return httpx.AsyncClient(
        base_url=settings.supabase_url.rstrip("/") + "/rest/v1",
        headers={
            "apikey": settings.supabase_service_role_key,
            "Authorization": f"Bearer {settings.supabase_service_role_key}",
            "Content-Type": "application/json",
        },
        timeout=30.0,
    )


async def _request(
    method: str,
    path: str,
    *,
    params: dict[str, Any] | None = None,
    json: Any = None,
    prefer: str | None = None,
) -> list[dict]:
    headers = {"Prefer": prefer} if prefer else None
    async with _client() as http:
        res = await http.request(method, path, params=params, json=json, headers=headers)
    if res.status_code == 409 and '"23505"' in res.text:
        raise DuplicateKey(f"{method} {path} -> {res.text}")
    if res.status_code >= 400:
        raise DbError(f"{method} {path} -> {res.status_code}: {res.text}")
    if not res.content:
        return []
    body = res.json()
    return body if isinstance(body, list) else [body]


async def select(table: str, **filters: str) -> list[dict]:
    params: dict[str, Any] = {"select": "*"}
    params.update(filters)
    return await _request("GET", f"/{table}", params=params)


async def insert(table: str, rows: list[dict] | dict) -> list[dict]:
    return await _request(
        "POST", f"/{table}", json=rows, prefer="return=representation"
    )


async def update(table: str, patch: dict, **filters: str) -> list[dict]:
    return await _request(
        "PATCH", f"/{table}", params=filters, json=patch, prefer="return=representation"
    )


async def delete(table: str, **filters: str) -> None:
    await _request("DELETE", f"/{table}", params=filters)


async def upsert_on(table: str, rows: list[dict] | dict, conflict: str) -> list[dict]:
    """Insert or update, keyed on a unique constraint's columns."""
    return await _request(
        "POST",
        f"/{table}",
        params={"on_conflict": conflict},
        json=rows,
        prefer="resolution=merge-duplicates,return=representation",
    )


def eq(value: str) -> str:
    """PostgREST's filter syntax: `?user_id=eq.<uuid>`."""
    return f"eq.{value}"
