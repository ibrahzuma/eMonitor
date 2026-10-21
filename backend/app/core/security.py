"""Password hashing, tokens, JWTs and secret encryption."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

import jwt
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError
from cryptography.fernet import Fernet, InvalidToken

from app.core.config import get_settings

_hasher = PasswordHasher()  # Argon2id with library defaults (RFC 9106 low-memory profile)
_DUMMY_HASH = _hasher.hash("dummy-password-for-timing")

MIN_PASSWORD_LENGTH = 12


def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(password: str, password_hash: str | None) -> bool:
    """Constant-ish time verify; always runs a hash even for unknown users."""
    try:
        return _hasher.verify(password_hash or _DUMMY_HASH, password) and password_hash is not None
    except (VerifyMismatchError, VerificationError, InvalidHashError):
        return False


def password_needs_rehash(password_hash: str) -> bool:
    return _hasher.check_needs_rehash(password_hash)


def validate_password_strength(password: str) -> list[str]:
    problems = []
    if len(password) < MIN_PASSWORD_LENGTH:
        problems.append(f"must be at least {MIN_PASSWORD_LENGTH} characters")
    if password.lower() == password or password.upper() == password:
        problems.append("must mix upper and lower case letters")
    if not any(c.isdigit() for c in password):
        problems.append("must contain a digit")
    return problems


def random_token(nbytes: int = 32) -> str:
    return secrets.token_urlsafe(nbytes)


def sha256_hex(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def constant_time_equals(a: str, b: str) -> bool:
    return hmac.compare_digest(a.encode(), b.encode())


# ----- JWT access tokens ---------------------------------------------------------------------

JWT_ALG = "HS256"


def create_access_token(user_id: uuid.UUID, session_id: uuid.UUID, *, minutes: int | None = None) -> str:
    s = get_settings()
    now = datetime.now(UTC)
    payload = {
        "sub": str(user_id),
        "sid": str(session_id),
        "iat": int(now.timestamp()),
        "exp": int((now + timedelta(minutes=minutes or s.access_token_minutes)).timestamp()),
        "typ": "access",
        "iss": "emonitor",
    }
    return jwt.encode(payload, s.secret_key.get_secret_value(), algorithm=JWT_ALG)


def create_mfa_token(user_id: uuid.UUID) -> str:
    """Short-lived token proving the password step succeeded; exchanged with a TOTP code."""
    s = get_settings()
    now = datetime.now(UTC)
    payload = {"sub": str(user_id), "typ": "mfa", "iat": int(now.timestamp()), "exp": int((now + timedelta(minutes=5)).timestamp()), "iss": "emonitor"}
    return jwt.encode(payload, s.secret_key.get_secret_value(), algorithm=JWT_ALG)


def decode_token(token: str, expected_type: str) -> dict[str, Any] | None:
    s = get_settings()
    try:
        payload = jwt.decode(
            token,
            s.secret_key.get_secret_value(),
            algorithms=[JWT_ALG],
            issuer="emonitor",
            options={"require": ["exp", "sub", "typ"]},
        )
    except jwt.PyJWTError:
        return None
    if payload.get("typ") != expected_type:
        return None
    return payload


# ----- API keys / agent credentials ----------------------------------------------------------

API_KEY_PREFIX = "emk"


def generate_api_key() -> tuple[str, str, str]:
    """Return (full_key, prefix, secret_hash). Only the hash is stored."""
    prefix = secrets.token_hex(6)
    secret = secrets.token_urlsafe(32)
    return f"{API_KEY_PREFIX}_{prefix}_{secret}", prefix, sha256_hex(secret)


def parse_api_key(key: str) -> tuple[str, str] | None:
    parts = key.split("_", 2)
    if len(parts) != 3 or parts[0] != API_KEY_PREFIX or not parts[1] or not parts[2]:
        return None
    return parts[1], parts[2]


# ----- Encryption of stored secrets ----------------------------------------------------------


def _fernet() -> Fernet:
    s = get_settings()
    key = s.encryption_key.get_secret_value()
    if not key:
        if s.is_production:
            raise RuntimeError("EMONITOR_ENCRYPTION_KEY is required in production")
        # Development/test only: derive a stable key from SECRET_KEY.
        digest = hashlib.sha256(("enc:" + s.secret_key.get_secret_value()).encode()).digest()
        key = base64.urlsafe_b64encode(digest).decode()
    return Fernet(key.encode() if isinstance(key, str) else key)


def encrypt_json(data: dict[str, Any]) -> str:
    return _fernet().encrypt(json.dumps(data, separators=(",", ":")).encode()).decode()


def decrypt_json(token: str | None) -> dict[str, Any]:
    if not token:
        return {}
    try:
        return json.loads(_fernet().decrypt(token.encode()))
    except (InvalidToken, ValueError) as exc:
        raise RuntimeError("Unable to decrypt stored secret (wrong EMONITOR_ENCRYPTION_KEY?)") from exc


def encrypt_str(value: str) -> str:
    return _fernet().encrypt(value.encode()).decode()


def decrypt_str(token: str) -> str:
    return _fernet().decrypt(token.encode()).decode()
