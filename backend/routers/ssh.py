import logging
import os
import re
import shlex

import paramiko
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from routers import ssh_servers

router = APIRouter()
log = logging.getLogger("dockpilot.ssh")

DATA_DIR = os.environ.get("DATA_DIR", "/data")
KNOWN_HOSTS = os.path.join(DATA_DIR, "known_hosts")

CONTAINER_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$")
ACTIONS = {"start", "stop", "restart"}


class SaveHostKeyPolicy(paramiko.MissingHostKeyPolicy):
    """TOFU: guarda la huella la primera vez. Si cambia después, paramiko
    lanza BadHostKeyException y se avisa en vez de aceptarla."""

    def missing_host_key(self, client, hostname, key):
        hostkeys = paramiko.HostKeys()
        if os.path.exists(KNOWN_HOSTS):
            try:
                hostkeys.load(KNOWN_HOSTS)
            except Exception:
                pass
        hostkeys.add(hostname, key.get_name(), key)
        os.makedirs(DATA_DIR, exist_ok=True)
        hostkeys.save(KNOWN_HOSTS)
        os.chmod(KNOWN_HOSTS, 0o600)


class ServerRef(BaseModel):
    server_id: str


class ContainerRef(ServerRef):
    container_id: str


def _server_or_404(server_id: str) -> dict:
    server = ssh_servers.get_server(server_id)
    if not server:
        raise HTTPException(status_code=404, detail="Servidor no encontrado")
    return server


def _valid_container_id(container_id: str) -> str:
    if not container_id or not CONTAINER_ID_RE.match(container_id):
        raise HTTPException(status_code=400, detail="ID de contenedor inválido")
    return container_id


def _connect(server: dict) -> paramiko.SSHClient:
    client = paramiko.SSHClient()
    if os.path.exists(KNOWN_HOSTS):
        client.load_host_keys(KNOWN_HOSTS)
    client.set_missing_host_key_policy(SaveHostKeyPolicy())
    client.connect(
        server["host"],
        port=server["port"],
        username=server["username"],
        password=server["password"],
        timeout=8,
        banner_timeout=8,
        auth_timeout=8,
        look_for_keys=False,
        allow_agent=False,
    )
    return client


def _fail(action: str, exc: Exception):
    """Log interno con detalle, mensaje corto al cliente."""
    log.warning("SSH %s: %s: %s", action, type(exc).__name__, exc)

    if isinstance(exc, paramiko.AuthenticationException):
        # 502, no 401: el 401 está reservado para la sesión de DockPilot.
        raise HTTPException(status_code=502, detail="El servidor rechazó las credenciales SSH (usuario o contraseña incorrectos)")

    msg = str(exc)
    if "not found in known_hosts" in msg or "Bad host key" in msg:
        raise HTTPException(
            status_code=502,
            detail="La huella del servidor no coincide con la guardada. "
                   "Si reinstalaste el servidor, borra /data/known_hosts dentro del contenedor.",
        )
    if "timed out" in msg.lower() or isinstance(exc, TimeoutError):
        raise HTTPException(status_code=504, detail="Tiempo de espera agotado conectando por SSH")

    raise HTTPException(status_code=502, detail="No se pudo conectar al servidor remoto")


def _run(server: dict, command: str, timeout: int = 15):
    client = _connect(server)
    try:
        _, stdout, _ = client.exec_command(command, timeout=timeout)
        return stdout.read().decode("utf-8", "replace")
    finally:
        client.close()


@router.post("/containers")
def list_ssh_containers(ref: ServerRef):
    server = _server_or_404(ref.server_id)
    try:
        output = _run(
            server,
            "docker ps -a --format '{{.ID}}|{{.Names}}|{{.Status}}|{{.Image}}'",
        )
    except HTTPException:
        raise
    except Exception as e:
        _fail("list", e)

    containers = []
    for line in output.strip().splitlines():
        parts = line.split("|")
        if len(parts) == 4:
            containers.append({
                "id": parts[0],
                "name": parts[1],
                "status": parts[2],
                "image": parts[3],
            })
    return containers


# Debe ir antes que /containers/{action}
@router.post("/containers/logs")
def logs_ssh_container(ref: ContainerRef):
    server = _server_or_404(ref.server_id)
    container_id = _valid_container_id(ref.container_id)
    try:
        logs = _run(server, f"docker logs --tail 100 {shlex.quote(container_id)}", timeout=20)
    except HTTPException:
        raise
    except Exception as e:
        _fail("logs", e)
    return {"logs": logs}


@router.post("/containers/{action}")
def ssh_container_action(action: str, ref: ContainerRef):
    if action not in ACTIONS:
        raise HTTPException(status_code=404, detail="Acción no válida")
    server = _server_or_404(ref.server_id)
    container_id = _valid_container_id(ref.container_id)

    try:
        _run(server, f"docker {action} {shlex.quote(container_id)}", timeout=30)
    except HTTPException:
        raise
    except Exception as e:
        _fail(action, e)

    return {"message": f"Contenedor {container_id} {action}"}


@router.post("/metrics")
def get_ssh_metrics(ref: ServerRef):
    server = _server_or_404(ref.server_id)

    commands = {
        "cpu":  "top -bn1 | grep 'Cpu(s)' | awk '{print $2}'",
        "ram":  "free -b | awk '/Mem:/{print $2\"|\"$3}'",
        "disk": "df -B1 / | awk 'NR==2{print $2\"|\"$3}'",
        "temp": "cat /sys/class/thermal/thermal_zone0/temp 2>/dev/null || echo ''",
    }

    try:
        client = _connect(server)
        try:
            results = {}
            for key, cmd in commands.items():
                _, stdout, _ = client.exec_command(cmd, timeout=10)
                results[key] = stdout.read().decode("utf-8", "replace").strip()
        finally:
            client.close()
    except HTTPException:
        raise
    except Exception as e:
        _fail("metrics", e)

    try:
        cpu = round(float(results["cpu"].replace(",", ".")), 1)
    except Exception:
        cpu = 0.0

    try:
        total_ram, used_ram = (int(x) for x in results["ram"].split("|"))
        ram = {
            "total_gb": round(total_ram / 1e9, 1),
            "used_gb":  round(used_ram / 1e9, 1),
            "percent":  round(used_ram / total_ram * 100, 1) if total_ram else 0,
        }
    except Exception:
        ram = {"total_gb": 0, "used_gb": 0, "percent": 0}

    try:
        total_disk, used_disk = (int(x) for x in results["disk"].split("|"))
        disk = {
            "total_gb": round(total_disk / 1e9, 1),
            "used_gb":  round(used_disk / 1e9, 1),
            "percent":  round(used_disk / total_disk * 100, 1) if total_disk else 0,
        }
    except Exception:
        disk = {"total_gb": 0, "used_gb": 0, "percent": 0}

    temp = None
    try:
        if results["temp"]:
            temp = round(int(results["temp"]) / 1000, 1)
    except Exception:
        pass

    return {"cpu": cpu, "ram": ram, "disk": disk, "temperature": temp}
