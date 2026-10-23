"""Autenticación de usuario único para DockPilot.

El usuario y el secreto de sesión viven en DATA_DIR (por defecto /data),
que debe estar montado como volumen para sobrevivir a los rebuilds.
"""
import base64
import hashlib
import hmac
import json
import os
import secrets
import time

import bcrypt
from fastapi import HTTPException, Request

DATA_DIR = os.environ.get("DATA_DIR", "/data")
USERS_FILE = os.path.join(DATA_DIR, "users.json")
SECRET_FILE = os.path.join(DATA_DIR, "session.key")

COOKIE_NAME = "dockpilot_session"
SESSION_TTL = 7 * 24 * 3600
DEFAULT_USERNAME = "admin"
DEFAULT_PASSWORD = "123"

LOGIN_MAX_ATTEMPTS = 5
LOGIN_WINDOW = 300

_attempts: dict[str, list[float]] = {}


# ── almacenamiento ──────────────────────────────────────────

def _ensure_data_dir() -> None:
    os.makedirs(DATA_DIR, exist_ok=True)


def _read_json(path: str, default):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def _write_private_json(path: str, data) -> None:
    _ensure_data_dir()
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f)
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def verify_password(password: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(password.encode("utf-8"), hashed.encode("utf-8"))
    except (ValueError, TypeError):
        return False


def load_user() -> dict | None:
    data = _read_json(USERS_FILE, None)
    if not isinstance(data, dict) or "username" not in data or "password_hash" not in data:
        return None
    return data


def save_user(username: str, password: str) -> None:
    _write_private_json(
        USERS_FILE,
        {"username": username, "password_hash": hash_password(password)},
    )


def ensure_default_user() -> None:
    """Crea admin/123 solo la primera vez (cuando no existe users.json)."""
    if load_user() is None:
        save_user(DEFAULT_USERNAME, DEFAULT_PASSWORD)


def is_default_password(user: dict) -> bool:
    return verify_password(DEFAULT_PASSWORD, user["password_hash"])


# ── sesión firmada (HMAC) ───────────────────────────────────

def _secret() -> bytes:
    try:
        with open(SECRET_FILE, "rb") as f:
            key = f.read()
            if len(key) >= 32:
                return key
    except FileNotFoundError:
        pass
    key = secrets.token_bytes(32)
    _ensure_data_dir()
    with open(SECRET_FILE, "wb") as f:
        f.write(key)
    os.chmod(SECRET_FILE, 0o600)
    return key


def _b64(data: bytes) -> bytes:
    return base64.urlsafe_b64encode(data).rstrip(b"=")


def _unb64(data: bytes) -> bytes:
    return base64.urlsafe_b64decode(data + b"=" * (-len(data) % 4))


def create_token(username: str) -> str:
    payload = _b64(f"{username}|{int(time.time()) + SESSION_TTL}".encode())
    sig = _b64(hmac.new(_secret(), payload, hashlib.sha256).digest())
    return (payload + b"." + sig).decode()


def verify_token(token: str | None) -> str | None:
    if not token:
        return None
    try:
        payload, sig = token.encode("utf-8").split(b".", 1)
        expected = _b64(hmac.new(_secret(), payload, hashlib.sha256).digest())
        if not hmac.compare_digest(sig, expected):
            return None
        username, exp = _unb64(payload).decode("utf-8").split("|", 1)
        if int(exp) < time.time():
            return None
        return username
    except (ValueError, UnicodeDecodeError):
        return None


def set_session_cookie(response, request: Request, username: str) -> None:
    response.set_cookie(
        COOKIE_NAME,
        create_token(username),
        max_age=SESSION_TTL,
        httponly=True,
        samesite="lax",
        secure=request.url.scheme == "https",
        path="/",
    )


async def require_auth(request: Request) -> str:
    """Dependencia de FastAPI: exige sesión válida en todas las rutas de datos."""
    username = verify_token(request.cookies.get(COOKIE_NAME))
    user = load_user()
    if not username or user is None or username != user["username"]:
        raise HTTPException(status_code=401, detail="No autenticado")
    return username


# ── rate limit del login (en memoria) ───────────────────────

def check_login_rate(ip: str) -> None:
    now = time.time()
    recent = [t for t in _attempts.get(ip, []) if now - t < LOGIN_WINDOW]
    _attempts[ip] = recent
    if len(recent) >= LOGIN_MAX_ATTEMPTS:
        raise HTTPException(
            status_code=429,
            detail="Demasiados intentos fallidos. Espera unos minutos.",
        )


def register_login_failure(ip: str) -> None:
    _attempts.setdefault(ip, []).append(time.time())


def clear_login_failures(ip: str) -> None:
    _attempts.pop(ip, None)
