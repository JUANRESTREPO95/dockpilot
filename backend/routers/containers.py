import logging
import os
import re

import docker
from fastapi import APIRouter, HTTPException, Query

router = APIRouter()
client = docker.from_env()
log = logging.getLogger("dockpilot.containers")

CONTAINER_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$")

# Contenedores internos que el panel nunca debe tocar
PROTECTED_NAMES = {"dockpilot"}


def get_host_ip():
    # Usar la variable de entorno HOST_IP seteada en el entrypoint
    return os.environ.get("HOST_IP", "127.0.0.1")


def _get_container(container_id: str):
    if not container_id or not CONTAINER_ID_RE.match(container_id):
        raise HTTPException(status_code=400, detail="ID de contenedor inválido")
    try:
        c = client.containers.get(container_id)
    except docker.errors.NotFound:
        raise HTTPException(status_code=404, detail="Contenedor no encontrado")
    if c.name in PROTECTED_NAMES:
        raise HTTPException(status_code=403, detail="Ese contenedor está protegido")
    return c


@router.get("/")
def list_containers():
    host_ip = get_host_ip()
    containers = client.containers.list(all=True)
    result = []
    for c in containers:
        ports = c.ports or {}
        published_ports = []
        for container_port, host_bindings in ports.items():
            if host_bindings:
                for binding in host_bindings:
                    if binding.get("HostIp") == "0.0.0.0" or binding.get("HostIp") == "::":
                        published_ports.append({
                            "container_port": container_port,
                            "host_port": binding.get("HostPort"),
                            "host_ip": host_ip
                        })
                    elif binding.get("HostIp") == "127.0.0.1":
                        published_ports.append({
                            "container_port": container_port,
                            "host_port": binding.get("HostPort"),
                            "host_ip": "localhost"
                        })

        result.append({
            "id": c.short_id,
            "name": c.name,
            "status": c.status,
            "image": c.image.tags[0] if c.image.tags else "none",
            "ports": published_ports
        })
    return result


@router.post("/{container_id}/start")
def start_container(container_id: str):
    c = _get_container(container_id)
    try:
        c.start()
    except Exception as e:
        log.warning("start %s: %s", container_id, e)
        raise HTTPException(status_code=400, detail="No se pudo iniciar el contenedor")
    return {"message": f"Contenedor {container_id} iniciado"}


@router.post("/{container_id}/stop")
def stop_container(container_id: str):
    c = _get_container(container_id)
    try:
        c.stop()
    except Exception as e:
        log.warning("stop %s: %s", container_id, e)
        raise HTTPException(status_code=400, detail="No se pudo detener el contenedor")
    return {"message": f"Contenedor {container_id} detenido"}


@router.post("/{container_id}/restart")
def restart_container(container_id: str):
    c = _get_container(container_id)
    try:
        c.restart()
    except Exception as e:
        log.warning("restart %s: %s", container_id, e)
        raise HTTPException(status_code=400, detail="No se pudo reiniciar el contenedor")
    return {"message": f"Contenedor {container_id} reiniciado"}


@router.get("/{container_id}/logs")
def get_logs(container_id: str):
    c = _get_container(container_id)
    try:
        logs = c.logs(tail=100).decode("utf-8", "replace")
    except Exception as e:
        log.warning("logs %s: %s", container_id, e)
        raise HTTPException(status_code=400, detail="No se pudieron leer los logs")
    return {"logs": logs}


@router.delete("/{container_id}/remove")
def remove_container(
    container_id: str,
    remove_image: bool = Query(False),
    remove_volumes: bool = Query(False),
):
    c = _get_container(container_id)

    image_id = c.image.id
    image_tags = list(c.image.tags)

    try:
        if c.status == "running":
            c.stop(timeout=10)
        c.remove(v=remove_volumes)
    except Exception as e:
        log.warning("remove %s: %s", container_id, e)
        raise HTTPException(status_code=400, detail="No se pudo eliminar el contenedor")

    warnings = []
    if remove_image:
        try:
            client.images.remove(image_id)  # sin force: si está en uso, falla
        except Exception as e:
            log.info("imagen %s no eliminada: %s", image_id, e)
            warnings.append("La imagen no se eliminó porque está en uso o es compartida")

    return {
        "message": f"Contenedor {container_id} eliminado",
        "image": image_tags,
        "image_removed": bool(remove_image and not warnings),
        "warnings": warnings,
    }
