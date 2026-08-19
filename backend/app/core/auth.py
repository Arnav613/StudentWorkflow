"""Request authentication.

The frontend talks to Supabase for login and sends us the resulting access
token. We verify it ourselves rather than calling Supabase on every request —
it is a signed JWT, and a network hop per request on a sleeping free-tier dyno
is exactly the latency we cannot afford.

The domain check is enforced here as well as in the Google consent screen. The
`hd` parameter on the frontend is a convenience for the user, not a security
boundary; a token is only trusted if its verified email claim ends in the
allowed domain.
"""

from dataclasses import dataclass

import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.core.config import Settings, get_settings

bearer = HTTPBearer(auto_error=False)


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

    try:
        claims = jwt.decode(
            creds.credentials,
            settings.supabase_jwt_secret,
            algorithms=["HS256"],
            audience="authenticated",
        )
    except jwt.ExpiredSignatureError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Token expired"
        )
    except jwt.InvalidTokenError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token"
        )

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
