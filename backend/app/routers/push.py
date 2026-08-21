"""Push subscriptions, and the cron that turns them into a morning.

Four routes. Three belong to a signed-in browser managing its own device; the
fourth is the hourly job, authenticated by the same shared secret as
`/classroom/cron/sync` and for the same reason — the caller is a workflow with
no session to present.

Why the browser goes through here at all, when every other write in this app
goes straight to Supabase: `push_subscriptions` has RLS on and no policy, so
the anon key sees nothing. That is deliberate and the migration argues it in
full. The cost is one cold start the first time a person enables reminders,
which is acceptable for a once-per-device action behind a permission prompt,
and would not be for anything on the path of ordinary use.
"""

from __future__ import annotations

import logging
import secrets

from fastapi import APIRouter, Depends, Header, HTTPException, status
from pydantic import BaseModel, Field

from app.core import supabase as db
from app.core.auth import CurrentUser, get_current_user
from app.core.config import Settings, get_settings
from app.services import digest

log = logging.getLogger(__name__)

router = APIRouter(prefix="/push")


def _require_enabled(settings: Settings = Depends(get_settings)) -> Settings:
    """503 rather than a confusing failure deeper in.

    The frontend reads `push_enabled` from /config and hides the reminders
    control entirely when it is false, so reaching this is either a stale tab
    or somebody poking the API directly. Both deserve a straight answer.
    """
    if not settings.push_ready:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Push is not configured on this deployment",
        )
    return settings


class Subscription(BaseModel):
    """What `PushManager.subscribe()` hands back, flattened.

    The browser's own object nests the keys under `keys`; the frontend
    unpacks it before posting so this stays one flat row that maps to the
    table without a translation step in the middle.
    """

    endpoint: str = Field(min_length=1, max_length=2000)
    p256dh: str = Field(min_length=1, max_length=200)
    auth: str = Field(min_length=1, max_length=100)
    # IANA name from the browser. Validated by use rather than by a regex —
    # `digest._zone` falls back to Asia/Kolkata for anything Python's tzdata
    # does not recognise, which is a better outcome than refusing to
    # subscribe a device over the spelling of a timezone.
    timezone: str = Field(default="Asia/Kolkata", max_length=64)


@router.get("/key")
def public_key(settings: Settings = Depends(_require_enabled)) -> dict:
    """The VAPID public key, which the browser needs *before* it can subscribe.

    Public by design — it travels in every push request and identifies the
    server, not the user. It is served rather than baked into the frontend
    bundle so that the key pair lives in exactly one place: rotating it should
    not require a frontend redeploy to stay consistent, and a build-time
    VITE_ variable that drifted from the server's key would produce
    subscriptions that fail only at send time, months later.
    """
    return {"key": settings.vapid_public_key}


@router.post("/subscribe")
async def subscribe(
    sub: Subscription,
    user: CurrentUser = Depends(get_current_user),
    _: Settings = Depends(_require_enabled),
) -> dict:
    """Register this device, or re-point an existing row at this user.

    Upsert on `endpoint`, not on (user, endpoint). A browser reuses its
    endpoint across sign-outs, so a shared laptop that signs out of one
    account and into another must move the row rather than gain a second one —
    otherwise the first account's deadlines keep arriving on a device that now
    belongs to someone else.
    """
    row = {
        "user_id": user.id,
        "endpoint": sub.endpoint,
        "p256dh": sub.p256dh,
        "auth": sub.auth,
        "timezone": sub.timezone,
        "digest": True,
        # A re-subscribe is the fix for a device that was failing, so the old
        # complaint should not outlive it.
        "last_error": None,
    }
    try:
        await db.upsert_on("push_subscriptions", row, conflict="endpoint")
    except db.DbError as e:
        log.exception("Could not store a push subscription")
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Could not save the subscription: {e}",
        ) from e
    return {"subscribed": True}


@router.post("/unsubscribe")
async def unsubscribe(
    sub: Subscription,
    user: CurrentUser = Depends(get_current_user),
    _: Settings = Depends(_require_enabled),
) -> dict:
    """Forget this device.

    Filtered on the user as well as the endpoint even though the endpoint is
    unique: this runs with the service role, which means RLS is not going to
    catch a missing `user_id` filter — the rule stated at the top of
    core/supabase.py. Turning off notifications must not be a way to unsubscribe
    somebody else's phone by knowing its URL.
    """
    try:
        await db.delete(
            "push_subscriptions",
            user_id=db.eq(user.id),
            endpoint=db.eq(sub.endpoint),
        )
    except db.DbError as e:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Could not remove the subscription: {e}",
        ) from e
    return {"subscribed": False}


@router.post("/test")
async def test(
    user: CurrentUser = Depends(get_current_user),
    _: Settings = Depends(_require_enabled),
) -> dict:
    """Send this user their digest now, whatever the hour.

    The whole point of the button this backs: a permission prompt granted at
    four in the afternoon gives no evidence that anything works, and the next
    real chance to find out is tomorrow morning — by which time the person has
    stopped thinking about it. This runs the real path, encryption and all, so
    a success here means the 8am one will land too.

    It sends the real digest rather than "Hello from the dashboard", so the
    answer includes whether the content is any good.
    """
    try:
        report = await digest.run(force_user=user.id)
    except db.DbError as e:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Could not send a test: {e}",
        ) from e
    return report.as_dict()


@router.post("/cron/digest")
async def cron_digest(
    x_cron_secret: str = Header(default=""),
    settings: Settings = Depends(_require_enabled),
) -> dict:
    """The hourly tick. Each subscription decides if it is its morning.

    Hourly rather than daily because the hour that matters is local to the
    device — see services/digest. Twenty-three of the twenty-four runs do
    almost nothing: one query, and a comparison per row.

    `compare_digest` rather than `==`, exactly as in the Classroom cron: the
    comparison is against a secret, and a naive one leaks it a byte at a time.
    """
    if not settings.cron_secret:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="CRON_SECRET is not configured; the cron route is disabled",
        )
    if not secrets.compare_digest(x_cron_secret, settings.cron_secret):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Bad cron secret"
        )

    try:
        report = await digest.run()
    except db.DbError as e:
        # The per-device failures are already collected into the report; this
        # is the one that ends the run — the subscriptions table itself being
        # unreadable. A bare 500 would reach the workflow as "Internal Server
        # Error", and the workflow's --fail-with-body exists precisely so the
        # reason travels with the failure.
        log.exception("The digest run could not read its subscriptions")
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"The digest run failed: {e}",
        ) from e
    return report.as_dict()
