from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from routers import ssh_servers

router = APIRouter()


class ServerInput(BaseModel):
    name: str
    host: str
    port: int = 22
    username: str
    password: str


@router.get("/")
def list_servers():
    return ssh_servers.list_servers()


@router.post("/")
def add_server(server: ServerInput):
    try:
        return ssh_servers.add_server(
            server.name.strip(),
            server.host.strip(),
            server.port,
            server.username.strip(),
            server.password,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.delete("/{server_id}")
def delete_server(server_id: str):
    if not ssh_servers.delete_server(server_id):
        raise HTTPException(status_code=404, detail="Servidor no encontrado")
    return {"message": "Servidor eliminado"}
