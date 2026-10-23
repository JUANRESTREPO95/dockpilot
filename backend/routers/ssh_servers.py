"""Almacenamiento cifrado de servidores SSH.

Los datos viven en DATA_DIR/servers.json y la contraseña de cada servidor
se cifra con Fernet (clave en DATA_DIR/servers.key, generada sola).
El navegador nunca recibe la contraseña.
"""
import json
import os
import re
import uuid

from cryptography.fernet import Fernet, InvalidToken

DATA_DIR = os.environ.get("DATA_DIR", "/data")
SERVERS_FILE = os.path.join(DATA_DIR, "servers.json")
KEY_FILE = os.path.join(DATA_DIR, "servers.key")

NAME_RE = re.compile(r"^.{1,64}$")
HOST_RE = re.compile(r"^[A-Za-z0-9]([A-Za-z0-9._-]{0,251}[A-Za-z0-9])?$")
USER_RE = re.compile(r"^[A-Za-z0-9._@-]{1,64}$")

PUBLIC_FIELDS = ("id", "name", "host", "port", "username")


def _ensure_dir() -> None:
    os.makedirs(DATA_DIR, exist_ok=True)


def _fernet() -> Fernet:
    _ensure_dir()
    if not os.path.exists(KEY_FILE):
        fd = os.open(KEY_FILE, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as f:
            f.write(Fernet.generate_key())
    with open(KEY_FILE, "rb") as f:
        return Fernet(f.read().strip())


def _load_raw() -> list:
    try:
        with open(SERVERS_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, list) else []
    except (FileNotFoundError, json.JSONDecodeError):
        return []


def _save_raw(servers: list) -> None:
    _ensure_dir()
    tmp = SERVERS_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(servers, f)
    os.chmod(tmp, 0o600)
    os.replace(tmp, SERVERS_FILE)


def validate_server(name: str, host: str, port: int, username: str, password: str | None = None) -> None:
    if not name or not NAME_RE.match(name):
        raise ValueError("Nombre inválido (1-64 caracteres)")
    if not host or not HOST_RE.match(host):
        raise ValueError("Host inválido")
    if host.startswith("169.254."):
        raise ValueError("Host no permitido (link-local)")
    if not isinstance(port, int) or not 1 <= port <= 65535:
        raise ValueError("Puerto inválido (1-65535)")
    if not username or not USER_RE.match(username):
        raise ValueError("Usuario inválido")
    if password is not None and not password:
        raise ValueError("Contraseña requerida")


def list_servers() -> list:
    return [{k: s[k] for k in PUBLIC_FIELDS} for s in _load_raw() if all(k in s for k in PUBLIC_FIELDS)]


def get_server(server_id: str) -> dict | None:
    """Devuelve el servidor con la contraseña descifrada. Solo uso interno."""
    for s in _load_raw():
        if s.get("id") == server_id:
            try:
                password = _fernet().decrypt(s["password"].encode()).decode()
            except (InvalidToken, KeyError, ValueError):
                return None
            return {
                "id": s["id"],
                "name": s["name"],
                "host": s["host"],
                "port": s["port"],
                "username": s["username"],
                "password": password,
            }
    return None


def add_server(name: str, host: str, port: int, username: str, password: str) -> dict:
    validate_server(name, host, port, username, password)
    servers = _load_raw()
    new = {
        "id": f"ssh-{uuid.uuid4().hex[:12]}",
        "name": name,
        "host": host,
        "port": port,
        "username": username,
        "password": _fernet().encrypt(password.encode()).decode(),
    }
    servers.append(new)
    _save_raw(servers)
    return {k: new[k] for k in PUBLIC_FIELDS}


def delete_server(server_id: str) -> bool:
    servers = _load_raw()
    remaining = [s for s in servers if s.get("id") != server_id]
    if len(remaining) == len(servers):
        return False
    _save_raw(remaining)
    return True
