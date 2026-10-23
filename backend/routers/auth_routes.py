import re

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel

from auth import (
    COOKIE_NAME,
    check_login_rate,
    clear_login_failures,
    is_default_password,
    load_user,
    register_login_failure,
    require_auth,
    save_user,
    set_session_cookie,
    verify_password,
)

router = APIRouter()

USERNAME_RE = re.compile(r"^[A-Za-z0-9_.-]{3,32}$")
MIN_PASSWORD_LENGTH = 4


class LoginInput(BaseModel):
    username: str
    password: str


class CredentialsInput(BaseModel):
    current_password: str
    new_username: str | None = None
    new_password: str | None = None


def _client_ip(request: Request) -> str:
    return request.client.host if request.client else "unknown"


@router.post("/login")
def login(data: LoginInput, request: Request, response: Response):
    ip = _client_ip(request)
    check_login_rate(ip)

    user = load_user()
    if (
        user is None
        or data.username.strip() != user["username"]
        or not verify_password(data.password, user["password_hash"])
    ):
        register_login_failure(ip)
        raise HTTPException(status_code=401, detail="Usuario o contraseña incorrectos")

    clear_login_failures(ip)
    set_session_cookie(response, request, user["username"])
    return {
        "username": user["username"],
        "default_password": is_default_password(user),
    }


@router.post("/logout")
def logout(response: Response):
    response.delete_cookie(COOKIE_NAME, path="/")
    return {"message": "Sesión cerrada"}


@router.get("/me")
def me(username: str = Depends(require_auth)):
    user = load_user()
    return {
        "username": username,
        "default_password": is_default_password(user) if user else False,
    }


@router.post("/credentials")
def update_credentials(
    data: CredentialsInput,
    request: Request,
    response: Response,
    username: str = Depends(require_auth),
):
    user = load_user()
    if user is None or not verify_password(data.current_password, user["password_hash"]):
        raise HTTPException(status_code=400, detail="La contraseña actual no es correcta")

    new_username = (data.new_username or user["username"]).strip()
    if not USERNAME_RE.match(new_username):
        raise HTTPException(
            status_code=400,
            detail="El usuario debe tener entre 3 y 32 caracteres (letras, números, . _ -)",
        )

    new_password = data.new_password
    if new_password:
        if len(new_password) < MIN_PASSWORD_LENGTH:
            raise HTTPException(
                status_code=400,
                detail=f"La contraseña debe tener al menos {MIN_PASSWORD_LENGTH} caracteres",
            )
    else:
        # Sin contraseña nueva: se conserva la actual (ya verificada).
        new_password = data.current_password

    save_user(new_username, new_password)

    # Si cambió el usuario, el token anterior deja de valer: se reemite.
    set_session_cookie(response, request, new_username)
    return {
        "username": new_username,
        "default_password": is_default_password(load_user()),
    }
