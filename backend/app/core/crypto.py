"""Encryption for the one secret we are forced to hold.

A Google refresh token is a long-lived key to a user's coursework. Supabase
hands it over exactly once, right after the OAuth redirect, and then forgets
it — so if we want background sync, we have to keep it. Keeping it in
plaintext in Postgres means a leaked database dump is a leaked mailbox-worth
of student data, so it is encrypted before it ever leaves this process.

Fernet, not raw AES: authenticated, versioned, and impossible to hold wrong.
The key lives only in the environment (TOKEN_ENCRYPTION_KEY), never in the
database — otherwise the ciphertext and its key sit in the same dump.
"""

from functools import lru_cache

from cryptography.fernet import Fernet, InvalidToken

from app.core.config import get_settings


class TokenCryptoError(RuntimeError):
    """Raised when the key is missing or the ciphertext will not open."""


@lru_cache
def _fernet() -> Fernet:
    key = get_settings().token_encryption_key
    if not key:
        raise TokenCryptoError(
            "TOKEN_ENCRYPTION_KEY is not set. Generate one with: "
            "python -c \"from cryptography.fernet import Fernet; "
            "print(Fernet.generate_key().decode())\""
        )
    try:
        return Fernet(key.encode())
    except (ValueError, TypeError) as exc:
        raise TokenCryptoError("TOKEN_ENCRYPTION_KEY is not a valid Fernet key") from exc


def encrypt(plaintext: str) -> str:
    return _fernet().encrypt(plaintext.encode()).decode()


def decrypt(ciphertext: str) -> str:
    try:
        return _fernet().decrypt(ciphertext.encode()).decode()
    except InvalidToken as exc:
        # Almost always means the key was rotated out from under stored rows.
        # Surfaced as reconnect-required rather than a 500: the user can fix
        # it with one click, and we cannot.
        raise TokenCryptoError("Stored token could not be decrypted") from exc
