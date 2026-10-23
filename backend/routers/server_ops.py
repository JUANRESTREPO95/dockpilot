"""Acciones de sistema sobre servidores SSH: reiniciar y actualizar paquetes.

Solo acciones fijas (sin comandos libres del cliente). Las que necesitan root
usan sudo -S con la contraseña guardada del servidor, o se ejecutan directas
si el usuario es root.
"""
import base64
import shlex

from fastapi import APIRouter, HTTPException

from routers import ssh_servers
from routers.ssh import _connect, _fail

router = APIRouter()

APT_SCRIPT = """#!/bin/sh
export DEBIAN_FRONTEND=noninteractive
apt-get update
rc=$?
if [ "$rc" -eq 0 ]; then
  apt-get -y -o Dpkg::Options::="--force-confdef" -o Dpkg::Options::="--force-confold" upgrade
  rc=$?
fi
echo "$rc" > /tmp/dockpilot-apt.exit
rm -f /tmp/dockpilot-apt.pid
"""

SUDO_ERRORS = (
    "incorrect password",
    "a password is required",
    "a terminal is required",
    "no tty present",
    "not in the sudoers",
    "is not allowed to execute",
)


def _server_or_404(server_id: str) -> dict:
    server = ssh_servers.get_server(server_id)
    if not server:
        raise HTTPException(status_code=404, detail="Servidor no encontrado")
    return server


def _run_priv(server: dict, command: str, timeout: int = 20, use_sudo: bool = True):
    """Ejecuta un comando; con sudo si el usuario no es root."""
    feed_password = False
    if use_sudo and server["username"] != "root":
        command = "sudo -S -p '' sh -c " + shlex.quote(command)
        feed_password = True

    client = _connect(server)
    try:
        stdin, stdout, stderr = client.exec_command(command, timeout=timeout)
        if feed_password:
            stdin.write(server["password"] + "\n")
            stdin.flush()
            stdin.channel.shutdown_write()
        out = stdout.read().decode("utf-8", "replace")
        err = stderr.read().decode("utf-8", "replace")
        rc = stdout.channel.recv_exit_status()
    finally:
        client.close()

    lowered = err.lower()
    if any(token in lowered for token in SUDO_ERRORS):
        raise HTTPException(
            status_code=403,
            detail="El usuario SSH no puede usar sudo (contraseña incorrecta o sin permisos)",
        )
    return rc, out, err


def _apt_state(server: dict) -> str:
    # Se usa un pidfile, no pgrep: un `pgrep -f` se encontraba a sí mismo
    # porque el propio comando contiene el nombre del script.
    cmd = (
        "if [ -f /tmp/dockpilot-apt.exit ]; then echo EXIT:$(cat /tmp/dockpilot-apt.exit); "
        "elif [ -f /tmp/dockpilot-apt.pid ] && [ -d /proc/$(cat /tmp/dockpilot-apt.pid 2>/dev/null) ]; "
        "then echo RUNNING; "
        "else echo IDLE; fi"
    )
    _, out, _ = _run_priv(server, cmd, timeout=15, use_sudo=False)
    line = out.strip().splitlines()[-1] if out.strip() else "IDLE"
    return line


def _apt_log(server: dict) -> str:
    _, out, _ = _run_priv(
        server, "tail -c 30000 /tmp/dockpilot-apt.log 2>/dev/null", timeout=15, use_sudo=False
    )
    return out


@router.post("/{server_id}/reboot")
def reboot_server(server_id: str):
    server = _server_or_404(server_id)
    try:
        rc, _, err = _run_priv(server, "systemctl reboot --no-block", timeout=15)
    except HTTPException:
        raise
    except Exception as e:
        _fail("reboot", e)

    if rc != 0:
        raise HTTPException(
            status_code=502,
            detail="No se pudo reiniciar: " + (err.strip()[:200] or "error desconocido"),
        )
    return {"message": "Reinicio enviado. El servidor vuelve en unos segundos."}


@router.post("/{server_id}/update")
def start_update(server_id: str):
    server = _server_or_404(server_id)

    try:
        state = _apt_state(server)
    except HTTPException:
        raise
    except Exception as e:
        _fail("update-status", e)

    if state == "RUNNING":
        raise HTTPException(status_code=409, detail="Ya hay una actualización en curso")

    encoded = base64.b64encode(APT_SCRIPT.encode("utf-8")).decode("ascii")
    launch = (
        "rm -f /tmp/dockpilot-apt.exit /tmp/dockpilot-apt.pid; "
        f"echo {encoded} | base64 -d > /tmp/dockpilot-apt.sh; "
        "chmod +x /tmp/dockpilot-apt.sh; "
        "nohup /tmp/dockpilot-apt.sh > /tmp/dockpilot-apt.log 2>&1 & "
        "echo $! > /tmp/dockpilot-apt.pid"
    )

    try:
        _run_priv(server, launch, timeout=20)
    except HTTPException:
        raise
    except Exception as e:
        _fail("update", e)

    return {"message": "Actualización iniciada", "status": "running"}


@router.get("/{server_id}/update")
def update_status(server_id: str):
    server = _server_or_404(server_id)

    try:
        state = _apt_state(server)
        output = _apt_log(server)
    except HTTPException:
        raise
    except Exception as e:
        _fail("update-status", e)

    if state == "RUNNING":
        return {"status": "running", "exit_code": None, "output": output}
    if state == "IDLE":
        return {"status": "idle", "exit_code": None, "output": output}

    try:
        exit_code = int(state.split(":", 1)[1])
    except (IndexError, ValueError):
        exit_code = None

    return {
        "status": "done" if exit_code == 0 else "failed",
        "exit_code": exit_code,
        "output": output,
    }
