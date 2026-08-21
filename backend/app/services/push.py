"""Web Push — encrypting a payload and handing it to a push service.

No SDK. `pywebpush` is the obvious dependency and it was the first thing
tried; it was dropped because it brings `requests` *and* `aiohttp` along for
what is, underneath, one HTTP POST. A sync client inside FastAPI's event loop
would then need a thread per send, and two HTTP stacks on a 512 MB free dyno
is a real cost for no capability. This is the same judgement `core/supabase.py`
already made about supabase-py, and this module makes it against the same
measure: httpx, which is already here.

What is *not* hand-rolled is the encryption. `http_ece` implements RFC 8188
and RFC 8291 and is the library pywebpush itself wraps — a content-encoding
bug here does not raise, it silently produces ciphertext no phone can open.
The VAPID half is a signed JWT, which pyjwt already does.

The shape of a send, for anyone reading this cold:

  1. The browser gave us an endpoint URL, its public key (`p256dh`) and a
     16-byte `auth` secret. Those came from the push service — Mozilla's,
     Google's, Apple's — that the browser chose. We do not get to pick.
  2. The payload is encrypted to that public key with an ephemeral key pair we
     generate per message. The push service relays bytes it cannot read.
  3. VAPID is how the push service knows *we* are a consistent sender: a JWT
     signed with our long-lived private key, audience set to the push
     service's own origin. It identifies the application server, not the user.
"""

from __future__ import annotations

import base64
import logging
import time
from dataclasses import dataclass
from urllib.parse import urlparse

import http_ece
import httpx
import jwt
from cryptography.hazmat.primitives.asymmetric import ec

from app.core.config import get_settings

log = logging.getLogger(__name__)


class PushError(RuntimeError):
    pass


@dataclass(frozen=True)
class Gone:
    """The push service says this subscription no longer exists.

    A 404 or 410 is the documented way a subscription expires — the app was
    uninstalled, the browser data was cleared, the token rotated. It is not a
    failure to retry or to alarm anyone about; it means delete the row. Worth
    its own type for the same reason `DuplicateKey` is in core/supabase.
    """

    reason: str


def _b64decode(value: str) -> bytes:
    """base64url, with the padding the web omits and Python insists on."""
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def _load_vapid_private_key(raw: str) -> ec.EllipticCurvePrivateKey:
    """The 32-byte base64url private key every VAPID generator emits.

    Not a PEM. The web-push ecosystem settled on the raw scalar, so this
    reconstructs the key object from it rather than asking the deployer to
    convert a format they were never given.
    """
    data = _b64decode(raw)
    if len(data) != 32:
        raise PushError(
            f"VAPID_PRIVATE_KEY should decode to 32 bytes, got {len(data)}. "
            "It is the base64url private key, not a PEM and not the public half."
        )
    return ec.derive_private_key(int.from_bytes(data, "big"), ec.SECP256R1())


def _vapid_headers(endpoint: str) -> dict[str, str]:
    """The Authorization header proving who is sending.

    The audience is the *origin* of the endpoint and nothing more — including
    the path makes Google reject the token, and it is the single most common
    reason a first attempt at web push comes back 401.

    Twelve hours rather than the 24 the spec allows as a maximum: services
    reject anything longer, and clock skew on a free dyno is real.
    """
    settings = get_settings()
    origin = urlparse(endpoint)
    claims = {
        "aud": f"{origin.scheme}://{origin.netloc}",
        "exp": int(time.time()) + 12 * 60 * 60,
        "sub": settings.vapid_subject,
    }
    token = jwt.encode(claims, _load_vapid_private_key(settings.vapid_private_key), algorithm="ES256")
    return {"Authorization": f"vapid t={token}, k={settings.vapid_public_key}"}


def _encrypt(payload: bytes, p256dh: str, auth: str) -> bytes:
    """RFC 8291 aes128gcm, keyed to one device.

    The ephemeral key pair is generated per message and thrown away; its
    public half travels in the ciphertext header, which is why `keyid` is left
    for http_ece to fill in rather than passed.
    """
    return http_ece.encrypt(
        payload,
        private_key=ec.generate_private_key(ec.SECP256R1()),
        dh=_b64decode(p256dh),
        auth_secret=_b64decode(auth),
        version="aes128gcm",
    )


async def send(
    *,
    endpoint: str,
    p256dh: str,
    auth: str,
    payload: bytes,
    ttl: int = 12 * 60 * 60,
) -> Gone | None:
    """One notification to one device. Returns `Gone` if the row should go.

    TTL is twelve hours, not the default four weeks: this carries a morning
    digest, and a phone that was off until Thursday should not be handed
    Tuesday's list the moment it wakes. If it could not be delivered while it
    was true, it should expire.

    Raises PushError for anything else — a 4xx worth reading, a network
    failure — so the caller can record it against the subscription instead of
    the whole run failing on one dead device.
    """
    settings = get_settings()
    if not settings.push_ready:
        raise PushError("Push is not configured (PUSH_ENABLED and both VAPID keys)")

    headers = {
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        "TTL": str(ttl),
        # Wake the screen. The default, "normal", lets a phone in doze hold
        # the message until something else wakes it — which for an 8am digest
        # can mean it arrives at lunch.
        "Urgency": "normal",
        **_vapid_headers(endpoint),
    }

    try:
        async with httpx.AsyncClient(timeout=15.0) as http:
            res = await http.post(endpoint, content=_encrypt(payload, p256dh, auth), headers=headers)
    except httpx.HTTPError as e:
        raise PushError(f"Could not reach the push service: {e}") from e

    if res.status_code in (404, 410):
        return Gone(f"{res.status_code} from the push service")
    if res.status_code >= 400:
        # The body is the diagnosis — Google in particular explains a bad
        # VAPID token in plain English and says nothing useful in the status.
        raise PushError(f"Push failed: {res.status_code} {res.text[:200]}")
    return None
