"""Table-backed password hashing and session tokens (no Supabase Auth)."""

from __future__ import annotations

import base64
import hashlib
import secrets
from datetime import datetime, timedelta, timezone

import jwt

from fixitnyc.config import get_settings
from fixitnyc.schemas import TokenResponse

ACCESS_TTL = timedelta(hours=12)
REFRESH_TTL = timedelta(days=30)
_SCRYPT_N = 2**14
_SCRYPT_R = 8
_SCRYPT_P = 1
_SCRYPT_DKLEN = 32


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(
        password.encode("utf-8"),
        salt=salt,
        n=_SCRYPT_N,
        r=_SCRYPT_R,
        p=_SCRYPT_P,
        dklen=_SCRYPT_DKLEN,
    )
    return (
        "scrypt$"
        f"{base64.b64encode(salt).decode('ascii')}$"
        f"{base64.b64encode(digest).decode('ascii')}"
    )


def verify_password(password: str, encoded: str) -> bool:
    try:
        algo, salt_b64, hash_b64 = encoded.split("$", 2)
        if algo != "scrypt":
            return False
        salt = base64.b64decode(salt_b64.encode("ascii"))
        expected = base64.b64decode(hash_b64.encode("ascii"))
        digest = hashlib.scrypt(
            password.encode("utf-8"),
            salt=salt,
            n=_SCRYPT_N,
            r=_SCRYPT_R,
            p=_SCRYPT_P,
            dklen=_SCRYPT_DKLEN,
        )
        return secrets.compare_digest(digest, expected)
    except (ValueError, TypeError):
        return False


def _signing_secret() -> str:
    return get_settings().supabase_secret_key


def issue_tokens(user_id: str) -> TokenResponse:
    now = datetime.now(timezone.utc)
    secret = _signing_secret()
    access = jwt.encode(
        {
            "sub": user_id,
            "typ": "access",
            "iat": now,
            "exp": now + ACCESS_TTL,
        },
        secret,
        algorithm="HS256",
    )
    refresh = jwt.encode(
        {
            "sub": user_id,
            "typ": "refresh",
            "iat": now,
            "exp": now + REFRESH_TTL,
        },
        secret,
        algorithm="HS256",
    )
    return TokenResponse(
        access_token=access,
        refresh_token=refresh,
        expires_in=int(ACCESS_TTL.total_seconds()),
    )


def decode_token(token: str, *, expected_type: str) -> str:
    try:
        payload = jwt.decode(token, _signing_secret(), algorithms=["HS256"])
    except jwt.PyJWTError as exc:
        raise ValueError("Invalid or expired token") from exc
    if payload.get("typ") != expected_type:
        raise ValueError("Invalid token type")
    user_id = payload.get("sub")
    if not isinstance(user_id, str) or not user_id:
        raise ValueError("Invalid token subject")
    return user_id
