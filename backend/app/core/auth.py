"""Request authentication.

The frontend talks to Supabase for login and sends us the resulting access
token. We verify it ourselves rather than calling Supabase on every request —
it is a signed JWT, and a network hop per request on a sleeping free-tier dyno
is exactly the latency we cannot afford.

Supabase signs access tokens with a rotating ES256 key pair and publishes the
public half as a JWKS. The token's own header names the key it was signed with,
so verification fetches that key rather than assuming an algorithm. The legacy
HS256 shared secret is still honoured when a token says it was signed that way
— projects created before asymmetric keys use it, and a deployment should not
break on which era its Supabase project comes from.

The domain check is enforced here as well as in the Google consent screen. The
`hd` parameter on the frontend is a convenience for the user, not a security
boundary; a token is only trusted if its verified email claim ends in the
allowed domain.
"""

import logging
from dataclasses import dataclass
from functools import lru_cache

import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jwt import PyJWKClient, PyJWKClientError

from app.core.config import Settings, get_settings

log = logging.getLogger(__name__)

bearer = HTTPBearer(auto_error=False)

# Asymmetric algorithms we accept from the JWKS. Listed explicitly: passing
# whatever the token's header asks for is how you end up accepting `none`.
ASYMMETRIC_ALGORITHMS = ["ES256", "RS256"]


@lru_cache
def _jwks(url: str) -> PyJWKClient:
    """Cached across requests, and re-fetched when it meets an unknown kid.

    Supabase rotates signing keys. Fetching per request would put a network
    hop in front of every call — the exact cost this module exists to avoid —
    and never fetching would break the app on the next rotation.
    """
    return PyJWKClient(url, cache_keys=True, lifespan=600)


@dataclass(frozen=True)
class CurrentUser:
    id: str
    email: str


def get_current_user(
    creds: HTTPAuthorizationCredentials | None = Depends(bearer),
    settings: Settings = Depends(get_settings),
) -> CurrentUser:
    if creds is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing bearer token",
            headers={"WWW-Authenticate": "Bearer"},
        )

    token = creds.credentials
    # Bound before the try: a malformed token fails inside get_unverified_header,
    # and the handler still needs something to report.
    alg = "unknown"

    try:
        # The header decides how to verify, not us — but only among algorithms
        # we chose to allow, and only with a key we fetched ourselves.
        alg = jwt.get_unverified_header(token).get("alg")

        if alg == "HS256":
            if not settings.supabase_jwt_secret:
                raise HTTPException(
                    status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                    detail="SUPABASE_JWT_SECRET is not configured",
                )
            key = settings.supabase_jwt_secret
            algorithms = ["HS256"]
        else:
            key = _jwks(settings.supabase_jwks_url).get_signing_key_from_jwt(token).key
            algorithms = ASYMMETRIC_ALGORITHMS

        claims = jwt.decode(
            token,
            key,
            algorithms=algorithms,
            audience="authenticated",
        )
    except PyJWKClientError as exc:
        # An unknown kid, or the JWKS endpoint being unreachable. Neither is
        # the caller's fault, but neither lets us trust the token.
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=f"Could not verify token signing key: {exc}",
        ) from exc
    except jwt.ExpiredSignatureError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Token expired"
        )
    except jwt.InvalidTokenError as exc:
        # The reason is carried through rather than flattened to "Invalid
        # token". A wrong signing secret, a missing claim and a bad audience
        # are three different misconfigurations with three different fixes,
        # and none of them is guessable from the generic message. Nothing here
        # is sensitive: it describes our own configuration, not the token.
        log.warning("Rejected %s token: %s: %s", alg, type(exc).__name__, exc)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=f"Invalid token ({alg}): {type(exc).__name__}: {exc}",
        ) from exc

    user_id = claims.get("sub")
    email = (claims.get("email") or "").lower()

    if not user_id or not email:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Incomplete token"
        )

    if not email.endswith("@" + settings.allowed_email_domain):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"This dashboard is for @{settings.allowed_email_domain} accounts",
        )

    return CurrentUser(id=user_id, email=email)
