"""Generate a VAPID key pair. Run once, ever.

    python scripts/vapid.py

Prints the two values to set as VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY. There
is no npm dependency and no website involved: the "VAPID key generators" the
web is full of ask you to paste a private key into a stranger's page, and this
is fifteen lines of the cryptography library that is already installed.

Rotating this pair is not a maintenance task, it is a migration. The public
half is embedded in every subscription every browser has already created, and
a push signed by a new key against an old subscription is rejected. If it ever
has to change, `push_subscriptions` has to be truncated and every device
re-enabled by hand.
"""

import base64

from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat


def b64(data: bytes) -> str:
    """base64url without padding — the form the web push ecosystem uses."""
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def main() -> None:
    key = ec.generate_private_key(ec.SECP256R1())

    # The raw 32-byte scalar, not a PEM: this is what every web-push
    # implementation means by "the private key", and what push.py's
    # _load_vapid_private_key reads back.
    private = key.private_numbers().private_value.to_bytes(32, "big")

    # The uncompressed point, 65 bytes starting 0x04. This is what the browser
    # is handed as `applicationServerKey` and what travels in the `k=`
    # parameter of the Authorization header.
    public = key.public_key().public_bytes(Encoding.X962, PublicFormat.UncompressedPoint)

    print("VAPID_PUBLIC_KEY=" + b64(public))
    print("VAPID_PRIVATE_KEY=" + b64(private))


if __name__ == "__main__":
    main()
